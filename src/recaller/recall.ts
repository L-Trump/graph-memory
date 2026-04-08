/**
 * graph-memory — 跨对话召回
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 并行双路径召回（两条路径同时跑，合并去重）：
 *
 * 精确路径（向量/FTS5 → 社区扩展 → 图遍历 → 组合评分排序）：
 *   找到和当前查询语义相关的具体三元组
 *
 * 泛化路径（社区代表节点 → 图遍历 → 组合评分排序）：
 *   提供跨领域的全局概览，覆盖精确路径可能遗漏的知识域
 *
 * 合并策略：精确路径的结果优先（组合分数更高），
 *           泛化路径补充精确路径未覆盖的社区。
 *
 * 组合评分：semantic (α=0.6) + PPR (β=0.4) 归一化后加权求和
 *
 * 四级召回（Top K）：
 *   L1 (Top 15): 完整 content
 *   L2 (Top 15-30): description
 *   L3 (Top 30-45): name
 *   其余：filtered（不传递）
 *
 * 分级后 PPR 重排（最终注入顺序）
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmEdge } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk, communityRepresentatives,
  communityVectorSearch, nodesByCommunityIds,
  saveVector, getVectorHash,
} from "../store/store.ts";
import { getCommunityPeers } from "../graph/community.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";
import { combinedScore, type Scored } from "./score.ts";

// ─── 组合评分权重 ────────────────────────────────────────────
const SEMANTIC_WEIGHT = 0.5;   // α：语义相关性权重
const PPR_WEIGHT = 0.3;        // β：局部关联性权重（PPR）
const PAGERANK_WEIGHT = 0.2;   // γ：全局重要性权重（PageRank）

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
    // Escape regex special chars
    let escaped = kw.replace(/[.*+?^${}()|[\\]]/g, `$&`);
    // Fix: if escaped ends with \, append another \ so RegExp doesn't treat it as escape sequence
    if (escaped.endsWith("\\")) escaped += "\\";
    let re: RegExp;
    try {
      re = new RegExp(escaped, 'g');
    } catch {
      // Fallback: escape all non-alphanumeric chars
      escaped = kw.replace(/[^a-zA-Z0-9\\u4e00-\\u9fff]/g, `\\$&`);
      if (escaped.endsWith("\\")) escaped += "\\";
      re = new RegExp(escaped, 'g');
    }
    const tf = (nodeText.match(re) || []).length;
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
 * 混合语义评分：向量相似度 × (1 + keywordBoost × KEYWORD_WEIGHT)
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
    const boost = 1 + kwScore * KEYWORD_WEIGHT;
    return Math.min(1, vecSim * boost);
  };
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

  constructor(private db: DatabaseSyncInstance, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void {
    this.embed = fn;
    this.embedReady = true;
    // 处理竞态队列中积压的节点
    if (this.pendingEmbedNodes.length > 0) {
      const pending = this.pendingEmbedNodes.splice(0);
      const logger = (process.env.GM_DEBUG ? console : undefined);
      logger?.log(`[graph-memory] processing ${pending.length} pending embed nodes after embedFn ready`);
      for (const node of pending) {
        this._doSyncEmbed(node).catch((err) => {
          const logErr = (process.env.GM_DEBUG ? console.error : undefined);
          logErr?.(`[graph-memory] pending embed failed for node ${node.id}: ${err}`);
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
   * 召回入口：双路径 + 组合评分 + 四级分级 + PPR 重排
   */
  async recallV2(query: string): Promise<RecallResultV2> {
    const limit = this.cfg.recallMaxNodes;

    // ── 两条路径并行 ─────────────────────────────────────
    const precise = await this.recallPreciseV2(query, limit);
    // const generalized = await this.recallGeneralizedV2(query, limit);

    // ── 合并去重 ─────────────────────────────────────────
    // const merged = this.mergeResults(precise, generalized);
    const merged = precise;

    if (process.env.GM_DEBUG) {
      const communities = new Set(merged.nodes.map(n => n.communityId).filter(Boolean));
      console.log(`  [DEBUG] recallV2 merged: precise=${precise.nodes.length} → final=${merged.nodes.length} nodes, ${merged.edges.length} edges, ${communities.size} communities`);
    }

    return merged;
  }

  /**
   * 精确召回（V2）：向量/FTS5 找种子 → 组合评分 → 三级分级
   */
  private async recallPreciseV2(query: string, limit: number): Promise<RecallResultV2> {
    let seeds: GmNode[] = [];
    const semanticScores = new Map<string, number>(); // nodeId → 原始向量相似度
    let pagerankCandidateIds = new Set<string>(); // pagerank top k/5：仅作图扩展候选，不作 PPR 种子
    const k = this.cfg.recallMaxNodes;

    if (this.embed) {
      try {
        const vec = await this.embed(query);
        // 语义种子：top k/3
        const scored = vectorSearchWithScore(this.db, vec, Math.ceil(k / 3));
        seeds = scored.map(s => s.node);
        for (const s of scored) semanticScores.set(s.node.id, s.score);

        if (process.env.GM_DEBUG && scored.length > 0) {
          console.log(`  [DEBUG] preciseV2: bestScore=${scored[0].score.toFixed(3)}, semanticSeeds=${seeds.length}`);
        }

        // 全局 PageRank top k/5：仅作图扩展候选节点，不作为 PPR 种子
        const { topNodes } = await import("../store/store.ts");
        const pagerankCandidates = topNodes(this.db, Math.ceil(k / 5));
        pagerankCandidateIds = new Set(pagerankCandidates.map(n => n.id));

        if (process.env.GM_DEBUG && pagerankCandidates.length > 0) {
          console.log(`  [DEBUG] preciseV2: pagerankCandidates=${pagerankCandidates.length} (用于图扩展，不参与 PPR 种子)`);
        }

        // 向量结果不足时补 FTS5（limit/3 ≈ 15，与向量搜索种子数一致）
        if (seeds.length < 2) {
          const fts = searchNodes(this.db, query, Math.ceil(limit / 3));
          const seen2 = new Set(seeds.map(n => n.id));
          seeds.push(...fts.filter(n => !seen2.has(n.id)));
        }
      } catch {
        seeds = searchNodes(this.db, query, Math.ceil(limit / 3));
      }
    } else {
      seeds = searchNodes(this.db, query, Math.ceil(limit / 3));
    }

    if (!seeds.length) return { nodes: [], edges: [], pprScores: {}, tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);

    // 社区扩展（语义种子 + pagerank 候选节点都作为图扩展起点）
    const expandedIds = new Set<string>(seedIds);
    for (const seed of seeds) {
      const peers = getCommunityPeers(this.db, seed.id, 2);
      for (const peerId of peers) expandedIds.add(peerId);
    }
    for (const pid of pagerankCandidateIds) expandedIds.add(pid);

    // 图遍历拿三元组
    const { nodes, edges } = graphWalk(
      this.db,
      Array.from(expandedIds),
      this.cfg.recallMaxDepth,
    );

    if (!nodes.length) return { nodes: [], edges: [], pprScores: {}, tokenEstimate: 0 };

    const candidateIds = nodes.map(n => n.id);

    // PPR
    const { scores: pprScores } = personalizedPageRank(
      this.db, seedIds, candidateIds, this.cfg,
    );

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

    // 三级分级
    const tiered = this.assignTiers(scoredNodes);

    if (process.env.GM_DEBUG) {
      const byTier: Record<RecallTier, number> = { scope_hot: 0, hot: 0, L1: 0, L2: 0, L3: 0, filtered: 0, active: 0 };
      for (const n of tiered) byTier[n.tier]++;
      console.log(`  [DEBUG] preciseV2 tiers: L1=${byTier.L1} L2=${byTier.L2} L3=${byTier.L3} filtered=${byTier.filtered}`);
    }

    const pprScoresFinal: Record<string, number> = {};
    for (const n of tiered) pprScoresFinal[n.id] = n.pprScore;

    return {
      nodes: tiered,
      edges: edges.filter(e => new Set(tiered.map(n => n.id)).has(e.fromId) && new Set(tiered.map(n => n.id)).has(e.toId)),
      pprScores: pprScoresFinal,
      tokenEstimate: this.estimateTokens(tiered),
    };
  }

  /**
   * 泛化召回（V2）：社区向量搜索 → 组合评分 → 四级分级
   */
  private async recallGeneralizedV2(query: string, limit: number): Promise<RecallResultV2> {
    let seeds: GmNode[] = [];
    const semanticScores = new Map<string, number>();

    if (this.embed) {
      try {
        const vec = await this.embed(query);
        const scoredCommunities = communityVectorSearch(this.db, vec);

        if (scoredCommunities.length > 0) {
          const communityIds = scoredCommunities.map(c => c.id);
          seeds = nodesByCommunityIds(this.db, communityIds, 3);
          // 社区向量的分数暂存到 semanticScores（归一化后再用）
          for (const s of scoredCommunities) {
            // 社区粒度的分数均分给成员
            const memberCount = Math.min(3, seeds.filter(n => n.communityId === s.id).length);
          }

          if (process.env.GM_DEBUG) {
            console.log(`  [DEBUG] generalizedV2: community vector matched ${scoredCommunities.length} communities: ${scoredCommunities.map(c => `${c.id}(${c.score.toFixed(2)})`).join(", ")}`);
          }
        }
      } catch {
        // embedding 失败，fallback
      }
    }

    // fallback：按时间取社区代表节点
    if (!seeds.length) {
      seeds = communityRepresentatives(this.db, 2);
    }

    if (!seeds.length) return { nodes: [], edges: [], pprScores: {}, tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);
    const { nodes, edges } = graphWalk(this.db, seedIds, 1);
    if (!nodes.length) return { nodes: [], edges: [], pprScores: {}, tokenEstimate: 0 };

    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = personalizedPageRank(
      this.db, seedIds, candidateIds, this.cfg,
    );

    // 泛化路径：语义分数来自社区匹配 + 关键词混合
    const hybridSemantic = makeHybridSemanticFn(semanticScores, query);
    const scoredNodes = combinedScore(
      nodes,
      hybridSemantic,
      (n) => pprScores.get(n.id) ?? 0,
      (n) => n.pagerank ?? 0,
      SEMANTIC_WEIGHT,
      PAGERANK_WEIGHT,
    );

    const tiered = this.assignTiers(scoredNodes);

    if (process.env.GM_DEBUG) {
      const byTier: Record<RecallTier, number> = { scope_hot: 0, hot: 0, L1: 0, L2: 0, L3: 0, filtered: 0, active: 0 };
      for (const n of tiered) byTier[n.tier]++;
      console.log(`  [DEBUG] generalizedV2 tiers: L1=${byTier.L1} L2=${byTier.L2} L3=${byTier.L3} filtered=${byTier.filtered}`);
    }

    const pprScoresFinal: Record<string, number> = {};
    for (const n of tiered) pprScoresFinal[n.id] = n.pprScore;

    return {
      nodes: tiered,
      edges: edges.filter(e => new Set(tiered.map(n => n.id)).has(e.fromId) && new Set(tiered.map(n => n.id)).has(e.toId)),
      pprScores: pprScoresFinal,
      tokenEstimate: this.estimateTokens(tiered),
    };
  }

  /**
   * 三级分级：按组合评分排序后划档
   * k 默认 45：L1=top k/3 (0~15)，L2=k/3~2k/3 (15~30)，L3=2k/3~k (30~45)，filtered=k+ (45+)
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

  /**
   * 合并两条路径：精确优先，泛化补充
   */
  private mergeResults(precise: RecallResultV2, generalized: RecallResultV2): RecallResultV2 {
    const nodeMap = new Map<string, TieredNode>();
    const edgeMap = new Map<string, GmEdge>();
    const pprScores: Record<string, number> = {};

    // 精确路径全部入场
    for (const n of precise.nodes) nodeMap.set(n.id, n);
    for (const e of precise.edges) edgeMap.set(e.id, e);
    for (const [id, score] of Object.entries(precise.pprScores)) pprScores[id] = score;

    // 泛化路径去重后补充（保留更高 tier）
    for (const n of generalized.nodes) {
      const existing = nodeMap.get(n.id);
      if (!existing || n.tier !== "filtered") {
        // 保留更重要的 tier
        if (!existing || this.tierPriority(n.tier) >= this.tierPriority(existing.tier)) {
          nodeMap.set(n.id, n);
        }
      }
    }
    for (const e of generalized.edges) {
      if (!edgeMap.has(e.id)) edgeMap.set(e.id, e);
    }
    for (const [id, score] of Object.entries(generalized.pprScores)) {
      if (!(id in pprScores)) pprScores[id] = score;
    }

    const finalIds = new Set(nodeMap.keys());
    const filteredEdges = Array.from(edgeMap.values()).filter(
      e => finalIds.has(e.fromId) && finalIds.has(e.toId)
    );

    const nodes = Array.from(nodeMap.values());

    return {
      nodes,
      edges: filteredEdges,
      pprScores,
      tokenEstimate: this.estimateTokens(nodes),
    };
  }

  private tierPriority(tier: RecallTier): number {
    const p: Record<RecallTier, number> = { scope_hot: 6, hot: 5, active: 4, L1: 3, L2: 2, L3: 1, filtered: 0 };
    return p[tier];
  }

  private estimateTokens(nodes: TieredNode[]): number {
    return Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3);
  }

  /** 异步同步 embedding，不阻塞主流程 */
  async syncEmbed(node: GmNode, force = false): Promise<void> {
    if (!this.embed) {
      // embedFn 尚未初始化，加入积压队列等待
      this.pendingEmbedNodes.push(node);
      const logger = (process.env.GM_DEBUG ? console.log : undefined);
      logger?.call(console, `[graph-memory] syncEmbed: embed not ready, queued node ${node.id} (pending=${this.pendingEmbedNodes.length})`);
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
        const logger = (process.env.GM_DEBUG ? console.log : undefined);
        logger?.call(console, `[graph-memory] synced embedding for node ${node.id} (${vec.length} dims)`);
      }
    } catch (err) {
      const logErr = (process.env.GM_DEBUG ? console.error : undefined);
      logErr?.call(console, `[graph-memory] syncEmbed failed for node ${node.id}: ${err}`);
    }
  }
}
