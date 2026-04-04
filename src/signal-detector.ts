/**
 * graph-memory — Belief Signal Detector
 *
 * Extracts belief signals from conversation context.
 *
 * Signal Types:
 * - user_correction:   User explicitly corrects/contradicts a recalled node
 * - explicit_confirm: User explicitly confirms a recalled node was correct
 * - tool_error:       Tool call failed after recalling this node
 * - tool_success:     Tool call succeeded after recalling this node
 * - recall_used:      Recalled node's guidance was followed in this turn
 * - recall_rejected:   Recalled node's guidance was contradicted/ignored
 *
 * Detection Strategy:
 * 1. Pattern matching on user message for corrections/confirms
 * 2. Tool result parsing for success/failure
 * 3. Semantic matching: associate signals with recalled nodes
 */

import type { GmNode } from "./types.ts";

// ─── Pattern Definitions ──────────────────────────────────────────

/** High-confidence correction patterns (user explicitly says something is wrong) */
const CORRECTION_PATTERNS_HIGH = [
  /不对|不是|错了|纠正|修正|取消|停|不对的|不正确/i,
  /wrong|incorrect|not right|cancel|stop|never mind/i,
];

/** Medium-confidence correction patterns (user expresses doubt/negation) */
const CORRECTION_PATTERNS_MEDIUM = [
  /不行|没用|无用|有误|失败|别|不要/i,
  /doesn'?t work|didn?'?t work|failed|i don'?t think so/i,
];

/** Confirmation patterns (user explicitly agrees) */
const CONFIRM_PATTERNS = [
  /对的|可以|好|行|明白了|知道了|谢谢|正确|成功|完成了|好的/i,
  /correct|right|yes|ok|okay|sounds good|that works|i agree/i,
];

/** Tool error indicators */
const TOOL_ERROR_PATTERNS = [
  /error|failed|exception|timeout|not found|permission denied/i,
  /错误|失败|异常|超时|未找到|权限/i,
];

/** Tool success indicators */
const TOOL_SUCCESS_PATTERNS = [
  /success|done|completed|ok|ready|created|deleted|updated/i,
  /成功|完成|好了|已创建|已删除|已更新/i,
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

/** Extract tool results from a turn's messages */
export function extractToolResults(messages: any[]): Array<{ toolName: string; text: string; isError: boolean }> {
  const results: Array<{ toolName: string; text: string; isError: boolean }> = [];
  for (const msg of messages) {
    if (msg.role === "tool" || msg.role === "toolResult") {
      const text = extractTextFromContent(msg.content);
      const toolName = (msg as any).name ?? (msg as any).tool_name ?? "unknown";
      const isError = TOOL_ERROR_PATTERNS.some(p => p.test(text));
      results.push({ toolName, text, isError });
    }
  }
  return results;
}

// ─── Signal Detection ────────────────────────────────────────────

export interface DetectedSignal {
  /** What kind of signal */
  type: "user_correction" | "explicit_confirm" | "tool_error" | "tool_success" | "recall_used" | "recall_rejected";
  /** Which node name this relates to (best guess) */
  nodeName: string | null;
  /** Which node IDs this relates to */
  nodeIds: string[];
  /** How confident we are (0-1) */
  confidence: number;
  /** The text that triggered this signal */
  triggerText: string;
  /** The full turn messages for context */
  messages: any[];
}

export interface SignalDetectionContext {
  /** Messages from this turn (user + assistant + tools) */
  turnMessages: any[];
  /** Nodes that were recalled in this session */
  recalledNodes: GmNode[];
  /** The user's message text */
  userText: string;
  /** Tool results from this turn */
  toolResults: Array<{ toolName: string; text: string; isError: boolean }>;
  /** Session ID */
  sessionId: string;
}

/**
 * Detect belief signals from a conversation turn.
 *
 * Returns an array of detected signals, ordered by confidence (highest first).
 */
export function detectSignals(ctx: SignalDetectionContext): DetectedSignal[] {
  const signals: DetectedSignal[] = [];
  const { turnMessages, recalledNodes, userText, toolResults, sessionId } = ctx;

  // ── 1. User Correction Detection ──────────────────────────────
  const correctionScore = Math.max(
    ...CORRECTION_PATTERNS_HIGH.map(p => p.test(userText) ? 1.0 : 0),
    ...CORRECTION_PATTERNS_MEDIUM.map(p => p.test(userText) ? 0.6 : 0),
  );

  if (correctionScore > 0) {
    // Try to match with recalled nodes
    const matchedNodes = matchNodesWithText(recalledNodes, userText);
    signals.push({
      type: "user_correction",
      nodeName: matchedNodes[0]?.name ?? null,
      nodeIds: matchedNodes.map(n => n.id),
      confidence: correctionScore,
      triggerText: userText.slice(0, 100),
      messages: turnMessages,
    });
  }

  // ── 2. User Confirmation Detection ──────────────────────────
  const confirmScore = Math.max(
    ...CONFIRM_PATTERNS.map(p => p.test(userText) ? 0.7 : 0),
  );

  if (confirmScore > 0) {
    const matchedNodes = matchNodesWithText(recalledNodes, userText);
    signals.push({
      type: "explicit_confirm",
      nodeName: matchedNodes[0]?.name ?? null,
      nodeIds: matchedNodes.map(n => n.id),
      confidence: confirmScore,
      triggerText: userText.slice(0, 100),
      messages: turnMessages,
    });
  }

  // ── 3. Tool Result Analysis ────────────────────────────────
  for (const tool of toolResults) {
    const matchedNodes = matchNodesWithText(recalledNodes, tool.text);

    if (tool.isError) {
      signals.push({
        type: "tool_error",
        nodeName: matchedNodes[0]?.name ?? null,
        nodeIds: matchedNodes.map(n => n.id),
        confidence: 0.8,
        triggerText: tool.text.slice(0, 100),
        messages: turnMessages,
      });
    } else {
      // Check for success patterns
      const successScore = Math.max(
        ...TOOL_SUCCESS_PATTERNS.map(p => p.test(tool.text) ? 0.7 : 0),
      );
      if (successScore > 0) {
        signals.push({
          type: "tool_success",
          nodeName: matchedNodes[0]?.name ?? null,
          nodeIds: matchedNodes.map(n => n.id),
          confidence: successScore,
          triggerText: tool.text.slice(0, 100),
          messages: turnMessages,
        });
      }
    }
  }

  // ── 4. Recall Feedback ──────────────────────────────────────
  // If nodes were recalled AND user didn't correct, it's implicit "recall_used"
  // If nodes were recalled AND user corrected, it's "recall_rejected"
  if (recalledNodes.length > 0) {
    const hadCorrection = correctionScore > 0;
    const hadConfirm = confirmScore > 0;

    for (const node of recalledNodes) {
      if (hadCorrection) {
        signals.push({
          type: "recall_rejected",
          nodeName: node.name,
          nodeIds: [node.id],
          confidence: 0.6,
          triggerText: userText.slice(0, 80),
          messages: turnMessages,
        });
      } else if (hadConfirm) {
        signals.push({
          type: "recall_used",
          nodeName: node.name,
          nodeIds: [node.id],
          confidence: 0.5,
          triggerText: userText.slice(0, 80),
          messages: turnMessages,
        });
      }
    }
  }

  // Sort by confidence
  signals.sort((a, b) => b.confidence - a.confidence);

  return signals;
}

/**
 * Match recalled nodes against a piece of text.
 * Returns nodes whose name/description/content matches the text.
 */
function matchNodesWithText(nodes: GmNode[], text: string): GmNode[] {
  if (!text.trim() || !nodes.length) return [];

  const textLower = text.toLowerCase();
  const scored: Array<{ node: GmNode; score: number }> = [];

  for (const node of nodes) {
    let score = 0;

    // Name exact match (highest)
    const nameLower = node.name.toLowerCase();
    if (textLower.includes(nameLower)) {
      score = Math.max(score, 0.9);
    }

    // Name variants
    const nameVariants = [
      nameLower.replace(/-/g, " "),
      nameLower.replace(/-/g, ""),
      nameLower.replace(/_/g, "-"),
    ];
    for (const v of nameVariants) {
      if (v.length > 3 && textLower.includes(v)) {
        score = Math.max(score, 0.7);
      }
    }

    // Description match
    if (node.description && node.description.length > 3) {
      const descLower = node.description.toLowerCase();
      // Check for key terms (words >= 4 chars)
      const descWords = descLower.split(/[\s,.，、]+/).filter(w => w.length >= 4);
      const matchedWords = descWords.filter(w => textLower.includes(w));
      if (matchedWords.length > 0) {
        score = Math.max(score, 0.5 * (matchedWords.length / descWords.length));
      }
    }

    if (score > 0) {
      scored.push({ node, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.node);
}

/**
 * Get the weight for a signal type.
 * Higher weight = stronger effect on belief.
 */
export function getSignalWeight(
  type: DetectedSignal["type"]
): number {
  switch (type) {
    case "user_correction":    return 3.0;  // Highest: user explicitly said it's wrong
    case "recall_rejected":    return 2.5;  // High: recalled guidance was wrong
    case "explicit_confirm":   return 2.0;  // High: user explicitly confirmed
    case "tool_error":        return 2.0;  // High: tool failed
    case "recall_used":       return 1.0;  // Medium: guidance was followed
    case "tool_success":       return 1.0;  // Medium: tool succeeded
    default:                   return 1.0;
  }
}

/**
 * Should we emit this signal?
 * Deduplicates and filters low-confidence signals.
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
