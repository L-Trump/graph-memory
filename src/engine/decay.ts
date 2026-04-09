/**
 * graph-memory — Decay Engine
 *
 * Weibull stretched-exponential decay model adapted from memory-lancedb-pro.
 *
 * Composite Score = recencyWeight * recency
 *                + frequencyWeight * frequency
 *                + intrinsicWeight * intrinsic
 *
 * Key differences from memory-lancedb-pro:
 * - No MemoryTier (Core/Working/Peripheral); uses NodeType instead
 * - importance is derived from NodeType (not a separate field)
 * - Dynamic "status" nodes (STATUS type) get fast-decay profile
 * - TASK nodes get medium-fast decay (completed tasks should fade)
 */

import type { NodeType } from "../types.ts";

// ─── Constants ─────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

// ─── Types ─────────────────────────────────────────────────────

export interface DecayConfig {
  /** Days until recency score halves for a baseline node (importance=0.5) */
  recencyHalfLifeDays: number;
  recencyWeight: number;
  frequencyWeight: number;
  intrinsicWeight: number;
  /** Below this composite → stale (default: 0.3) */
  staleThreshold: number;
  /** Minimum search boost multiplier when composite is very low (default: 0.3) */
  searchBoostMin: number;
  /** Importance modulation coefficient: effectiveHL = baseHL * exp(mu * importance) */
  importanceModulation: number;
  /** Weibull beta for STATUS nodes — super-exponential (fast decay) */
  betaStatus: number;
  /** Weibull beta for TASK nodes — standard exponential */
  betaTask: number;
  /** Weibull beta for EVENT nodes — slightly sub-exponential */
  betaEvent: number;
  /** Weibull beta for KNOWLEDGE nodes — sub-exponential (slow decay) */
  betaKnowledge: number;
  /** Weibull beta for SKILL/TOPIC nodes — very sub-exponential (stable) */
  betaSkill: number;
  /** Decay floor for STATUS nodes (0.4 — can decay to near zero) */
  floorStatus: number;
  /** Decay floor for TASK nodes (0.5) */
  floorTask: number;
  /** Decay floor for EVENT nodes (0.55) */
  floorEvent: number;
  /** Decay floor for KNOWLEDGE nodes (0.65) */
  floorKnowledge: number;
  /** Decay floor for SKILL/TOPIC nodes (0.8 — very stable) */
  floorSkill: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  recencyHalfLifeDays: 30,
  recencyWeight: 0.4,
  frequencyWeight: 0.3,
  intrinsicWeight: 0.3,
  staleThreshold: 0.3,
  searchBoostMin: 0.3,
  importanceModulation: 1.5,
  betaStatus: 1.3,    // fast decay
  betaTask: 1.0,      // standard exponential
  betaEvent: 0.9,     // slightly slow
  betaKnowledge: 0.85, // slow
  betaSkill: 0.8,     // very slow
  floorStatus: 0.4,
  floorTask: 0.5,
  floorEvent: 0.55,
  floorKnowledge: 0.65,
  floorSkill: 0.8,
};

export interface DecayScore {
  nodeId: string;
  recency: number;
  frequency: number;
  intrinsic: number;
  composite: number;
}

/** Minimal memory fields needed for decay calculation */
export interface DecayableNode {
  id: string;
  type: NodeType;
  importance: number;  // derived from type
  belief: number;      // 0-1
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number; // 0 = never accessed
}

export interface DecayEngine {
  score(node: DecayableNode, now?: number): DecayScore;
  scoreAll(nodes: DecayableNode[], now?: number): DecayScore[];
  /** Apply decay boost to scored results (multiplies each score by boost) */
  applySearchBoost(
    results: Array<{ node: DecayableNode; score: number }>,
    now?: number,
  ): void;
  /** Find stale nodes (composite below threshold), sorted ascending */
  getStaleNodes(nodes: DecayableNode[], now?: number): DecayScore[];
}

// ─── NodeType → Decay Parameters ─────────────────────────────────

/**
 * Get the baseline importance (0-1) for each NodeType.
 * This replaces the need for an explicit importance field.
 */
export function getTypeImportance(type: NodeType): number {
  switch (type) {
    case "SKILL":    return 0.9;  // Very important, stable
    case "TOPIC":    return 0.85; // Important, stable
    case "KNOWLEDGE": return 0.7; // Moderately important
    case "EVENT":    return 0.5;  // Less important, decays faster
    case "TASK":     return 0.6;  // Medium importance
    case "STATUS":   return 0.3;  // Low importance, fast decay
    default:         return 0.5;
  }
}

/**
 * Get the decay floor for a NodeType.
 */
function getTypeFloor(type: NodeType, cfg: DecayConfig): number {
  switch (type) {
    case "SKILL":    return cfg.floorSkill;
    case "TOPIC":    return cfg.floorSkill;
    case "KNOWLEDGE": return cfg.floorKnowledge;
    case "EVENT":    return cfg.floorEvent;
    case "TASK":     return cfg.floorTask;
    case "STATUS":   return cfg.floorStatus;
    default:         return 0.5;
  }
}

/**
 * Get the Weibull beta for a NodeType.
 */
function getTypeBeta(type: NodeType, cfg: DecayConfig): number {
  switch (type) {
    case "SKILL":    return cfg.betaSkill;
    case "TOPIC":    return cfg.betaSkill;
    case "KNOWLEDGE": return cfg.betaKnowledge;
    case "EVENT":    return cfg.betaEvent;
    case "TASK":     return cfg.betaTask;
    case "STATUS":   return cfg.betaStatus;
    default:         return 1.0;
  }
}

// ─── Core Decay Functions ────────────────────────────────────────

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/**
 * Weibull stretched-exponential recency decay.
 * effectiveHL = baseHL * exp(mu * importance)
 * lambda = ln(2) / effectiveHL
 * recency = exp(-lambda * daysSince^beta)
 */
function computeRecency(
  node: DecayableNode,
  now: number,
  halfLife: number,
  mu: number,
  beta: number,
): number {
  // Prefer lastAccessedAt if set; fall back to createdAt for pre-access-tracking nodes.
  const lastActive = node.lastAccessedAt > 0 ? node.lastAccessedAt : node.createdAt;
  const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);
  const effectiveHL = halfLife * Math.exp(mu * node.importance);
  const lambda = Math.LN2 / effectiveHL;
  return Math.exp(-lambda * Math.pow(daysSince, beta));
}

/**
 * Frequency: logarithmic saturation curve.
 * base = 1 - exp(-accessCount / 5)
 * Recent accesses get a bonus (avg gap between accesses)
 */
function computeFrequency(node: DecayableNode): number {
  const base = 1 - Math.exp(-node.accessCount / 5);
  if (node.accessCount <= 1) return clamp01(base, 0);

  const lastActive = node.accessCount > 0 ? node.lastAccessedAt : node.createdAt;
  const accessSpanDays = Math.max(1, (lastActive - node.createdAt) / MS_PER_DAY);
  const avgGapDays = accessSpanDays / Math.max(node.accessCount - 1, 1);
  const recentnessBonus = Math.exp(-avgGapDays / 30);
  return clamp01(base * (0.5 + 0.5 * recentnessBonus), 0.1);
}

/**
 * Intrinsic value: importance × belief
 * importance is derived from NodeType (not the node.importance field)
 * belief comes from GM's existing belief system
 */
function computeIntrinsic(node: DecayableNode): number {
  const importance = getTypeImportance(node.type);
  return clamp01(importance * node.belief, 0);
}

// ─── Factory ────────────────────────────────────────────────────

export function createDecayEngine(config: Partial<DecayConfig> = {}): DecayEngine {
  const cfg: DecayConfig = { ...DEFAULT_DECAY_CONFIG, ...config };

  function scoreOne(node: DecayableNode, now: number): DecayScore {
    const r = computeRecency(
      node, now,
      cfg.recencyHalfLifeDays,
      cfg.importanceModulation,
      getTypeBeta(node.type, cfg),
    );
    const f = computeFrequency(node);
    const i = computeIntrinsic(node);
    const composite = cfg.recencyWeight * r + cfg.frequencyWeight * f + cfg.intrinsicWeight * i;

    return {
      nodeId: node.id,
      recency: r,
      frequency: f,
      intrinsic: i,
      composite,
    };
  }

  return {
    score(node, now = Date.now()) {
      return scoreOne(node, now);
    },

    scoreAll(nodes, now = Date.now()) {
      return nodes.map((n) => scoreOne(n, now));
    },

    applySearchBoost(results, now = Date.now()) {
      for (const r of results) {
        const ds = scoreOne(r.node, now);
        const floor = Math.max(getTypeFloor(r.node.type, cfg), ds.composite);
        const multiplier = cfg.searchBoostMin + (1 - cfg.searchBoostMin) * floor;
        r.score *= Math.min(1, Math.max(cfg.searchBoostMin, multiplier));
      }
    },

    getStaleNodes(nodes, now = Date.now()) {
      return this.scoreAll(nodes, now)
        .filter((s) => s.composite < cfg.staleThreshold)
        .sort((a, b) => a.composite - b.composite);
    },
  };
}

/**
 * Convert a GmNode (from store) to a DecayableNode.
 * Falls back to defaults for nodes created before the access tracking migration.
 */
export function toDecayableNode(node: {
  id: string;
  type: NodeType;
  belief?: number;
  accessCount?: number;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}): DecayableNode {
  return {
    id: node.id,
    type: node.type,
    importance: getTypeImportance(node.type),
    belief: node.belief ?? 0.5,
    accessCount: (node.accessCount as number) ?? 0,
    createdAt: node.createdAt,
    lastAccessedAt: (node.lastAccessedAt as number) ?? 0,
  };
}
