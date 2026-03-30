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
import { combinedScore, type Scored } from "../score.ts";

// ─── 组合评分权重 ────────────────────────────────────────────
const SEMANTIC_WEIGHT = 0.5;   // α：语义相关性权重
const PPR_WEIGHT = 0.25;       // β：局部关联性权重（PPR）
const PAGERANK_WEIGHT = 0.25;  // γ：全局重要性权重（PageRank）

// ─── 召回分级阈值 ────────────────────────────────────────────
// k 默认 45，三层分级：L1=top k/3，L2=k/3~2k/3，L3=2k/3~k，filtered=k+
const DEFAULT_RECALL_K = 45;

export type RecallTier = "L1" | "L2" | "L3" | "filtered" | "active";

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

  constructor(private db: DatabaseSyncInstance, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

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
    const generalized = await this.recallGeneralizedV2(query, limit);

    // ── 合并去重 ─────────────────────────────────────────
    const merged = this.mergeResults(precise, generalized);

    if (process.env.GM_DEBUG) {
      const communities = new Set(merged.nodes.map(n => n.communityId).filter(Boolean));
      console.log(`  [DEBUG] recallV2 merged: precise=${precise.nodes.length}, generalized=${generalized.nodes.length} → final=${merged.nodes.length} nodes, ${merged.edges.length} edges, ${communities.size} communities`);
    }

    return merged;
  }

  /**
   * 精确召回（V2）：向量/FTS5 找种子 → 组合评分 → 三级分级
   */
  private async recallPreciseV2(query: string, limit: number): Promise<RecallResultV2> {
    let seeds: GmNode[] = [];
    const semanticScores = new Map<string, number>(); // nodeId → 原始向量相似度
    const k = DEFAULT_RECALL_K;

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

        // 全局 PageRank top k/5 也作为种子
        const { topNodes } = await import("../store/store.ts");
        const pagerankSeeds = topNodes(this.db, Math.ceil(k / 5));
        const seen = new Set(seeds.map(n => n.id));
        for (const ps of pagerankSeeds) {
          if (!seen.has(ps.id)) {
            seeds.push(ps);
            seen.add(ps.id);
          }
        }

        if (process.env.GM_DEBUG && pagerankSeeds.length > 0) {
          console.log(`  [DEBUG] preciseV2: pagerankSeeds=${pagerankSeeds.length}, totalSeeds=${seeds.length}`);
        }

        // 向量结果不足时补 FTS5
        if (seeds.length < 2) {
          const fts = searchNodes(this.db, query, limit);
          const seen2 = new Set(seeds.map(n => n.id));
          seeds.push(...fts.filter(n => !seen2.has(n.id)));
        }
      } catch {
        seeds = searchNodes(this.db, query, limit);
      }
    } else {
      seeds = searchNodes(this.db, query, limit);
    }

    if (!seeds.length) return { nodes: [], edges: [], pprScores: {}, tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);

    // 社区扩展
    const expandedIds = new Set<string>(seedIds);
    for (const seed of seeds) {
      const peers = getCommunityPeers(this.db, seed.id, 2);
      for (const peerId of peers) expandedIds.add(peerId);
    }

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

    // 组合评分：语义 + PPR + PageRank
    const scoredNodes = combinedScore(
      nodes,
      (n) => semanticScores.get(n.id) ?? 0,
      (n) => pprScores.get(n.id) ?? 0,
      (n) => n.pagerank ?? 0,
      SEMANTIC_WEIGHT,
      PAGERANK_WEIGHT,
    );

    // 三级分级
    const tiered = this.assignTiers(scoredNodes);

    if (process.env.GM_DEBUG) {
      const byTier: Record<RecallTier, number> = { L1: 0, L2: 0, L3: 0, filtered: 0, active: 0 };
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

    // 泛化路径：语义分数来自社区匹配，均匀分配
    const scoredNodes = combinedScore(
      nodes,
      (n) => semanticScores.get(n.id) ?? 0.1, // fallback 低语义分
      (n) => pprScores.get(n.id) ?? 0,
      (n) => n.pagerank ?? 0,
      SEMANTIC_WEIGHT,
      PAGERANK_WEIGHT,
    );

    const tiered = this.assignTiers(scoredNodes);

    if (process.env.GM_DEBUG) {
      const byTier: Record<RecallTier, number> = { L1: 0, L2: 0, L3: 0, filtered: 0, active: 0 };
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
    const k = DEFAULT_RECALL_K;
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
    const p: Record<RecallTier, number> = { L1: 3, L2: 2, L3: 1, filtered: 0, active: 4 };
    return p[tier];
  }

  private estimateTokens(nodes: TieredNode[]): number {
    return Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3);
  }

  /** 异步同步 embedding，不阻塞主流程 */
  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    const hash = createHash("md5").update(node.content).digest("hex");
    if (getVectorHash(this.db, node.id) === hash) return;
    try {
      const text = `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
      const vec = await this.embed(text);
      if (vec.length) saveVector(this.db, node.id, node.content, vec);
    } catch { /* 不影响主流程 */ }
  }
}
