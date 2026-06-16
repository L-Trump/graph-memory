/**
 * graph-memory — 图谱维护
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 调用时机：session_end（finalize 之后）
 *
 * 执行顺序：
 *   1. 去重（先合并再算分数，避免重复节点干扰排名）
 *   2. 全局 PageRank（基线分数写入 DB，供 topNodes 兜底用）
 *
 * 注意：个性化 PPR 不在这里跑，它在 recall 时实时计算。
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig } from "../types.ts";
import { computeGlobalPageRank, invalidateGraphCache, type GlobalPageRankResult } from "./pagerank.ts";
import { dedup, type DedupResult } from "./dedup.ts";
import { cleanupInactiveSessionHistory, type RetentionCleanupResult } from "../store/store.ts";

export interface MaintenanceResult {
  retention?: RetentionCleanupResult;
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  durationMs: number;
  dedupDurationMs: number;
  pagerankDurationMs: number;
}

export type MaintenanceOptions = {
  protectedSessionIds?: string[];
  now?: number;
};

export async function runMaintenance(
  db: DatabaseSyncInstance, cfg: GmConfig, opts: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const start = Date.now();
  const now = opts.now ?? Date.now();
  let retention: RetentionCleanupResult | undefined;

  // 0. Retention cleanup（仅清理超过保留期且非 protected 的 session 历史）
  if (cfg.retention?.enabled !== false && opts.protectedSessionIds && opts.protectedSessionIds.length > 0) {
    retention = cleanupInactiveSessionHistory(db, opts.protectedSessionIds, {
      retentionDays: cfg.retention?.retentionDays ?? 30,
      maxDeletePerRun: cfg.retention?.maxDeletePerRun ?? 20_000,
      now,
      vacuum: cfg.retention?.vacuum === true,
    });
  }

  // 去重/新增节点后清除图结构缓存
  invalidateGraphCache();

  // 1. 去重（chunked async，每 YIELD_EVERY 次比较后让出主线程）
  const dedupStart = Date.now();
  const dedupResult = await dedup(db, cfg);
  const dedupDurationMs = Date.now() - dedupStart;

  // 去重可能合并了节点，再清一次缓存
  if (dedupResult.merged > 0) invalidateGraphCache();

  // 2. 全局 PageRank（基线）
  const pagerankStart = Date.now();
  const pagerankResult = computeGlobalPageRank(db, cfg);
  const pagerankDurationMs = Date.now() - pagerankStart;

  return {
    retention,
    dedup: dedupResult,
    pagerank: pagerankResult,
    durationMs: Date.now() - start,
    dedupDurationMs,
    pagerankDurationMs,
  };
}
