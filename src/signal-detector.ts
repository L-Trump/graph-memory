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

/**
 * Patterns that look like corrections but are actually instructions.
 * Checked AFTER correction detection to filter false positives.
 */
const CORRECTION_FALSE_POSITIVE = [
  /不要停|不要中断工具调用|别停/i,   // encouragement to continue, not correction
  /完成前不要中断/i,                 // continuation instruction
];

/**
 * Confirmation patterns (user explicitly agrees)
 * Note: "好" requires word boundary — avoids matching inside "谢谢你的帮助"
 * "谢谢" requires clear context — gratitude ≠ confirmation
 */
const CONFIRM_PATTERNS = [
  // Chinese: explicit confirm at word boundary (positive lookahead)
  /(?:^|[\s,。!?])对的(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])可以(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])好的(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])行(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])行吧(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])好(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])好吧(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])明白(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])知道了(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])正确(?:[\s,。!?]|$)/,
  /(?:^|[\s,。!?])谢谢(?:[\s,。!?]|$)/i,
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
  /好不好|好吗|好不/i,   // question form
  /^呃/im,               // hesitation at line start
  /^那[,.。!?\s]/m,     // "那" at line start → follow-up, not confirm
  /怎么.*\?$|为什么.*\?$/i,  // question ending → not confirm
];

/** Tool error indicators — must be REAL errors, not code snippets containing "error" */
const TOOL_ERROR_PATTERNS = [
  // Structured error responses (OpenClaw tool error format)
  /"status"\s*:\s*"error"/,
  /Error\[ERR_/,                    // Node.js system errors
  /command exited with code [1-9]/, // Non-zero exit codes
  /fatal error/i,
  /permission denied/i,
  /ENOENT|EACCES|EISDIR/,         // Common FS errors
  /未找到|权限不足/i,
  // Explicit failure in tool output (not code context)
  /^(?:Error|FAILED|FAILURE)\b/m,
];

/** Patterns that indicate the text is CODE, not a real error */
const TOOL_ERROR_FALSE_POSITIVE = [
  /```/s,                          // Inside code block → not a real error
  /\bTS\d{4}\b/,                   // TypeScript compiler diagnostics
  /\berror TS\w+\b/,              // TypeScript type errors in code
  /node:internal\/modules/,        // Node internal stack traces (often noise)
  /throw (err|new Error)/,         // Code containing throw statements
  /test\/[^\s]+\.ts\(/,            // Test file references in TS compiler output
  /\.filter\(/,                   // Code containing .filter() calls
  /triggerUncaughtException/,      // Node crash output (noise)
  /package_json_reader/,           // Node internal module
  /const text = `/s,               // Template literal assignments (code)
];

/** Tool success indicators — must be clear operational success */
const TOOL_SUCCESS_PATTERNS = [
  /\[SUCCESS\]|成功|已创建|已删除|已更新|已完成/i,
  /^(?:success|done|completed|ready)\b/im,
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
      
      // Check for real error patterns
      const hasError = TOOL_ERROR_PATTERNS.some(p => p.test(text));
      // Filter out false positives (code snippets, TS diagnostics)
      const isFalsePositive = TOOL_ERROR_FALSE_POSITIVE.some(p => p.test(text));
      const isError = hasError && !isFalsePositive;
      
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
  // Check if any negation pattern fires — gratitude ≠ confirmation
  const negatedByGratitude = NEGATE_CONFIRM_PATTERNS.some(p => p.test(userText));
  const confirmScore = negatedByGratitude
    ? 0
    : Math.max(...CONFIRM_PATTERNS.map(p => p.test(userText) ? 0.7 : 0));

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
 * 
 * Matching strategy:
 * 1. Exact name match (highest score)
 * 2. Chinese keyword overlap (name hyphens → individual chars/words)
 * 3. Description keyword overlap
 * 4. Content keyword overlap (lower weight, noisier)
 */
function matchNodesWithText(nodes: GmNode[], text: string): GmNode[] {
  if (!text.trim() || !nodes.length) return [];

  const textLower = text.toLowerCase();
  const scored: Array<{ node: GmNode; score: number }> = [];

  // Extract meaningful keywords from the user text (Chinese and English)
  const textKeywords = extractKeywords(textLower);

  for (const node of nodes) {
    let score = 0;

    // ── Level 1: Name exact match (highest) ──
    const nameLower = node.name.toLowerCase();
    if (textLower.includes(nameLower)) {
      score = Math.max(score, 0.95);
    }

    // ── Level 2: Name keyword overlap ──
    // e.g. "workspace-external-file-safety-rule" → keywords: workspace, external, file, safety, rule
    // "don't touch files outside workspace" → workspace, file, external → overlap
    const nameParts = nameLower
      .split(/[-_\s]+/)
      .filter(p => p.length >= 2);
    
    if (nameParts.length > 0 && textKeywords.length > 0) {
      const nameOverlap = nameParts.filter(p => textKeywords.includes(p));
      if (nameOverlap.length > 0) {
        const overlapRatio = nameOverlap.length / nameParts.length;
        score = Math.max(score, 0.5 + 0.3 * overlapRatio);
      }
    }

    // ── Level 3: Description keyword overlap ──
    if (node.description && node.description.length > 5) {
      const descKeywords = extractKeywords(node.description.toLowerCase());
      if (descKeywords.length > 0 && textKeywords.length > 0) {
        const descOverlap = descKeywords.filter(k => textKeywords.includes(k));
        if (descOverlap.length > 0) {
          const overlapRatio = descOverlap.length / Math.min(descKeywords.length, 10);
          score = Math.max(score, 0.3 + 0.4 * overlapRatio);
        }
      }
    }

    // ── Level 4: Content keyword overlap (lower weight) ──
    if (node.content && node.content.length > 10 && score < 0.5) {
      const contentLower = node.content.toLowerCase();
      const contentKeywords = extractKeywords(contentLower).slice(0, 30); // Limit to top 30
      if (contentKeywords.length > 0) {
        const contentOverlap = contentKeywords.filter(k => textKeywords.includes(k));
        if (contentOverlap.length >= 2) {
          score = Math.max(score, 0.2 + 0.2 * (contentOverlap.length / contentKeywords.length));
        }
      }
    }

    if (score > 0.3) {
      scored.push({ node, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.node);
}

/**
 * Extract meaningful keywords from text.
 * Handles both English (word split) and Chinese (char bigrams + common words).
 */
function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();

  // English words (>= 3 chars)
  for (const word of text.match(/[a-z]{3,}/g) ?? []) {
    keywords.add(word);
  }

  // Chinese characters: extract common meaningful 2-char combinations
  const chinese = text.replace(/[^\u4e00-\u9fff]/g, "");
  if (chinese.length >= 2) {
    // Bigrams
    for (let i = 0; i < chinese.length - 1; i++) {
      keywords.add(chinese.slice(i, i + 2));
    }
    // Also add common meaningful words (3-4 chars)
    for (let len = 3; len <= 4; len++) {
      for (let i = 0; i <= chinese.length - len; i++) {
        const word = chinese.slice(i, i + len);
        // Only add if it's likely a real word (not random char combo)
        // Simple heuristic: if the word appears multiple times, it's likely meaningful
        if (chinese.split(word).length > 1) {
          keywords.add(word);
        }
      }
    }
  }

  return [...keywords];
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
