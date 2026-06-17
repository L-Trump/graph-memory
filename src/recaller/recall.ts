/**
 * graph-memory — 跨对话召回
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 精确召回路径（当前唯一运行路径）：
 *
 *   向量/FTS5 搜索 → 语义种子节点
 *   → PageRank 候选补入图扩展锚点
 *   → 图遍历（N 跳）
 *   → Personalized PageRank 排序
 *   → 关键词混合语义评分
 *
 * 组合评分（min-max 归一化）：
 *   combined = semantic_weight × norm_semantic
 *           + ppr_weight × norm_ppr
 *           + pagerank_weight × norm_pagerank
 *
 * 关键词混合：semantic = vecSim × (0.6 + keywordScore × KEYWORD_WEIGHT)（上限 1.0）
 *
 * 分层召回（Top K = 15）：
 *   L1 (Top 0~5): 完整 content
 *   L2 (Top 5~10): 仅 description
 *   L3 (Top 10~15): 仅 name
 *   其余：filtered（不传递）
 *
 * 默认权重：α=0.5（语义） β=0.4（PPR） γ=0.1（PageRank） KEYWORD_WEIGHT=0.4
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmEdge } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk,
  saveVector, getVectorHash, findById, findByName,
} from "../store/store.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";
import { combinedScore, type Scored } from "./score.ts";
import {
  createDecayEngine,
  getTypeFloor,
  DEFAULT_DECAY_CONFIG,
} from "../engine/decay.ts";

// ─── 组合评分权重 ────────────────────────────────────────────
const SEMANTIC_WEIGHT = 0.5;   // α：语义相关性权重
const PPR_WEIGHT = 0.4;        // β：局部关联性权重（PPR）
const PAGERANK_WEIGHT = 0.1;   // γ：全局重要性权重（PageRank）

// ─── 关键词混合召回 ────────────────────────────────────────────
const KEYWORD_WEIGHT = 0.4;    // 关键词分数在语义组合中的权重上限（与向量相似度混合）

/** 停用词表（中英文常见词） */
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "with", "at",
  "by", "from", "as", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "must", "can",
  "this", "that", "these", "those", "i", "you", "he", "she",
  "it", "we", "they", "what", "which", "who", "whom", "how",
  "when", "where", "why", "not", "no", "yes", "and", "or",
  "but", "if", "then", "so", "because", "although", "while",
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人",
  "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去",
  "你", "会", "着", "没有", "看", "好", "自己", "这", "那",
  "什么", "怎么", "如何", "为什么", "吗", "呢", "吧", "啊",
]);

/**
 * 从查询字符串提取有意义的关键词 token（去除停用词、标点）
 */
function extractKeywords(query: string): Set<string> {
  const tokens = query
    .toLowerCase()
    .split(/[\s\-_.,;:'"()（）【】《》[\]{}!?~`#$%^&*+=|\/<>]+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
  return new Set(tokens);
}

/**
 * 计算查询关键词在节点文本（name + description + content 前200字）中的覆盖得分
 * 使用 TF-IDF 近似：log(1 + term_freq) * idf
 * 返回 0~1 的归一化分数
 */
function computeKeywordScore(query: string, node: GmNode): number {
  const keywords = extractKeywords(query);
  if (keywords.size === 0) return 0;

  const nodeText = `${node.name} ${node.description} ${node.content.slice(0, 200)}`.toLowerCase();

  let weightedSum = 0;
  let maxPossible = 0;
  for (const kw of keywords) {
    // Safely escape all regex special chars — split+map avoids trailing-backslash issue
    const META_CHARS = new Set([...'.+*?^${}()|[\]\\']);
    const escaped = [...kw].map(ch => META_CHARS.has(ch) ? '\\' + ch : ch).join('');
    const tf = (nodeText.match(new RegExp(escaped, 'g')) || []).length;
    if (tf === 0) continue;
    // log-weighted TF
    const score = Math.log(1 + tf);
    weightedSum += score;
    maxPossible += Math.log(1 + nodeText.split(kw).length - 1);
  }

  if (maxPossible === 0) return 0;
  return Math.min(1, weightedSum / maxPossible);
}

/**
 * 混合语义评分：vecSim × (1 - KEYWORD_WEIGHT + keywordBoost × KEYWORD_WEIGHT)（上限 1.0）
 */
function makeHybridSemanticFn(
  semanticScores: Map<string, number>,
  query: string,
): (n: GmNode) => number {
  const kwScores = new Map<string, number>();
  return (n: GmNode) => {
    const vecSim = semanticScores.get(n.id) ?? 0;
    if (vecSim === 0) return 0;
    let kwScore = kwScores.get(n.id);
    if (kwScore === undefined) {
      kwScore = computeKeywordScore(query, n);
      kwScores.set(n.id, kwScore);
    }
    return Math.min(1, vecSim * (1 - KEYWORD_WEIGHT + kwScore * KEYWORD_WEIGHT));
  };
}

/**
 * Lightweight keyword overlap for PageRank expansion gating.
 * This intentionally differs from computeKeywordScore: for gating we only need
 * to know whether a global hub shares concrete query terms before allowing it
 * to become a graphWalk anchor.
 */
function computeKeywordOverlap(query: string, node: GmNode): number {
  const keywords = extractKeywords(query);
  if (keywords.size === 0) return 0;

  const nodeText = `${node.name} ${node.description} ${node.content.slice(0, 500)}`.toLowerCase();
  let matched = 0;
  for (const kw of keywords) {
    if (nodeText.includes(kw)) matched++;
  }
  return matched / keywords.size;
}

function cosineSimilarity(queryVec: Float32Array, queryNorm: number, nodeVec: Float32Array): number {
  if (queryNorm === 0) return 0;
  let dot = 0, nodeNorm = 0;
  const len = Math.min(nodeVec.length, queryVec.length);
  for (let i = 0; i < len; i++) {
    dot += nodeVec[i] * queryVec[i];
    nodeNorm += nodeVec[i] * nodeVec[i];
  }
  return dot / (Math.sqrt(nodeNorm) * queryNorm + 1e-9);
}

export type RecallTier = "L1" | "L2" | "L3" | "filtered" | "active" | "hot" | "scope_hot";

export interface TieredNode extends GmNode {
  tier: RecallTier;
  semanticScore: number;
  pprScore: number;
  pagerankScore: number;
  combinedScore: number;
}

export interface RecallResultV2 {
  nodes: TieredNode[];
  edges: GmEdge[];
  pprScores: Record<string, number>;
  tokenEstimate: number;
}

export class Recaller {
  private embed: EmbedFn | null = null;
  private embedReady = false;
  // 竞态队列：embedFn 未就绪时积压的节点，setEmbedFn 时一次性处理
  private pendingEmbedNodes: GmNode[] = [];
  // Decay engine for access-based scoring
  private decayEngine;

  constructor(private db: DatabaseSyncInstance, private cfg: GmConfig) {
    this.decayEngine = createDecayEngine(cfg.decay);
  }

  private isRecallTimingDebugEnabled(): boolean {
    return Boolean(
      process.env.GM_DEBUG ||
      process.env.GM_DEBUG_RECALL_TIMING === "1" ||
      process.env.GM_DEBUG_RUNTIME_HOOKS === "1" ||
      process.env.GM_DEBUG_CONTEXT_PREVIEW === "1" ||
      this.cfg.debugContextPreview,
    );
  }

  private createRecallTimingLogger(label: string, query: string): (step: string, extra?: string) => void {
    const enabled = this.isRecallTimingDebugEnabled();
    const startedAt = Date.now();
    let lastMarkAt = startedAt;
    return (step: string, extra = "") => {
      if (!enabled) return;
      const now = Date.now();
      const safeExtra = extra ? ` ${extra.replace(/\s+/g, " ").slice(0, 500)}` : "";
      console.log(
        `[graph-memory] recall timing ${label} step=${step} delta=${now - lastMarkAt}ms total=${now - startedAt}ms queryChars=${query.length}${safeExtra}`,
      );
      lastMarkAt = now;
    };
  }

  setEmbedFn(fn: EmbedFn): void {
    this.embed = fn;
    this.embedReady = true;
    // 处理竞态队列中积压的节点
    if (this.pendingEmbedNodes.length > 0) {
      const pending = this.pendingEmbedNodes.splice(0);
      if (this.isRecallTimingDebugEnabled()) console.log(`[graph-memory] processing ${pending.length} pending embed nodes after embedFn ready`);
      for (const node of pending) {
        this._doSyncEmbed(node).catch((err) => {
          console.error(`[graph-memory] pending embed failed for node ${node.id}: ${err}`);
        });
      }
    }
  }

  isEmbedReady(): boolean {
    return this.embedReady;
  }

  async recall(query: string): Promise<RecallResult> {
    const result = await this.recallV2(query);
    // 兼容旧接口，返回 GmNode（无 tier 信息）
    return {
      nodes: result.nodes,
      edges: result.edges,
      pprScores: result.pprScores,
      tokenEstimate: result.tokenEstimate,
    };
  }

  /**
   * 召回入口：当前只运行 precise-only 路径，然后应用组合评分、PPR、分层和衰减。
   */
  async recallV2(query: string): Promise<RecallResultV2> {
    const timing = this.createRecallTimingLogger("recallV2", query);
    const limit = this.cfg.recallMaxNodes;
    timing("start", `limit=${limit} embedReady=${this.embedReady}`);

    const precise = await this.recallPreciseV2(query, limit);
    timing("precise-complete", `nodes=${precise.nodes.length} edges=${precise.edges.length} tokens=${precise.tokenEstimate}`);
    const merged = precise;

    if (process.env.GM_DEBUG) {
      console.log(`  [DEBUG] recallV2 merged: precise=${precise.nodes.length} → final=${merged.nodes.length} nodes, ${merged.edges.length} edges`);
    }
    timing("return", `nodes=${merged.nodes.length} edges=${merged.edges.length}`);

    return merged;
  }

  /**
   * 精确召回（V2）：向量/FTS5 找种子 → 组合评分 → 三级分级
   */
  private async recallPreciseV2(query: string, limit: number): Promise<RecallResultV2> {
    const timing = this.createRecallTimingLogger("preciseV2", query);
    let seeds: GmNode[] = [];
    const semanticScores = new Map<string, number>(); // nodeId → 原始向量相似度
    let pagerankCandidateIds = new Set<string>(); // pagerank top k/5：仅作图扩展候选，不作 PPR 种子
    const k = this.cfg.recallMaxNodes;
    timing("start", `limit=${limit} k=${k} embed=${this.embed ? "yes" : "no"}`);

    if (this.embed) {
      try {
        const vec = await this.embed(query);
        timing("embed-query", `dims=${vec.length}`);
        // 语义种子：top k/3
        const scored = vectorSearchWithScore(this.db, vec, Math.ceil(k / 3));
        timing("vector-search", `top=${Math.ceil(k / 3)} results=${scored.length} best=${scored[0]?.score?.toFixed?.(3) ?? "-"}`);
        seeds = scored.map(s => s.node);
        for (const s of scored) semanticScores.set(s.node.id, s.score);

        if (process.env.GM_DEBUG && scored.length > 0) {
          console.log(`  [DEBUG] preciseV2: bestScore=${scored[0].score.toFixed(3)}, semanticSeeds=${seeds.length}`);
        }

        // 全局 PageRank 候选：仅作图扩展候选节点，不作为 PPR 种子。
        // 先取更大的高 PR 池，再用 query relevance gate 过滤，避免无关 hub 污染 graphWalk。
        const { topNodes } = await import("../store/store.ts");
        timing("load-topnodes-module");
        const rawPagerankCandidates = topNodes(this.db, Math.max(20, k));
        timing("pagerank-topnodes", `raw=${rawPagerankCandidates.length}`);
        const pagerankCandidateLimit = Math.ceil(k / 5);
        const pagerankSemanticThreshold = 0.2;
        const pagerankKeywordThreshold = 0.25;
        const queryVec = new Float32Array(vec);
        const queryNorm = Math.sqrt(queryVec.reduce((s, x) => s + x * x, 0));
        const candidateVectorScores = new Map<string, number>();

        if (rawPagerankCandidates.length > 0 && queryNorm > 0) {
          const placeholders = rawPagerankCandidates.map(() => "?").join(",");
          const vectorRows = this.db.prepare(
            `SELECT node_id, embedding FROM gm_vectors WHERE node_id IN (${placeholders})`
          ).all(...rawPagerankCandidates.map(n => n.id)) as any[];
          timing("pagerank-candidate-vector-load", `rows=${vectorRows.length}`);
          for (const row of vectorRows) {
            const raw = row.embedding as Uint8Array;
            const nodeVec = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
            candidateVectorScores.set(row.node_id, cosineSimilarity(queryVec, queryNorm, nodeVec));
          }
        }

        const pagerankCandidates = rawPagerankCandidates
          .filter(n => {
            if (seeds.some(s => s.id === n.id)) return false;
            const semanticScore = candidateVectorScores.get(n.id) ?? 0;
            const keywordOverlap = computeKeywordOverlap(query, n);
            return semanticScore >= pagerankSemanticThreshold || keywordOverlap >= pagerankKeywordThreshold;
          })
          .slice(0, pagerankCandidateLimit);

        timing("pagerank-candidate-gate", `kept=${pagerankCandidates.length}/${rawPagerankCandidates.length}`);
        pagerankCandidateIds = new Set(pagerankCandidates.map(n => n.id));
        for (const n of pagerankCandidates) {
          const semanticScore = candidateVectorScores.get(n.id);
          if (semanticScore !== undefined) semanticScores.set(n.id, semanticScore);
        }

        if (process.env.GM_DEBUG && rawPagerankCandidates.length > 0) {
          console.log(`  [DEBUG] preciseV2: pagerankCandidates=${pagerankCandidates.length}/${rawPagerankCandidates.length} gated (用于图扩展，不参与 PPR 种子)`);
        }

        // 向量结果不足时补 FTS5（limit/3 ≈ 15，与向量搜索种子数一致）
        if (seeds.length < 2) {
          const fts = searchNodes(this.db, query, Math.ceil(limit / 3));
          timing("fts-fallback", `results=${fts.length} reason=low-vector-seeds`);
          const seen2 = new Set(seeds.map(n => n.id));
          seeds.push(...fts.filter(n => !seen2.has(n.id)));
        }
      } catch (err) {
        timing("embed-path-failed", `error=${String(err).replace(/\s+/g, " ").slice(0, 160)}`);
        seeds = searchNodes(this.db, query, Math.ceil(limit / 3));
        timing("fts-fallback", `results=${seeds.length} reason=embed-path-error`);
      }
    } else {
      seeds = searchNodes(this.db, query, Math.ceil(limit / 3));
      timing("fts-search", `results=${seeds.length} reason=no-embed`);
    }

    timing("seed-selection", `seeds=${seeds.length} pagerankAnchors=${pagerankCandidateIds.size} semanticScores=${semanticScores.size}`);
    if (!seeds.length) {
      timing("return-no-seeds");
      return { nodes: [], edges: [], pprScores: {}, tokenEstimate: 0 };
    }

    const seedIds = seeds.map(n => n.id);

    // 图遍历起点（语义种子 + pagerank 候选节点）
    const expandedIds = new Set<string>(seedIds);
    for (const pid of pagerankCandidateIds) expandedIds.add(pid);

    // 图遍历拿三元组
    const { nodes, edges } = graphWalk(
      this.db,
      Array.from(expandedIds),
      this.cfg.recallMaxDepth,
    );
    timing("graph-walk", `anchors=${expandedIds.size} depth=${this.cfg.recallMaxDepth} nodes=${nodes.length} edges=${edges.length}`);

    if (!nodes.length) {
      timing("return-no-graph-nodes");
      return { nodes: [], edges: [], pprScores: {}, tokenEstimate: 0 };
    }

    const candidateIds = nodes.map(n => n.id);

    // PPR
    const { scores: pprScores } = personalizedPageRank(
      this.db, seedIds, candidateIds, this.cfg,
    );
    timing("personalized-pagerank", `seeds=${seedIds.length} candidates=${candidateIds.length} scores=${pprScores.size}`);

    // 组合评分：语义（向量×关键词混合）+ PPR + PageRank
    const hybridSemantic = makeHybridSemanticFn(semanticScores, query);
    const scoredNodes = combinedScore(
      nodes,
      hybridSemantic,
      (n) => pprScores.get(n.id) ?? 0,
      (n) => n.pagerank ?? 0,
      SEMANTIC_WEIGHT,
      PAGERANK_WEIGHT,
    );
    timing("combined-score", `scored=${scoredNodes.length}`);

    // 三级分级
    let tiered = this.assignTiers(scoredNodes);
    timing("assign-tiers", `tiered=${tiered.length}`);

    // 应用衰减评分（access-based decay，调整 combined score）
    if (this.cfg.decayEnabled !== false) {
      tiered = this.applyDecayScoring(tiered);
      timing("decay-scoring", `tiered=${tiered.length}`);
    } else {
      timing("decay-skipped");
    }

    if (process.env.GM_DEBUG) {
      const byTier: Record<RecallTier, number> = { scope_hot: 0, hot: 0, L1: 0, L2: 0, L3: 0, filtered: 0, active: 0 };
      for (const n of tiered) byTier[n.tier]++;
      console.log(`  [DEBUG] preciseV2 tiers: L1=${byTier.L1} L2=${byTier.L2} L3=${byTier.L3} filtered=${byTier.filtered}`);
    }

    const pprScoresFinal: Record<string, number> = {};
    for (const n of tiered) pprScoresFinal[n.id] = n.pprScore;
    const tieredIdSet = new Set(tiered.map(n => n.id));
    const finalEdges = edges.filter(e => tieredIdSet.has(e.fromId) && tieredIdSet.has(e.toId));
    const tokenEstimate = this.estimateTokens(tiered);
    timing("finalize", `nodes=${tiered.length} edges=${finalEdges.length} tokens=${tokenEstimate}`);

    return {
      nodes: tiered,
      edges: finalEdges,
      pprScores: pprScoresFinal,
      tokenEstimate,
    };
  }

  /**
   * 三级分级：按组合评分排序后划档
   * k 默认 15：L1=top k/3 (0~5)，L2=k/3~2k/3 (5~10)，L3=2k/3~k (10~15)，filtered=k+ (15+)
   */
  private assignTiers(scored: Scored<GmNode>[]): TieredNode[] {
    const k = this.cfg.recallMaxNodes;
    const t1 = Math.ceil(k / 3);    // 15
    const t2 = Math.ceil(2 * k / 3); // 30

    const sorted = scored
      .sort((a, b) => b.combined - a.combined);

    return sorted.map((s, i) => {
      let tier: RecallTier;
      if (i < t1) tier = "L1";
      else if (i < t2) tier = "L2";
      else if (i < k) tier = "L3";
      else tier = "filtered";

      return {
        ...s.item,
        tier,
        semanticScore: s.semantic,
        pprScore: s.ppr,
        pagerankScore: s.pagerank,
        combinedScore: s.combined,
      };
    });
  }

  private estimateTokens(nodes: TieredNode[]): number {
    return Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3);
  }

  /** 异步同步 embedding，不阻塞主流程 */
  async syncEmbed(node: GmNode, force = false): Promise<void> {
    if (!this.embed) {
      // embedFn 尚未初始化，加入积压队列等待
      this.pendingEmbedNodes.push(node);
      if (this.isRecallTimingDebugEnabled()) console.log(`[graph-memory] syncEmbed: embed not ready, queued node ${node.id} (pending=${this.pendingEmbedNodes.length})`);
      return;
    }
    return this._doSyncEmbed(node, force);
  }

  /** 实际执行 embedding 写入 */
  private async _doSyncEmbed(node: GmNode, force = false): Promise<void> {
    if (!force) {
      const hash = createHash("md5").update(node.content).digest("hex");
      if (getVectorHash(this.db, node.id) === hash) return;
    }
    try {
      const text = `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
      const vec = await this.embed!(text);
      if (vec.length) {
        saveVector(this.db, node.id, node.content, vec);
        if (this.isRecallTimingDebugEnabled()) console.log(`[graph-memory] synced embedding for node ${node.id} (${vec.length} dims)`);
      }
    } catch (err) {
      console.error(`[graph-memory] syncEmbed failed for node ${node.id}: ${err}`);
    }
  }

  /**
   * Apply decay scoring to tiered nodes.
   *
   * Decay composite = recencyWeight*recency + frequencyWeight*frequency + intrinsicWeight*intrinsic
   *
   * The decay composite is floored per node type using decay.ts DEFAULT_DECAY_CONFIG
   * plus optional cfg.decay overrides, then used to adjust the combined score:
   *   adjustedScore = combinedScore * (baseWeight + (1-baseWeight) * max(floor, composite))
   *
   * where baseWeight = 0.3. This means:
   * - Fresh/active nodes with high decayComposite (near 1.0) keep their full combined score
   * - Old STATUS/EVENT/TASK/SESSION nodes can decay aggressively due to low floor
   * - SKILL/TOPIC/KNOWLEDGE nodes retain moderate protection without bypassing decay
   *
   * After adjusting, nodes are re-sorted and re-tiered.
   */
  private applyDecayScoring(tiered: TieredNode[]): TieredNode[] {
    if (tiered.length === 0) return tiered;

    // Batch lookup: get access data for all candidate nodes
    const nodeIds = tiered.map(n => n.id);
    const accessRows = this.db.prepare(
      "SELECT id, access_count, last_accessed_at, belief FROM gm_nodes WHERE id IN (" +
      nodeIds.map(() => "?").join(",") + ")"
    ).all(...nodeIds) as any[];

    const accessMap = new Map<string, { accessCount: number; lastAccessedAt: number; belief: number }>();
    for (const row of accessRows) {
      accessMap.set(row.id, {
        accessCount: row.access_count ?? 0,
        lastAccessedAt: row.last_accessed_at ?? 0,
        belief: row.belief ?? 0.5,
      });
    }

    const now = Date.now();
    const DECAY_BASE = 0.3; // minimum multiplier when decayComposite is 0

    // Apply decay adjustment to each node's combined score
    const adjusted = tiered.map(node => {
      const access = accessMap.get(node.id);
      const decayable = {
        id: node.id,
        type: node.type,
        importance: 0.5, // will be set by decay engine from type
        belief: access?.belief ?? node.belief ?? 0.5,
        accessCount: access?.accessCount ?? 0,
        createdAt: node.createdAt,
        lastAccessedAt: access?.lastAccessedAt ?? 0,
      };

      const ds = this.decayEngine.score(decayable, now);
      // Floor the composite so it can't drop below the type-specific floor
      const flooredComposite = Math.max(getTypeFloor(node.type, { ...DEFAULT_DECAY_CONFIG, ...this.cfg.decay }), ds.composite);
      const decayFactor = DECAY_BASE + (1 - DECAY_BASE) * flooredComposite;
      const adjustedScore = node.combinedScore * decayFactor;

      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] decay: ${node.name} type=${node.type} ac=${decayable.accessCount} composite=${ds.composite.toFixed(3)} factor=${decayFactor.toFixed(3)} combined=${node.combinedScore.toFixed(3)} → ${adjustedScore.toFixed(3)}`);
      }

      return {
        ...node,
        combinedScore: adjustedScore,
        decayComposite: ds.composite,
      };
    });

    // Re-sort by adjusted combined score and re-assign tiers
    const k = this.cfg.recallMaxNodes;
    const t1 = Math.ceil(k / 3);
    const t2 = Math.ceil(2 * k / 3);

    return adjusted
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .map((n, i) => {
        let tier: RecallTier;
        if (i < t1) tier = "L1";
        else if (i < t2) tier = "L2";
        else if (i < k) tier = "L3";
        else tier = "filtered";
        return { ...n, tier };
      });
  }

  /**
   * gm_explore: 从指定节点出发，召回其子图。
   *
   * 与 recallV2 的区别：
   * - 不做向量搜索（锚点已知）
   * - 以指定节点为唯一语义锚点，通过向量相似度找到其语义邻居
   * - 从种子节点执行 graphWalk → PPR + 组合评分 → tiered 结果
   * - 返回 { roots, nodes, edges }（子图结构）
   */
  async exploreSubgraph(
    seedName: string,
    maxNodes?: number,
  ): Promise<{
    roots: GmNode[];
    nodes: TieredNode[];
    edges: GmEdge[];
    pprScores: Record<string, number>;
  }> {
    const limit = maxNodes ?? this.cfg.recallMaxNodes;

    // ── 1. 找到种子节点 ──────────────────────────────────────
    // gm_explore 的公开参数是 nodeName；保留 findById fallback 兼容旧的
    // gm_dream/测试调用方传 node id 的用法。
    const seedNode = findByName(this.db, seedName) ?? findById(this.db, seedName);
    if (!seedNode) {
      return { roots: [], nodes: [], edges: [], pprScores: {} };
    }

    const seedIds = [seedNode.id];
    const semanticScores = new Map<string, number>();

    // ── 2. 语义锚点：用种子节点的内容做向量搜索，找语义邻居 ─────────
    if (this.embed) {
      try {
        const text = `${seedNode.name}: ${seedNode.description}\n${seedNode.content.slice(0, 500)}`;
        const vec = await this.embed(text);
        const k = Math.ceil(limit / 3);
        const scored = vectorSearchWithScore(this.db, vec, k);
        for (const s of scored) {
          // 排除种子节点自身（分数可以保留，但不应该重复出现在结果中）
          if (s.node.id !== seedNode.id) {
            semanticScores.set(s.node.id, s.score);
          }
        }
        if (process.env.GM_DEBUG && scored.length > 0) {
          console.log(`  [DEBUG] exploreSubgraph: seedNeighbors=${scored.length}, bestScore=${scored[0].score.toFixed(3)}`);
        }
      } catch (err) {
        if (process.env.GM_DEBUG) {
          console.log(`  [DEBUG] exploreSubgraph: embed failed: ${err}`);
        }
      }
    }

    // ── 3. 图遍历 ────────────────────────────────────────────
    const { nodes, edges } = graphWalk(
      this.db,
      seedIds,
      this.cfg.recallMaxDepth,
    );

    if (!nodes.length) {
      return { roots: [seedNode], nodes: [], edges: [], pprScores: {} };
    }

    // ── 4. PPR ───────────────────────────────────────────────
    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = personalizedPageRank(
      this.db, seedIds, candidateIds, this.cfg,
    );

    // ── 5. 组合评分（语义 + PPR + PageRank）────────────────────────
    // 语义锚点（向量搜索邻居）权重为 1.0，无向量的节点语义分为 0
    const hybridSemantic = (n: GmNode): number => {
      return semanticScores.get(n.id) ?? 0;
    };
    const scoredNodes = combinedScore(
      nodes,
      hybridSemantic,
      (n) => pprScores.get(n.id) ?? 0,
      (n) => n.pagerank ?? 0,
      SEMANTIC_WEIGHT,
      PAGERANK_WEIGHT,
    );

    // ── 6. 三级分级 ───────────────────────────────────────────
    let tiered = this.assignTiers(scoredNodes);

    // ── 7. 应用衰减评分 ──────────────────────────────────────
    if (this.cfg.decayEnabled !== false) {
      tiered = this.applyDecayScoring(tiered);
    }

    // ── 8. 确保种子节点在结果中 ───────────────────────────────
    const nodeMap = new Map(tiered.map(n => [n.id, n]));
    if (!nodeMap.has(seedNode.id)) {
      // 种子节点不在 graphWalk 结果里（孤立节点），手动加入并标记为 L1
      const seedTiered: TieredNode = {
        ...seedNode,
        tier: "L1",
        semanticScore: 1.0,
        pprScore: 1.0,
        pagerankScore: seedNode.pagerank ?? 0,
        combinedScore: 1.0,
      };
      nodeMap.set(seedNode.id, seedTiered);
      tiered = [seedTiered, ...tiered];
    }

    const finalNodes = Array.from(nodeMap.values());
    const finalIds = new Set(finalNodes.map(n => n.id));
    const finalEdges = edges.filter(
      e => finalIds.has(e.fromId) && finalIds.has(e.toId),
    );

    const pprScoresFinal: Record<string, number> = {};
    for (const n of finalNodes) pprScoresFinal[n.id] = n.pprScore;

    return {
      roots: [seedNode],
      nodes: finalNodes,
      edges: finalEdges,
      pprScores: pprScoresFinal,
    };
  }
}
