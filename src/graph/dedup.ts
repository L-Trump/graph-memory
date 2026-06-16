/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * 向量余弦去重 — 发现并合并语义重复的节点
 *
 * P0 performance notes:
 *   - Only compare active vectors inside the same node type bucket.
 *   - Stop collecting duplicate pairs once cfg.dedupMaxPairsPerRun is reached.
 *   - Stop merging once cfg.dedupMaxMergesPerRun is reached.
 *
 * This keeps maintenance bounded for large production graphs while preserving the
 * existing same-type merge invariant. Pair caps are budget controls, not a
 * guarantee that the returned list is the global top-K most similar pairs.
 */

import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig, NodeType } from "../types.ts";
import {
  findById,
  mergeNodes,
  getAllVectors,
  getPendingDedupVectors,
  getDedupCandidateVectorsByType,
  markVectorsDedupChecked,
  countPendingDedupVectors,
  type VectorRow,
} from "../store/store.ts";

export interface DuplicatePair {
  nodeA: string;
  nodeB: string;
  nameA: string;
  nameB: string;
  similarity: number;
}

export interface DedupResult {
  /** 发现的重复对 */
  pairs: DuplicatePair[];
  /** 实际合并的数量 */
  merged: number;
  /** 本轮扫描的向量比较次数 */
  comparisons: number;
  /** 本轮标记为已检查的新增/变更向量数 */
  checkedVectors: number;
  /** 是否使用增量扫描；false 表示回退到全量扫描 */
  incremental: boolean;
  /** 本轮开始前待检查的新增/变更向量数 */
  pendingBefore: number;
  /** 标记 checked 后仍待检查的新增/变更向量数 */
  pendingAfter: number;
}

/**
 * 余弦相似度
 */
function cosineSim(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-9);
}

function bucketVectorsByType(vectors: VectorRow[]): Map<NodeType, VectorRow[]> {
  const buckets = new Map<NodeType, VectorRow[]>();
  for (const vector of vectors) {
    const existing = buckets.get(vector.type);
    if (existing) existing.push(vector);
    else buckets.set(vector.type, [vector]);
  }
  return buckets;
}

/**
 * 检测重复节点对
 *
 * 需要 embedding 才能工作，没有向量的节点会被跳过。
 * FTS5 名称完全匹配由 store.upsertNode 已处理，这里处理语义重复。
 */
type DetectResult = { pairs: DuplicatePair[]; comparisons: number; checkedNodeIds: string[]; incremental: boolean };

async function collectPair(db: DatabaseSyncInstance, pairs: DuplicatePair[], left: VectorRow, right: VectorRow, sim: number): Promise<void> {
  const nodeA = findById(db, left.nodeId);
  const nodeB = findById(db, right.nodeId);
  if (!nodeA || !nodeB) return;
  pairs.push({
    nodeA: nodeA.id,
    nodeB: nodeB.id,
    nameA: nodeA.name,
    nameB: nodeB.name,
    similarity: sim,
  });
}

async function detectDuplicateDetails(db: DatabaseSyncInstance, cfg: GmConfig): Promise<DetectResult> {
  const pendingLimit = cfg.dedupMaxPendingVectorsPerRun ?? 200;
  if (pendingLimit === 0) return detectDuplicateDetailsFull(db, cfg);

  const pending = getPendingDedupVectors(db, pendingLimit);
  if (pending.length === 0) return { pairs: [], comparisons: 0, checkedNodeIds: [], incremental: true };

  const threshold = cfg.dedupThreshold;
  const maxPairs = cfg.dedupMaxPairsPerRun ?? 1000;
  const pairs: DuplicatePair[] = [];
  const fullyCheckedIds: string[] = [];
  let comparisons = 0;
  const YIELD_EVERY = 1000;

  for (const [type, bucketPending] of bucketVectorsByType(pending)) {
    const pendingIds = bucketPending.map(row => row.nodeId);
    const candidates = getDedupCandidateVectorsByType(db, type, pendingIds);

    // Compare pending vectors against each other, then against already checked
    // same-type active vectors. Unchecked backlog is left for later passes, so
    // each maintenance run stays proportional to
    // changed vectors instead of all active vector pairs.
    for (let i = 0; i < bucketPending.length; i++) {
      for (let j = i + 1; j < bucketPending.length; j++) {
        const sim = cosineSim(bucketPending[i].embedding, bucketPending[j].embedding);
        if (sim >= threshold && (maxPairs === 0 || pairs.length < maxPairs)) {
          await collectPair(db, pairs, bucketPending[i], bucketPending[j], sim);
        }
        comparisons++;
        if (comparisons % YIELD_EVERY === 0) await new Promise(r => setImmediate(r));
      }
    }

    for (const left of bucketPending) {
      for (const right of candidates) {
        const sim = cosineSim(left.embedding, right.embedding);
        if (sim >= threshold && (maxPairs === 0 || pairs.length < maxPairs)) {
          await collectPair(db, pairs, left, right, sim);
        }
        comparisons++;
        if (comparisons % YIELD_EVERY === 0) await new Promise(r => setImmediate(r));
      }
      fullyCheckedIds.push(left.nodeId);
    }
  }

  return { pairs: pairs.sort((a, b) => b.similarity - a.similarity), comparisons, checkedNodeIds: fullyCheckedIds, incremental: true };
}

async function detectDuplicateDetailsFull(db: DatabaseSyncInstance, cfg: GmConfig): Promise<DetectResult> {
  const vectors = getAllVectors(db);
  if (vectors.length < 2) return { pairs: [], comparisons: 0, checkedNodeIds: [], incremental: false };

  const threshold = cfg.dedupThreshold;
  const maxPairs = cfg.dedupMaxPairsPerRun ?? 1000;
  const pairs: DuplicatePair[] = [];
  let comparisons = 0;
  const YIELD_EVERY = 1000;

  for (const bucket of bucketVectorsByType(vectors).values()) {
    if (bucket.length < 2) continue;

    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const sim = cosineSim(bucket[i].embedding, bucket[j].embedding);
        if (sim >= threshold && (maxPairs === 0 || pairs.length < maxPairs)) {
          await collectPair(db, pairs, bucket[i], bucket[j], sim);
        }
        comparisons++;
        if (comparisons % YIELD_EVERY === 0) await new Promise(r => setImmediate(r));
      }
    }
  }

  return { pairs: pairs.sort((a, b) => b.similarity - a.similarity), comparisons, checkedNodeIds: vectors.map(row => row.nodeId), incremental: false };
}

export async function detectDuplicates(db: DatabaseSyncInstance, cfg: GmConfig): Promise<DuplicatePair[]> {
  return (await detectDuplicateDetails(db, cfg)).pairs;
}

/**
 * 检测并自动合并重复节点
 *
 * 合并规则：
 *   - 同类型才合并（SKILL+SKILL，EVENT+EVENT）
 *   - 保留 validatedCount 更高的
 *   - validatedCount 相同时保留更新时间更近的
 */
export async function dedup(db: DatabaseSyncInstance, cfg: GmConfig): Promise<DedupResult> {
  const pendingBefore = countPendingDedupVectors(db);
  const detected = await detectDuplicateDetails(db, cfg);
  const pairs = detected.pairs;
  let merged = 0;
  const maxMerges = cfg.dedupMaxMergesPerRun ?? 200;

  // 已经被合并过的节点不再参与合并
  const consumed = new Set<string>();

  for (const pair of pairs) {
    if (maxMerges >= 0 && merged >= maxMerges) break;
    if (consumed.has(pair.nodeA) || consumed.has(pair.nodeB)) continue;

    const a = findById(db, pair.nodeA);
    const b = findById(db, pair.nodeB);
    if (!a || !b) continue;

    // 只合并同类型。detectDuplicates 已按 type 分桶，这里保留防御性检查。
    if (a.type !== b.type) continue;

    // 决定保留哪个
    let keepId: string, mergeId: string;
    if (a.validatedCount > b.validatedCount) {
      keepId = a.id; mergeId = b.id;
    } else if (b.validatedCount > a.validatedCount) {
      keepId = b.id; mergeId = a.id;
    } else {
      // 相同则保留更新的
      keepId = a.updatedAt >= b.updatedAt ? a.id : b.id;
      mergeId = keepId === a.id ? b.id : a.id;
    }

    mergeNodes(db, keepId, mergeId);
    consumed.add(mergeId);
    merged++;
  }

  markVectorsDedupChecked(db, detected.checkedNodeIds);
  const pendingAfter = countPendingDedupVectors(db);

  return {
    pairs,
    merged,
    comparisons: detected.comparisons,
    checkedVectors: detected.checkedNodeIds.length,
    incremental: detected.incremental,
    pendingBefore,
    pendingAfter,
  };
}
