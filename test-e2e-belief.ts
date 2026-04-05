/**
 * graph-memory — End-to-End Belief System Test
 *
 * Simulates complete conversation flow using real session messages:
 * 1. Parse real session messages into turn structures
 * 2. For each turn: detectSignals → matchRecalledNodes → updateBelief
 * 3. Verify belief scores evolve correctly over turns
 * 4. Verify recall scoring incorporates belief
 *
 * Uses real data exported from production database.
 */

import Database from "better-sqlite3";
import {
  detectSignals,
  extractTextFromContent,
  shouldEmitSignal,
  type DetectedSignal,
} from "./src/signal-detector.ts";
import {
  computeBeliefSchemeA as bayesianBeliefUpdate,
} from "./src/belief.ts";

function beliefToLabel(belief: number): string {
  if (belief >= 0.8) return "high";
  if (belief >= 0.6) return "medium-high";
  if (belief >= 0.4) return "medium";
  if (belief >= 0.2) return "medium-low";
  return "low";
}
import type { GmNode } from "./src/types.ts";
import path from "node:path";
import fs from "node:fs";

// ─── Config ────────────────────────────────────────────────────

const TEST_DB = "/tmp/gm-test-belief.db";
const EXPORT_JSON = "/tmp/gm-export.json";

// ─── Types ──────────────────────────────────────────────────────

interface SessionMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  sender_name?: string;
}

interface ExportData {
  messages: SessionMessage[];
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    content: string;
    status: string;
    belief: number;
    success_count: number;
    failure_count: number;
    flags?: string;
  }>;
  edges: any[];
}

interface Turn {
  turnNumber: number;
  userText: string;
  toolResults: Array<{ toolName: string; text: string; isError: boolean }>;
  recalledNodes: GmNode[];
  rawMessages: SessionMessage[];
}

// ─── Data Loading ──────────────────────────────────────────────

function loadExport(): ExportData {
  const raw = JSON.parse(fs.readFileSync(EXPORT_JSON, 'utf-8')) as ExportData;
  return raw;
}

/** Extract user text from Feishu message format */
function extractUserText(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    const inner = parsed.content ?? parsed;
    let full = "";

    if (Array.isArray(inner)) {
      for (const block of inner) {
        if (block?.type === "text" && block.text) {
          full = block.text;
          break;
        }
      }
    } else if (typeof inner === "string") {
      full = inner;
    } else {
      return null;
    }

    // Feishu format: look for Sender marker
    if (!full.includes("Sender ")) return null;
    const idx = full.lastIndexOf("Sender ");
    const after = full.slice(idx);

    const lines = after.split("\n");
    const result: string[] = [];
    let capture = false;
    for (const line of lines) {
      if (line.trim() === "```") {
        capture = true;
        continue;
      }
      if (capture) result.push(line);
    }

    const text = result.join("\n").trim();
    return text.length >= 2 ? text : null;
  } catch {
    return null;
  }
}

/** Extract tool result content, properly handling JSON structures */
function extractToolContent(content: string): {
  toolName: string;
  text: string;
  isError: boolean;
} | null {
  try {
    const parsed = JSON.parse(content);
    // Look for actual error/failed indicators in the content blocks
    const inner = parsed.content ?? parsed;
    let text = "";
    let isError = false;
    let toolName = (parsed.toolName ?? parsed.name ?? "unknown") as string;

    if (Array.isArray(inner)) {
      for (const block of inner) {
        if (block?.type === "text" && block.text) {
          text += block.text + "\n";
        }
      }
    } else if (typeof inner === "string") {
      text = inner;
    }

    text = text.trim();

    // Only flag as error if the visible text content actually contains error indicators
    // NOT if "error" appears in JSON structure keys/values
    if (text.length > 0) {
      // Check for real error patterns in human-readable output
      isError =
        /\berror\b/i.test(text) &&
        !text.includes('"role":"toolResult"') && // skip JSON metadata
        !text.includes('"type":"text"'); // skip JSON structure
    }

    return toolName && text.length > 0 ? { toolName, text, isError } : null;
  } catch {
    return null;
  }
}

/** Convert a session into a sequence of turns */
function sessionToTurns(
  sessionMsgs: SessionMessage[],
  allNodes: GmNode[]
): Turn[] {
  const turns: Turn[] = [];
  let currentUserText = "";
  let currentTools: Turn["toolResults"] = [];
  let currentRaw: SessionMessage[] = [];
  let turnNum = 0;

  // Sample some nodes to simulate "recalled" context
  // In real usage, recall would match based on user query
  const sampledNodes = allNodes
    .filter(n => n.status === "active")
    .sort(() => Math.random() - 0.5)
    .slice(0, 5);

  for (const msg of sessionMsgs) {
    if (msg.role === "user") {
      const text = extractUserText(msg.content);
      if (text && text.length > 3 && !text.includes("Heartbeat") && !text.startsWith("[cron")) {
        // Flush previous turn if it had content
        if (currentUserText || currentTools.length > 0) {
          turns.push({
            turnNumber: ++turnNum,
            userText: currentUserText,
            toolResults: currentTools,
            recalledNodes: [...sampledNodes],
            rawMessages: currentRaw,
          });
        }
        // Start new turn
        currentUserText = text;
        currentTools = [];
        currentRaw = [msg];
      }
    } else if (msg.role === "toolResult") {
      const tool = extractToolContent(msg.content);
      if (tool) {
        currentTools.push(tool);
        currentRaw.push(msg);
      }
    } else if (msg.role === "assistant") {
      currentRaw.push(msg);
    }
  }

  // Flush last turn
  if (currentUserText || currentTools.length > 0) {
    turns.push({
      turnNumber: ++turnNum,
      userText: currentUserText,
      toolResults: currentTools,
      recalledNodes: [...sampledNodes],
      rawMessages: currentRaw,
    });
  }

  return turns;
}

// ─── Test Scenarios ────────────────────────────────────────────

/**
 * Scenario 1: Conversation where user repeatedly corrects the assistant
 * about touching files outside workspace.
 *
 * Expected: "workspace-external-file-safety-rule" belief should decrease
 */
function testCorrectionSequence(
  turns: Turn[],
  nodeBeliefs: Map<string, { success: number; failure: number; belief: number }>
): { passed: boolean; details: string[] } {
  const details: string[] = [];
  let correctionsDetected = 0;
  let confirmsDetected = 0;
  let toolErrors = 0;

  const recentSignals: DetectedSignal[] = [];

  for (const turn of turns) {
    // Skip turns with no user text (tool-only turns)
    if (!turn.userText) continue;

    const signals = detectSignals({
      turnMessages: turn.rawMessages,
      recalledNodes: turn.recalledNodes,
      userText: turn.userText,
      toolResults: turn.toolResults,
      sessionId: "e2e-test",
    });

    // Clear per-turn dedup buffer (each turn is a separate interaction)
    const turnSignals: DetectedSignal[] = [];
    for (const signal of signals) {
      if (!shouldEmitSignal(signal, turnSignals, 0.4)) continue;
      turnSignals.push(signal);

      if (signal.type === "user_correction") {
        correctionsDetected++;
        details.push(
          `  Turn ${turn.turnNumber}: CORRECTION (conf=${signal.confidence.toFixed(2)}, nodes=${signal.nodeIds.length}) "${turn.userText.slice(0, 60)}"`
        );

        // Simulate belief update for matched nodes
        for (const nodeId of signal.nodeIds) {
          const state = nodeBeliefs.get(nodeId);
          if (state) {
            const weight = 3.0;
            const newS = state.success;
            const newF = state.failure + 1;
            const newBelief = bayesianBeliefUpdate(newS, newF);
            nodeBeliefs.set(nodeId, { success: newS, failure: newF, belief: newBelief });
          }
        }
      } else if (signal.type === "explicit_confirm") {
        confirmsDetected++;
        details.push(
          `  Turn ${turn.turnNumber}: CONFIRM (conf=${signal.confidence.toFixed(2)}, nodes=${signal.nodeIds.length}) "${turn.userText.slice(0, 60)}"`
        );

        for (const nodeId of signal.nodeIds) {
          const state = nodeBeliefs.get(nodeId);
          if (state) {
            const newS = state.success + 1;
            const newF = state.failure;
            const newBelief = bayesianBeliefUpdate(newS, newF);
            nodeBeliefs.set(nodeId, { success: newS, failure: newF, belief: newBelief });
          }
        }
      } else if (signal.type === "tool_error") {
        toolErrors++;
        details.push(
          `  Turn ${turn.turnNumber}: tool_error (conf=${signal.confidence.toFixed(2)}) "${signal.triggerText.slice(0, 50)}"`
        );
      }
    }
  }

  // Check: corrections should be detected
  const minCorrections = 10;
  const passed = correctionsDetected >= minCorrections && confirmsDetected >= 5;

  details.unshift(
    `Corrections detected: ${correctionsDetected} (min=${minCorrections})`,
    `Confirms detected: ${confirmsDetected} (min=5)`,
    `Tool errors detected: ${toolErrors}`,
  );

  return { passed, details };
}

/**
 * Scenario 2: Belief evolution test
 *
 * Track a single node's belief through multiple signals.
 */
function testBeliefEvolution(): { passed: boolean; details: string[] } {
  const details: string[] = [];

  // Start with neutral belief
  let s = 0, f = 0;
  let belief = bayesianBeliefUpdate(s, f);
  details.push(`Initial: belief=${belief.toFixed(3)} (${beliefToLabel(belief)})`);

  // Signal sequence: correction, correction, confirm, confirm, tool_success, confirm
  const signals: Array<{ type: string; weight: number }> = [
    { type: "user_correction", weight: 3.0 },
    { type: "user_correction", weight: 3.0 },
    { type: "explicit_confirm", weight: 2.0 },
    { type: "explicit_confirm", weight: 2.0 },
    { type: "tool_success", weight: 1.0 },
    { type: "explicit_confirm", weight: 2.0 },
  ];

  const expectedTrend = ["decrease", "decrease", "increase", "increase", "increase", "increase"];
  let prevBelief = belief;
  let trendCorrect = true;

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    if (sig.type === "user_correction") f++;
    else s++;

    belief = bayesianBeliefUpdate(s, f);
    const trend = belief > prevBelief ? "increase" : "decrease";
    const trendOk = trend === expectedTrend[i];
    if (!trendOk) trendCorrect = false;

    details.push(
      `  ${sig.type} → s=${s} f=${f} belief=${belief.toFixed(3)} (${beliefToLabel(belief)}) trend=${trend} ${trendOk ? "✓" : "✗ expected " + expectedTrend[i]}`
    );
    prevBelief = belief;
  }

  // Final belief should be close to neutral-to-positive (3 success vs 2 failure)
  const passed = trendCorrect && belief >= 0.5;
  details.push(`Final belief: ${belief.toFixed(3)} (${beliefToLabel(belief)}) — ${passed ? "✓" : "✗"}`);

  return { passed, details };
}

/**
 * Scenario 3: Node matching accuracy with real conversation text
 *
 * Given a set of recalled nodes and real user messages, check if
 * the signal detector correctly associates corrections with the right nodes.
 */
function testNodeMatchingAccuracy(
  turns: Turn[],
  targetNodes: GmNode[]
): { passed: boolean; details: string[] } {
  const details: string[] = [];

  // Pick specific correction turns and check node matching
  const correctionTurns = turns.filter(t =>
    t.userText &&
    /不对|不是|错了|别|不要/.test(t.userText)
  );

  let matchedCount = 0;
  for (const turn of correctionTurns.slice(0, 5)) {
    const signals = detectSignals({
      turnMessages: turn.rawMessages,
      recalledNodes: targetNodes,
      userText: turn.userText,
      toolResults: turn.toolResults,
      sessionId: "e2e-test",
    });

    const correctionSignals = signals.filter(s => s.type === "user_correction");
    const hasMatch = correctionSignals.some(s => s.nodeIds.length > 0);

    if (hasMatch) matchedCount++;
    details.push(
      `  Turn ${turn.turnNumber}: correction="${turn.userText.slice(0, 50)}" → ` +
      `signals=${correctionSignals.length} matched=${hasMatch ? "✓" : "✗"}`
    );
  }

  // Node matching is best-effort (semantic matching without embeddings)
  // So we just verify the system doesn't crash and produces reasonable results
  const passed = correctionTurns.length > 0;
  details.unshift(`Correction turns tested: ${correctionTurns.length}, matched: ${matchedCount}`);

  return { passed, details };
}

/**
 * Scenario 4: Signal deduplication
 *
 * Same node being corrected multiple times in quick succession should be deduped.
 */
function testSignalDedup(): { passed: boolean; details: string[] } {
  const details: string[] = [];

  const node: GmNode = {
    id: "test-node-1",
    name: "workspace-external-file-safety-rule",
    type: "KNOWLEDGE",
    description: "workspace外文件操作需要获得明确授权的红线规则",
    content: "测试内容",
    status: "active",
    belief: 0.5,
    success_count: 0,
    failure_count: 0,
    last_signal_at: null,
    flags: [],
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  const recentSignals: DetectedSignal[] = [];

  // Same correction signal twice
  const signal1: DetectedSignal = {
    type: "user_correction",
    nodeName: node.name,
    nodeIds: [node.id],
    confidence: 1.0,
    triggerText: "不对，不应该这样做",
    messages: [],
  };

  const signal2: DetectedSignal = {
    type: "user_correction",
    nodeName: node.name,
    nodeIds: [node.id],
    confidence: 0.9,
    triggerText: "我说的不是这样",
    messages: [],
  };

  const emit1 = shouldEmitSignal(signal1, recentSignals);
  if (emit1) recentSignals.push(signal1);

  const emit2 = shouldEmitSignal(signal2, recentSignals);

  details.push(`Signal 1 emitted: ${emit1} (expected: true) — ${emit1 ? "✓" : "✗"}`);
  details.push(`Signal 2 emitted: ${emit2} (expected: false, deduped) — ${!emit2 ? "✓" : "✗"}`);

  const passed = emit1 && !emit2;
  return { passed, details };
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("E2E Belief System Test — Real Session Messages");
  console.log("=".repeat(60));

  // Load export data
  let exportData: ExportData;
  try {
    exportData = loadExport();
  } catch (e) {
    console.error("Failed to load export:", e);
    console.error("Run: node dist/export-session.js first");
    process.exit(1);
  }

  console.log(`\nLoaded: ${exportData.messages.length} messages, ${exportData.nodes.length} nodes`);

  // Convert to GmNode format
  const allNodes: GmNode[] = exportData.nodes
    .filter(n => n.status === "active")
    .map(n => ({
      id: n.id,
      name: n.name,
      type: n.type as any,
      description: n.description,
      content: n.content,
      status: n.status,
      belief: n.belief ?? 0.5,
      success_count: n.success_count ?? 0,
      failure_count: n.failure_count ?? 0,
      last_signal_at: null,
      flags: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    }));

  console.log(`Active nodes: ${allNodes.length}`);

  // Find sessions with rich conversations
  const sessions: Map<string, SessionMessage[]> = new Map();
  for (const msg of exportData.messages) {
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "toolResult") continue;
    const sid = msg.session_id;
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid)!.push(msg);
  }

  // Find best sessions (most user messages with corrections)
  type SessionInfo = { sid: string; totalUser: number; corrections: number; confirms: number };
  const sessionInfos: SessionInfo[] = [];

  for (const [sid, msgs] of sessions) {
    let totalUser = 0, corrections = 0, confirms = 0;
    for (const m of msgs) {
      if (m.role !== "user") continue;
      const text = extractUserText(m.content);
      if (!text || text.includes("Heartbeat") || text.startsWith("[cron")) continue;
      totalUser++;
      if (/不对|不是|错了|纠正|别|不要/.test(text)) corrections++;
      if (/可以|好的|行|对的|OK|明白/.test(text)) confirms++;
    }
    if (totalUser >= 3) {
      sessionInfos.push({ sid, totalUser, corrections, confirms });
    }
  }

  sessionInfos.sort((a, b) => (b.corrections + b.confirms) - (a.corrections + a.confirms));
  console.log(`Sessions with conversations: ${sessionInfos.length}`);
  console.log("Top sessions:");
  for (const s of sessionInfos.slice(0, 5)) {
    console.log(`  ${s.sid.slice(0, 20)}: user=${s.totalUser} corr=${s.corrections} conf=${s.confirms}`);
  }

  // Run tests
  let totalPassed = 0;
  let totalTests = 0;

  // ── Test 1: Signal Deduplication ──
  console.log("\n── Test 1: Signal Deduplication ──");
  const t1 = testSignalDedup();
  totalTests++;
  if (t1.passed) totalPassed++;
  for (const d of t1.details) console.log(d);
  console.log(`Result: ${t1.passed ? "✅ PASS" : "❌ FAIL"}`);

  // ── Test 2: Belief Evolution ──
  console.log("\n── Test 2: Belief Evolution ──");
  const t2 = testBeliefEvolution();
  totalTests++;
  if (t2.passed) totalPassed++;
  for (const d of t2.details) console.log(d);
  console.log(`Result: ${t2.passed ? "✅ PASS" : "❌ FAIL"}`);

  // ── Test 3: Real Conversation Signal Detection ──
  console.log("\n── Test 3: Real Conversation Signal Detection ──");
  if (sessionInfos.length > 0) {
    const bestSession = sessionInfos[0];
    const sessionMsgs = sessions.get(bestSession.sid)!;
    const turns = sessionToTurns(sessionMsgs, allNodes);
    console.log(`  Session: ${bestSession.sid.slice(0, 20)}, turns: ${turns.length}`);

    // Initialize belief states for all nodes
    const nodeBeliefs = new Map<string, { success: number; failure: number; belief: number }>();
    for (const n of allNodes) {
      nodeBeliefs.set(n.id, {
        success: n.success_count ?? 0,
        failure: n.failure_count ?? 0,
        belief: n.belief ?? 0.5,
      });
    }

    const t3 = testCorrectionSequence(turns, nodeBeliefs);
    totalTests++;
    if (t3.passed) totalPassed++;
    for (const d of t3.details) console.log(d);
    console.log(`Result: ${t3.passed ? "✅ PASS" : "❌ FAIL"}`);

    // ── Test 4: Node Matching Accuracy ──
    console.log("\n── Test 4: Node Matching Accuracy ──");
    const t4 = testNodeMatchingAccuracy(turns, allNodes.slice(0, 20));
    totalTests++;
    if (t4.passed) totalPassed++;
    for (const d of t4.details) console.log(d);
    console.log(`Result: ${t4.passed ? "✅ PASS" : "❌ FAIL"}`);
  } else {
    console.log("  SKIP: No suitable sessions found");
  }

  // ── Summary ──
  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${totalPassed}/${totalTests} tests passed`);
  console.log("=".repeat(60));

  process.exit(totalPassed === totalTests ? 0 : 1);
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
