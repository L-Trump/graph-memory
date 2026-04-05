/**
 * graph-memory — Belief Update Detector (Simplified)
 *
 * Detects belief updates from user messages using pattern matching.
 * This complements the LLM-based belief detection in extract.ts.
 *
 * Update Types (Pattern-based only):
 * - user_correction:   User explicitly corrects/contradicts a recalled node
 * - explicit_confirm:  User explicitly confirms a recalled node was correct
 *
 * Note: Tool success/failure signals are detected by LLM in extract.ts
 * to avoid redundant LLM calls and improve accuracy.
 */

import type { TieredNode } from "./recaller/recall.ts";

// ─── Pattern Definitions ──────────────────────────────────────────

/** High-confidence correction patterns (user explicitly says something is wrong) */
const CORRECTION_PATTERNS_HIGH = [
  /不对 | 不是 | 错了 | 纠正 | 修正 | 取消 | 停 | 不对的 | 不正确/i,
  /wrong|incorrect|not right|cancel|stop|never mind/i,
];

/** Medium-confidence correction patterns (user expresses doubt/negation) */
const CORRECTION_PATTERNS_MEDIUM = [
  /不行 | 没用 | 无用 | 有误 | 失败 | 别 | 不要/i,
  /doesn'?t work|didn?'?t work|failed|i don'?t think so/i,
];

/**
 * Patterns that look like corrections but are actually instructions.
 * Checked AFTER correction detection to filter false positives.
 */
const CORRECTION_FALSE_POSITIVE = [
  /不要停 | 不要中断工具调用 | 别停/i,   // encouragement to continue, not correction
  /完成前不要中断/i,                 // continuation instruction
];

/**
 * Confirmation patterns (user explicitly agrees)
 * Note: "好" requires word boundary — avoids matching inside "谢谢你的帮助"
 * "谢谢" requires clear context — gratitude ≠ confirmation
 */
const CONFIRM_PATTERNS = [
  // Chinese: explicit confirm at word boundary (positive lookahead)
  /(?:^|[\s,。!?]) 对的 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 可以 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 好的 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 行 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 行吧 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 好 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 好吧 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 明白 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 知道了 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 正确 (?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?]) 谢谢 (?:[\s,。!?]|$)/i,
  // English
  /(?:^|[\s,])ok(?:[\s,!?.]|$)/i,
  /(?:^|[\s,])yes(?:[\s,!?.]|$)/i,
  /(?:^|[\s,])correct(?:[\s,!?.]|$)/i,
  /(?:^|[\s,])right(?:[\s,!?.]|$)/i,
  /(?:^|[\s,])sounds good/i,
  /(?:^|[\s,])that works/i,
  /(?:^|[\s,])i agree/i,
];

/** Patterns that negate a confirmation — NOT a confirm signal */
const NEGATE_CONFIRM_PATTERNS = [
  /^谢谢你/im,           // gratitude at start — not confirmation
  /好不好 | 好吗 | 好不/i,   // question form
  /^呃/im,               // hesitation at line start
  /^那 [,.。!?\s]/m,     // "那" at line start → follow-up, not confirm
  /怎么.*\?$|为什么.*\?$/i,  // question ending → not confirm
];

// ─── Text Extraction ────────────────────────────────────────────

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (typeof content === "object") {
    const c = content as any;
    if (Array.isArray(c)) {
      return c
        .filter((b: any) => b && typeof b === "object" && b.type === "text")
        .map((b: any) => b.text ?? "")
        .join("\n")
        .trim();
    }
    if (typeof c.content === "string") return c.content;
    if (typeof c.text === "string") return c.text;
  }
  return String(content).slice(0, 500);
}

/** Extract all user messages from a turn's messages */
export function extractUserMessages(messages: any[]): Array<{ text: string; turnIndex: number }> {
  const results: Array<{ text: string; turnIndex: number }> = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractTextFromContent(msg.content);
      if (text.trim()) {
        results.push({ text, turnIndex: msg.turn_index ?? 0 });
      }
    }
  }
  return results;
}

// ─── Signal Detection ────────────────────────────────────────────

export interface DetectedSignal {
  /** What kind of belief update */
  type: "user_correction" | "explicit_confirm";
  /** Which node name this relates to (best guess) */
  nodeName: string | null;
  /** Which node IDs this relates to */
  nodeIds: string[];
  /** How confident we are (0-1) */
  confidence: number;
  /** The text that triggered this update */
  triggerText: string;
  /** The full turn messages for context */
  messages: any[];
}

export interface SignalDetectionContext {
  /** Messages from this turn (user + assistant + tools) */
  turnMessages: any[];
  /** Nodes that were recalled in this turn (TieredNode with scores) */
  recalledNodes: TieredNode[];
  /** The user's message text */
  userText: string;
  /** Session ID */
  sessionId: string;
}

/**
 * Detect belief updates from a conversation turn using pattern matching.
 *
 * This complements the LLM-based belief detection in extract.ts.
 * Returns an array of detected updates, ordered by confidence (highest first).
 */
export function detectSignals(ctx: SignalDetectionContext): DetectedSignal[] {
  const signals: DetectedSignal[] = [];
  const { turnMessages, recalledNodes, userText, sessionId } = ctx;

  // ── 1. User Correction Detection ──────────────────────────────
  let correctionScore = Math.max(
    ...CORRECTION_PATTERNS_HIGH.map(p => p.test(userText) ? 1.0 : 0),
    ...CORRECTION_PATTERNS_MEDIUM.map(p => p.test(userText) ? 0.6 : 0),
  );

  if (correctionScore > 0) {
    // Filter out false positives — instructions disguised as corrections
    const isFalsePositive = CORRECTION_FALSE_POSITIVE.some(p => p.test(userText));
    if (isFalsePositive) {
      correctionScore = 0;
    }
  }

  if (correctionScore > 0) {
    // Target nodes: L1 nodes ranked by semantic + PPR (excluding PR/belief)
    const targetNodes = rankTargetNodes(recalledNodes);
    signals.push({
      type: "user_correction",
      nodeName: targetNodes[0]?.name ?? null,
      nodeIds: targetNodes.map(n => n.id),
      confidence: correctionScore,
      triggerText: userText.slice(0, 100),
      messages: turnMessages,
    });
  }

  // ── 2. User Confirmation Detection ──────────────────────────
  // Check if any negation pattern fires — gratitude ≠ confirmation
  const negatedByGratitude = NEGATE_CONFIRM_PATTERNS.some(p => p.test(userText));
  const confirmScore = negatedByGratitude
    ? 0
    : Math.max(...CONFIRM_PATTERNS.map(p => p.test(userText) ? 0.7 : 0));

  if (confirmScore > 0) {
    const targetNodes = rankTargetNodes(recalledNodes);
    signals.push({
      type: "explicit_confirm",
      nodeName: targetNodes[0]?.name ?? null,
      nodeIds: targetNodes.map(n => n.id),
      confidence: confirmScore,
      triggerText: userText.slice(0, 100),
      messages: turnMessages,
    });
  }

  // Sort by confidence
  signals.sort((a, b) => b.confidence - a.confidence);

  return signals;
}

/**
 * Rank L1 recalled nodes by semantic + PPR (excluding PageRank/belief influence).
 *
 * This determines which recalled nodes are most likely to have driven
 * the agent's behavior this turn — the natural targets for belief signals.
 */
function rankTargetNodes(recalledNodes: TieredNode[], topN = 5): TieredNode[] {
  const l1Nodes = recalledNodes.filter(n => n.tier === "L1");
  if (l1Nodes.length === 0) return [];

  // If only one L1 node, it's the obvious target
  if (l1Nodes.length === 1) return l1Nodes;

  // Find min/max for normalization
  const semScores = l1Nodes.map(n => n.semanticScore);
  const pprScores = l1Nodes.map(n => n.pprScore);
  const semMin = Math.min(...semScores);
  const semMax = Math.max(...semScores);
  const pprMin = Math.min(...pprScores);
  const pprMax = Math.max(...pprScores);

  const semRange = semMax - semMin || 1;
  const pprRange = pprMax - pprMin || 1;

  // Re-rank: 70% semantic + 30% PPR (both normalized to [0, 1])
  const ranked = l1Nodes.map(n => {
    const normSem = (n.semanticScore - semMin) / semRange;
    const normPpr = (n.pprScore - pprMin) / pprRange;
    const decisionScore = 0.7 * normSem + 0.3 * normPpr;
    return { node: n, score: decisionScore };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, topN).map(r => r.node);
}

/**
 * Get the weight for a belief update type (pattern-based detection).
 * Higher weight = stronger effect on belief.
 */
export function getSignalWeight(
  type: DetectedSignal["type"]
): number {
  switch (type) {
    case "user_correction":    return 2.0;  // Highest: user explicitly said it's wrong
    case "explicit_confirm":   return 1.5;  // High: user explicitly confirmed
    default:                   return 1.0;
  }
}

/**
 * Should we emit this belief update?
 * Deduplicates and filters low-confidence updates.
 */
export function shouldEmitSignal(
  signal: DetectedSignal,
  recentSignals: DetectedSignal[],
  minConfidence = 0.5,
): boolean {
  if (signal.confidence < minConfidence) return false;

  // Don't emit duplicate signals for the same node within this turn
  const sameNodeRecent = recentSignals.find(
    s => s.type === signal.type &&
    s.nodeIds.some(id => signal.nodeIds.includes(id))
  );
  if (sameNodeRecent) return false;

  return true;
}
