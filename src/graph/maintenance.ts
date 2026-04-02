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
 *   3. 社区检测（重新划分知识域）
 *   4. 社区描述生成（LLM 为每个社区生成一句话摘要）
 *
 * 注意：个性化 PPR 不在这里跑，它在 recall 时实时计算。
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, invalidateGraphCache, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";

export interface MaintenanceResult {
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  communitySummaries: number;
  durationMs: number;
}

export async function runMaintenance(
  db: DatabaseSyncInstance, cfg: GmConfig, llm?: CompleteFn, embedFn?: EmbedFn,
): Promise<MaintenanceResult> {
  const start = Date.now();

  // 去重/新增节点后清除图结构缓存
  invalidateGraphCache();

  // 1. 去重
  const dedupResult = dedup(db, cfg);

  // 去重可能合并了节点，再清一次缓存
  if (dedupResult.merged > 0) invalidateGraphCache();

  // 2. 全局 PageRank（基线）
  const pagerankResult = computeGlobalPageRank(db, cfg);

  // 3. 社区检测
  const communityResult = detectCommunities(db);

  // 4. 社区描述生成（需要 LLM）
  // TODO: 当前只处理成员数≥3 的社区，避免大量单节点社区导致 LLM 调用爆炸
  // 后续优化方向：批量生成摘要（一次 LLM 调用处理多个社区）或增强边提取减少孤岛节点
  let communitySummaries = 0;
  const significantCommunities = new Map(
    Array.from(communityResult.communities.entries())
      .filter(([_, members]) => members.length >= 3)
  );
  if (llm && significantCommunities.size > 0) {
    try {
      communitySummaries = await summarizeCommunities(db, significantCommunities, llm, embedFn);
      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] maintenance: generated ${communitySummaries} community summaries (from ${significantCommunities.size} communities with ≥3 members)`);
      }
    } catch (err) {
      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] maintenance: community summarization failed: ${err}`);
      }
    }
  }

  return {
    dedup: dedupResult,
    pagerank: pagerankResult,
    community: communityResult,
    communitySummaries,
    durationMs: Date.now() - start,
  };
}
