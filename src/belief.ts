/**
 * graph-memory — Belief/Credibility System
 *
 * This module implements a Bayesian-inspired confidence mechanism for graph memory nodes.
 * Each node has a "belief" score [0, 1] representing how trustworthy/useful the node is,
 * based on evidence accumulated from usage signals.
 *
 * Design Principles:
 * 1. belief ∈ [0, 1]: 0 = completely discredited, 1 = fully validated
 * 2. Neutral prior: belief = 0.5 when no evidence exists
 * 3. Updates are Bayesian: successes push belief up, failures push it down
 * 4. Decay: old evidence gradually loses weight (time-based)
 * 5. Recall integration: belief affects ranking (high-belief nodes ranked higher)
 *
 * Multiple schemes are implemented for comparison:
 *
 * Scheme A — Beta-Bayesian Count:
 *   belief = (α + successes) / (α + β + successes + failures)
 *   α=1, β=1 (neutral prior)
 *   Simple, interpretable, mathematically sound
 *
 * Scheme B — Exponential Decay:
 *   belief_t = λ*belief_{t-1} + (1-λ)*signal
 *   λ=0.85 (recent evidence weighs more)
 *   Captures temporal dynamics
 *
 * Scheme C — Adaptive Bayesian:
 *   Uses evidence quality weights + recency weighting
 *   User corrections weigh 3x tool errors
 *   Success confirms weigh 2x simple uses
 *
 * All schemes tested against the same signal log; best scheme selected by:
 *   - User correction detection rate (did belief go down when user corrected?)
 *   - Task success rate (did belief go up after successful task completion?)
 *   - Calibration (are high-belief nodes actually more reliable?)
 */

import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash } from "crypto";

// ─── Schema Migration ────────────────────────────────────────────

/**
 * Add belief system tables and columns to existing database.
 * Safe to call multiple times (idempotent).
 */
export function migrateBeliefSchema(db: DatabaseSyncInstance): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)`);
  const cur = (db.prepare("SELECT MAX(v) as v FROM _migrations").get() as any)?.v ?? 0;

  const steps: Array<(db: DatabaseSyncInstance) => void> = [
    m10_belief_score,     // v=10: gm_nodes.belief column
    m11_signal_log,       // v=11: gm_belief_signals table
    m12_recall_feedback,  // v=12: gm_recall_feedback table
  ];

  for (let i = cur; i < steps.length; i++) {
    if (i >= 10) {
      steps[i - 10](db);
      db.prepare("INSERT INTO _migrations (v,at) VALUES (?,?)").run(i + 1, Date.now());
    }
  }
}

function m10_belief_score(db: DatabaseSyncInstance): void {
  try {
    db.prepare("SELECT belief FROM gm_nodes LIMIT 1").get();
    return; // already migrated
  } catch { /* no column */ }

  // Add belief column with default 0.5 (neutral prior)
  db.exec(`ALTER TABLE gm_nodes ADD COLUMN belief REAL NOT NULL DEFAULT 0.5`);
  // Add evidence counters
  db.exec(`ALTER TABLE gm_nodes ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE gm_nodes ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`);
  // Add last signal time (for recency weighting)
  db.exec(`ALTER TABLE gm_nodes ADD COLUMN last_signal_at INTEGER NOT NULL DEFAULT 0`);
}

function m11_signal_log(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_belief_signals (
      id          TEXT PRIMARY KEY,
      node_id     TEXT NOT NULL REFERENCES gm_nodes(id),
      node_name   TEXT NOT NULL,
      signal_type TEXT NOT NULL CHECK(signal_type IN (
        'tool_success', 'tool_error', 'user_correction',
        'explicit_confirm', 'recall_used', 'recall_rejected',
        'belief_increase', 'belief_decrease', 'initial'
      )),
      -- Evidence quality: 0.0-1.0 weight of this signal
      weight      REAL NOT NULL DEFAULT 1.0,
      context     TEXT NOT NULL DEFAULT '{}',
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_belief_sig_node ON gm_belief_signals(node_id, created_at);
    CREATE INDEX IF NOT EXISTS ix_belief_sig_session ON gm_belief_signals(session_id);
  `);
}

function m12_recall_feedback(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_recall_feedback (
      id              TEXT PRIMARY KEY,
      recall_query   TEXT NOT NULL,
      recall_session TEXT NOT NULL,
      node_id        TEXT NOT NULL REFERENCES gm_nodes(id),
      node_name      TEXT NOT NULL,
      -- How the recall turned out
      outcome         TEXT NOT NULL CHECK(outcome IN (
        'used_successfully', 'used_with_error', 'rejected',
        'not_applicable', 'confirmed_by_user', 'contradicted_by_user'
      )),
      belief_after    REAL NOT NULL,
      belief_before   REAL NOT NULL,
      signal_emitted  TEXT,
      session_id      TEXT NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_recall_fb_node ON gm_recall_feedback(node_id, created_at);
    CREATE INDEX IF NOT EXISTS ix_recall_fb_session ON gm_recall_feedback(recall_session);
  `);
}

// ─── Signal Types ───────────────────────────────────────────────

export type BeliefSignalType =
  | "tool_success"       // Tool use based on this node succeeded
  | "tool_error"         // Tool use based on this node failed
  | "user_correction"     // User explicitly corrected/contradicted this node
  | "explicit_confirm"    // User explicitly confirmed this node was correct
  | "recall_used"         // Node was recalled and its guidance was followed
  | "recall_rejected"     // Node was recalled but guidance was not followed
  | "belief_increase"     // Internal: belief was increased (for tracking)
  | "belief_decrease"     // Internal: belief was decreased (for tracking)
  | "initial";            // Initial belief assignment

export type RecallOutcome =
  | "used_successfully"
  | "used_with_error"
  | "rejected"
  | "not_applicable"
  | "confirmed_by_user"
  | "contradicted_by_user";

// ─── Belief Computation Schemes ─────────────────────────────────

export type BeliefScheme = "A" | "B" | "C" | "current";

export interface BeliefUpdate {
  belief_before: number;
  belief_after: number;
  delta: number;
  successes: number;
  failures: number;
  scheme: BeliefScheme;
}

/**
 * Scheme A — Beta-Bayesian Count
 *
 * Uses the Beta-Bayesian model: belief = (α + s) / (α + β + s + f)
 * With α=1, β=1 (uniform prior), this simplifies to (1+s)/(2+s+f)
 *
 * Properties:
 * - belief=0.5 when s=f=0 (neutral prior)
 * - belief=0.75 when s=2, f=0 (3 confirmations → 75%)
 * - belief=0.25 when s=0, f=2 (2 failures → 25%)
 * - Smooth, interpretable, mathematically principled
 */
export function computeBeliefSchemeA(
  successCount: number,
  failureCount: number,
): number {
  const α = 1, β = 1;
  return (α + successCount) / (α + β + successCount + failureCount);
}

/**
 * Scheme B — Exponential Moving Average
 *
 * belief_t = λ * belief_{t-1} + (1-λ) * signal
 * signal = +1 for success, 0 for neutral, -1 for failure
 * λ = 0.85 (past evidence decays)
 *
 * Properties:
 * - Recent signals dominate
 * - Old evidence fades exponentially
 * - Good for rapidly changing environments
 */
export function computeBeliefSchemeB(
  currentBelief: number,
  signal: number, // +1 success, 0 neutral, -1 failure
  λ = 0.85,
): number {
  const newBelief = λ * currentBelief + (1 - λ) * (signal > 0 ? 1 : signal < 0 ? 0 : 0.5);
  return Math.max(0, Math.min(1, newBelief));
}

/**
 * Scheme C — Weighted Bayesian with Recency
 *
 * Uses quality-weighted evidence + recency decay
 * - user_correction: weight=3 (high stakes)
 * - tool_error: weight=2
 * - tool_success: weight=1
 * - recall_used: weight=0.5
 *
 * Evidence also decays: signal_weight = base_weight * exp(-λ * age_in_days)
 *
 * Then: belief = sigmoid(sum(weighted_signals))
 * Normalized to [0, 1] using cumulative weighted sum → sigmoid
 */
export function computeBeliefSchemeC(
  signals: Array<{ weight: number; createdAt: number; isPositive: boolean }>,
  λ = 0.1, // daily decay rate
): number {
  if (signals.length === 0) return 0.5;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  let weightedSum = 0;
  for (const s of signals) {
    const ageDays = (now - s.createdAt) / DAY;
    const recencyWeight = Math.exp(-λ * ageDays);
    const value = s.isPositive ? 1 : -1;
    weightedSum += s.weight * value * recencyWeight;
  }

  // sigmoid to [0, 1]
  const belief = 1 / (1 + Math.exp(-weightedSum));
  return Math.max(0.05, Math.min(0.95, belief));
}

// ─── Node Belief Operations ─────────────────────────────────────

function uid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Get belief info for a node */
export function getBeliefInfo(db: DatabaseSyncInstance, nodeId: string): {
  belief: number;
  successCount: number;
  failureCount: number;
  lastSignalAt: number;
} | null {
  const row = db.prepare(
    "SELECT belief, success_count, failure_count, last_signal_at FROM gm_nodes WHERE id=?"
  ).get(nodeId) as any;
  if (!row) return null;
  return {
    belief: row.belief,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastSignalAt: row.last_signal_at,
  };
}

/** Get belief for a node by name */
export function getBeliefByName(db: DatabaseSyncInstance, name: string): number {
  const row = db.prepare(
    "SELECT belief FROM gm_nodes WHERE name=?"
  ).get(normalizeName(name)) as any;
  return row?.belief ?? 0.5;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** Record a belief signal for a node */
export function recordBeliefSignal(
  db: DatabaseSyncInstance,
  nodeId: string,
  nodeName: string,
  signalType: BeliefSignalType,
  sessionId: string,
  weight = 1.0,
  context: Record<string, unknown> = {},
): void {
  db.prepare(`
    INSERT INTO gm_belief_signals (id, node_id, node_name, signal_type, weight, context, session_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(uid("bsig"), nodeId, nodeName, signalType, weight, JSON.stringify(context), sessionId, Date.now());
}

/** Update belief for a node using a specific scheme */
export function updateNodeBelief(
  db: DatabaseSyncInstance,
  nodeId: string,
  scheme: BeliefScheme,
  signalType?: BeliefSignalType,
  signalWeight = 1.0,
): BeliefUpdate | null {
  const info = getBeliefInfo(db, nodeId);
  if (!info) return null;

  const belief_before = info.belief;
  let belief_after: number;
  let newSuccessCount = info.successCount;
  let newFailureCount = info.failureCount;
  let successes = info.successCount;
  let failures = info.failureCount;

  if (signalType) {
    const isPositive = ["tool_success", "explicit_confirm", "recall_used", "belief_increase"].includes(signalType);
    const isNegative = ["tool_error", "user_correction", "recall_rejected", "belief_decrease"].includes(signalType);

    if (isPositive) {
      newSuccessCount += 1;
      successes += 1;
    } else if (isNegative) {
      newFailureCount += 1;
      failures += 1;
    }
  }

  switch (scheme) {
    case "A":
      belief_after = computeBeliefSchemeA(newSuccessCount, newFailureCount);
      break;
    case "B":
      // signal as delta: +1 for positive, -1 for negative, 0 for neutral
      let signal = 0;
      if (signalType) {
        if (["tool_success", "explicit_confirm", "recall_used", "belief_increase"].includes(signalType)) signal = 1;
        else if (["tool_error", "user_correction", "recall_rejected", "belief_decrease"].includes(signalType)) signal = -1;
      }
      belief_after = computeBeliefSchemeB(belief_before, signal);
      break;
    case "C": {
      // Get all signals for this node
      const signals = (db.prepare(
        "SELECT weight, created_at, signal_type FROM gm_belief_signals WHERE node_id=? ORDER BY created_at"
      ).all(nodeId) as any[]).map((r: any) => ({
        weight: r.weight,
        createdAt: r.created_at,
        isPositive: ["tool_success", "explicit_confirm", "recall_used", "belief_increase", "initial"].includes(r.signal_type),
      }));
      belief_after = computeBeliefSchemeC(signals);
      break;
    }
    case "current":
    default:
      // Legacy: just increment validatedCount (no belief change)
      belief_after = belief_before;
      break;
  }

  // Write back
  db.prepare(`
    UPDATE gm_nodes
    SET belief=?, success_count=?, failure_count=?, last_signal_at=?, updated_at=?
    WHERE id=?
  `).run(belief_after, newSuccessCount, newFailureCount, Date.now(), Date.now(), nodeId);

  return {
    belief_before,
    belief_after,
    delta: belief_after - belief_before,
    successes: newSuccessCount,
    failures: newFailureCount,
    scheme,
  };
}

/** Record a recall outcome and update belief accordingly */
export function recordRecallOutcome(
  db: DatabaseSyncInstance,
  recallSession: string,
  recallQuery: string,
  nodeId: string,
  nodeName: string,
  outcome: RecallOutcome,
  belief_before: number,
  sessionId: string,
): BeliefUpdate | null {
  // Map outcome to signal type
  const outcomeToSignal: Record<RecallOutcome, BeliefSignalType | null> = {
    used_successfully: "tool_success",
    used_with_error: "tool_error",
    rejected: "recall_rejected",
    not_applicable: null,
    confirmed_by_user: "explicit_confirm",
    contradicted_by_user: "user_correction",
  };

  const signalType = outcomeToSignal[outcome];
  const signalWeight: Record<RecallOutcome, number> = {
    used_successfully: 1.0,
    used_with_error: 2.0,
    rejected: 0.5,
    not_applicable: 0.0,
    confirmed_by_user: 2.0,
    contradicted_by_user: 3.0,
  };

  if (signalType) {
    recordBeliefSignal(db, nodeId, nodeName, signalType, sessionId, signalWeight[outcome], {
      recallSession,
      recallQuery,
      outcome,
    });
  }

  const beliefUpdate = updateNodeBelief(db, nodeId, "A", signalType ?? undefined, signalWeight[outcome]);

  // Record in recall_feedback table
  db.prepare(`
    INSERT INTO gm_recall_feedback
    (id, recall_query, recall_session, node_id, node_name, outcome, belief_after, belief_before, signal_emitted, session_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    uid("rfb"),
    recallQuery,
    recallSession,
    nodeId,
    nodeName,
    outcome,
    beliefUpdate?.belief_after ?? belief_before,
    belief_before,
    signalType,
    sessionId,
    Date.now(),
  );

  return beliefUpdate;
}

/** Get belief history for a node */
export function getBeliefHistory(
  db: DatabaseSyncInstance,
  nodeId: string,
  limit = 20,
): Array<{ signalType: BeliefSignalType; weight: number; createdAt: number }> {
  return (db.prepare(
    "SELECT signal_type, weight, created_at FROM gm_belief_signals WHERE node_id=? ORDER BY created_at DESC LIMIT ?"
  ).all(nodeId, limit) as any[]).map(r => ({
    signalType: r.signal_type as BeliefSignalType,
    weight: r.weight,
    createdAt: r.created_at,
  }));
}

/** Get belief statistics across all nodes */
export function getBeliefStats(db: DatabaseSyncInstance): {
  avgBelief: number;
  highBelief: number;   // count of nodes with belief > 0.7
  lowBelief: number;    // count of nodes with belief < 0.3
  neutralBelief: number;
  totalSignals: number;
  recentSignals: number; // signals in last 24h
} {
  const stats = db.prepare(`
    SELECT
      AVG(belief) as avg_belief,
      SUM(CASE WHEN belief > 0.7 THEN 1 ELSE 0 END) as high_belief,
      SUM(CASE WHEN belief < 0.3 THEN 1 ELSE 0 END) as low_belief,
      SUM(CASE WHEN belief BETWEEN 0.4 AND 0.6 THEN 1 ELSE 0 END) as neutral_belief
    FROM gm_nodes WHERE status='active'
  `).get() as any;

  const signalCount = (db.prepare("SELECT COUNT(*) as c FROM gm_belief_signals").get() as any)?.c ?? 0;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentSignals = (db.prepare(
    "SELECT COUNT(*) as c FROM gm_belief_signals WHERE created_at > ?"
  ).get(dayAgo) as any)?.c ?? 0;

  return {
    avgBelief: stats.avg_belief ?? 0.5,
    highBelief: stats.high_belief ?? 0,
    lowBelief: stats.low_belief ?? 0,
    neutralBelief: stats.neutral_belief ?? 0,
    totalSignals: signalCount,
    recentSignals,
  };
}

/** Compute belief scores for all nodes using scheme A (simple pass) */
export function recomputeAllBeliefs(db: DatabaseSyncInstance, scheme: BeliefScheme = "A"): {
  updated: number;
  errors: number;
} {
  const nodes = db.prepare(
    "SELECT id, node_id FROM gm_nodes WHERE status='active'"
  ).all() as any[];

  let updated = 0, errors = 0;
  for (const row of nodes) {
    try {
      updateNodeBelief(db, row.id, scheme);
      updated++;
    } catch (e) {
      errors++;
    }
  }
  return { updated, errors };
}
