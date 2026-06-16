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

import type { DecayConfig } from "./engine/decay.ts";

// ─── 节点 ─────────────────────────────────────────────────────

export type NodeType = "TASK" | "SKILL" | "EVENT" | "KNOWLEDGE" | "STATUS" | "TOPIC" | "SESSION";
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
  /** Number of times this node was recalled and assembled into context */
  accessCount?: number;
  /** Timestamp of last access (recall + assemble) */
  lastAccessedAt?: number;
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

// ─── 置信度更新 ─────────────────────────────────────────────────────

export type BeliefUpdateType = SignalType;

/** 置信度更新信号（与 Signal 相同，用于语义清晰） */
export interface BeliefUpdateSignal {
  type: BeliefUpdateType;
  turnIndex: number;
  data: Record<string, any>;
}

// ─── 提取结果 ─────────────────────────────────────────────────

export type BeliefVerdict = "supported" | "contradicted";

export interface BeliefUpdate {
  /** 被评估的已召回节点名称（精确匹配） */
  nodeName: string;
  /** 本轮对话对该节点内容的判断：supported=支持/正例，contradicted=反对/反例 */
  verdict: BeliefVerdict;
  /** 置信度调整力度，范围 0.5-2.0 */
  weight: number;
  /** 简短原因说明 */
  reason: string;
}

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
  /** 本轮对话对已召回 L1 节点的置信度更新 */
  beliefUpdates?: BeliefUpdate[];
  /** 需要顾问介入判断的建议（如：建议将某节点写成文档）*/
  advisorySuggestions?: AdvisorySuggestion[];
}

/** 记忆顾问建议：某些知识节点建议写成文档等 */
export interface AdvisorySuggestion {
  /** 相关节点名称 */
  nodeName: string;
  /** 建议内容，如"建议写成文档" */
  suggestion: string;
  /** 建议的具体原因 */
  reason: string;
  /** 建议的文档标题（供顾问参考） */
  suggestedDocTitle?: string;
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
  /** 全局开关：false 时保留工具/命令注册，但跳过自动 recall/extract hooks */
  enabled?: boolean;
  /** 自动召回开关：false 时不在 before_prompt_build 注入 dynamic/stable GM 上下文 */
  recallEnabled?: boolean;
  /** 自动提取开关：false 时不在 agent_end/compaction 自动写入和提取消息 */
  extractionEnabled?: boolean;
  /** 哪些会话类型允许运行自动 recall/extract；默认 direct/group/channel/explicit（保持历史行为） */
  allowedChatTypes?: Array<"direct" | "group" | "channel" | "explicit">;
  /** 允许的 conversation/chat id；非空时仅这些 id 自动运行 */
  allowedChatIds?: string[];
  /** 拒绝的 conversation/chat id；优先级高于 allowedChatIds */
  deniedChatIds?: string[];
  /** before_prompt_build recall 总预算，超时后降级为仅 stable context；默认 1500ms */
  recallTimeoutMs?: number;
  /** recall 结果缓存 TTL，缓存按 session + prompt/history query hash；默认 15000ms */
  recallCacheTtlMs?: number;
  /** 同一 session 连续 recall 超时多少次后打开 circuit breaker；默认 3 */
  recallCircuitBreakerMaxTimeouts?: number;
  /** circuit breaker 冷却时间；默认 60000ms */
  recallCircuitBreakerCooldownMs?: number;
  /** 是否把 Graph Memory 本轮状态写入 session pluginDebugEntries，供 /status verbose/trace 显示 */
  statusDebugEnabled?: boolean;
  /** 独立插件日志：routine info/debug 可写入 /tmp/openclaw/graph-memory-YYYY-MM-DD.log，减少主 Gateway 日志噪声 */
  independentLogFile?: {
    enabled?: boolean;
    /** 可选日志文件路径；为空时使用 /tmp/openclaw/graph-memory-YYYY-MM-DD.log */
    file?: string;
    /** 单文件大小上限，超过后轮转 .1.log ~ .5.log；默认 104857600 */
    maxFileBytes?: number;
  };
  dbPath: string;
  /** 自动召回注入模式：full=完整动态记忆经 before_prompt_build 注入；index=短索引写入 user message 以改善前缀缓存 */
  autoRecallMode?: "full" | "index";
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
  /** 每次维护最多合并的向量重复节点数；0 表示仅检测不合并，默认 200 */
  dedupMaxMergesPerRun?: number;
  /** 每次维护最多检测的重复向量对数；0 表示不限制，默认 1000 */
  dedupMaxPairsPerRun?: number;
  /** 每次维护最多处理的新增/变更向量数；0 表示回退到全量扫描，默认 200 */
  dedupMaxPendingVectorsPerRun?: number;
  /** PageRank 阻尼系数 */
  pagerankDamping: number;
  /** PageRank 迭代次数 */
  pagerankIterations: number;
  /** 提取时传给 LLM 的本 session 历史消息轮次数（以 user 消息为边界），默认 3 */
  extractionRecentTurns: number;
  /** inactive session 历史记录清理配置（清理 gm_messages 与 gm_recalled），默认启用 */
  retention?: {
    enabled?: boolean;
    /** 非 active session 的保留天数，默认 30 */
    retentionDays?: number;
    /** 单次最多删除行数，避免长时间锁库，默认 20000 */
    maxDeletePerRun?: number;
    /** 是否在清理后执行 VACUUM，默认 false */
    vacuum?: boolean;
  };
  /** 是否启用衰减引擎（access-based decay scoring），默认 true */
  decayEnabled?: boolean;
  /** 衰减引擎参数覆盖，包括按类型 floor；默认使用 DEFAULT_DECAY_CONFIG */
  decay?: Partial<DecayConfig>;
  /** compact 后是否把当前 session active nodes 注入 stable 层，默认 false */
  compactActiveNodesEnabled?: boolean;
  /** compact active nodes 注入 stable 层的最大数量，默认 100 */
  compactActiveNodesMax?: number;
  /** 调试：输出 stable/dynamic 注入上下文前后片段，默认 false */
  debugContextPreview?: boolean;
}

export const DEFAULT_CONFIG: GmConfig = {
  enabled: true,
  recallEnabled: true,
  extractionEnabled: true,
  allowedChatTypes: ["direct", "group", "channel", "explicit"],
  allowedChatIds: [],
  deniedChatIds: [],
  recallTimeoutMs: 20000,
  recallCacheTtlMs: 15000,
  recallCircuitBreakerMaxTimeouts: 3,
  recallCircuitBreakerCooldownMs: 60000,
  statusDebugEnabled: true,
  independentLogFile: {
    enabled: true,
    maxFileBytes: 104_857_600,
  },
  dbPath: "~/.openclaw/graph-memory.db",
  autoRecallMode: "full",
  compactTurnCount: 6,
  recallMaxNodes: 15,
  recallMaxDepth: 2,
  freshTailCount: 10,
  dedupThreshold: 0.90,
  dedupMaxMergesPerRun: 200,
  dedupMaxPairsPerRun: 1000,
  dedupMaxPendingVectorsPerRun: 2000,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
  extractionRecentTurns: 3,
  retention: {
    enabled: true,
    retentionDays: 30,
    maxDeletePerRun: 20_000,
    vacuum: false,
  },
  decayEnabled: true,
  decay: {},
  compactActiveNodesEnabled: false,
  compactActiveNodesMax: 100,
  debugContextPreview: false,
};
