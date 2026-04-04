/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * graph-memory 类型定义
 *
 * 节点：TASK / SKILL / EVENT / KNOWLEDGE / STATUS
 * 边：USED_SKILL / SOLVED_BY / REQUIRES / PATCHES / CONFLICTS_WITH
 */

// ─── 节点 ─────────────────────────────────────────────────────

export type NodeType = "TASK" | "SKILL" | "EVENT" | "KNOWLEDGE" | "STATUS" | "TOPIC";
export type NodeStatus = "active" | "deprecated";

export interface GmNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  validatedCount: number;
  sourceSessions: string[];
  communityId: string | null;
  pagerank: number;
  flags: string[];
  createdAt: number;
  updatedAt: number;
  /** Belief/confidence score [0, 1]: 0=fully discredited, 1=fully validated. Default 0.5. */
  belief?: number;
  /** Number of successful uses/confirmations */
  successCount?: number;
  /** Number of failed uses/corrections */
  failureCount?: number;
  /** Timestamp of last belief signal */
  lastSignalAt?: number;
}

// ─── 边（两层：name自由命名 + description一句话描述）───────────

export interface GmEdge {
  id: string;
  fromId: string;
  toId: string;
  /** 边类型名称，由LLM自由生成短字符串（如"使用"、"依赖"、"扩展"） */
  name: string;
  /** 一句话描述这段关系 */
  description: string;
  sessionId: string;
  createdAt: number;
}

/** 向后兼容别名（内部过渡用） */
export type EdgeType = string;

// ─── 信号 ─────────────────────────────────────────────────────

export type SignalType =
  | "tool_error"
  | "tool_success"
  | "skill_invoked"
  | "user_correction"
  | "explicit_record"
  | "task_completed";

export interface Signal {
  type: SignalType;
  turnIndex: number;
  data: Record<string, any>;
}

// ─── 提取结果 ─────────────────────────────────────────────────

export interface ExtractionResult {
  nodes: Array<{
    type: NodeType;
    name: string;
    description: string;
    content: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    name: string;
    description: string;
  }>;
}

export interface FinalizeResult {
  promotedSkills: Array<{
    type: "SKILL";
    name: string;
    description: string;
    content: string;
  }>;
  newEdges: Array<{
    from: string;
    to: string;
    name: string;
    description: string;
  }>;
  invalidations: string[];
}

// ─── 召回结果 ─────────────────────────────────────────────────

export interface RecallResult {
  nodes: GmNode[];
  edges: GmEdge[];
  /** nodeId → PPR分数（个性化PageRank，从查询种子节点传播得到）*/
  pprScores: Record<string, number>;
  tokenEstimate: number;
}

// ─── Embedding 配置 ──────────────────────────────────────────

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
}

// ─── 插件配置 ─────────────────────────────────────────────────

export interface GmConfig {
  dbPath: string;
  compactTurnCount: number;
  recallMaxNodes: number;
  recallMaxDepth: number;
  freshTailCount: number;
  embedding?: EmbeddingConfig;
  llm?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
  };
  /** 向量去重阈值，余弦相似度超过此值视为重复 (0-1) */
  dedupThreshold: number;
  /** PageRank 阻尼系数 */
  pagerankDamping: number;
  /** PageRank 迭代次数 */
  pagerankIterations: number;
  /** 提取时传给 LLM 的本 session 历史消息轮次数（以 user 消息为边界），默认 3 */
  extractionRecentTurns: number;
}

export const DEFAULT_CONFIG: GmConfig = {
  dbPath: "~/.openclaw/graph-memory.db",
  compactTurnCount: 6,
  recallMaxNodes: 45,
  recallMaxDepth: 2,
  freshTailCount: 10,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
  extractionRecentTurns: 3,
};
