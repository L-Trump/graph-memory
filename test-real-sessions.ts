/**
 * graph-memory — Real Session Signal Detection Test
 *
 * Uses REAL user messages from gm_messages table to verify
 * signal detection accuracy.
 *
 * Key insight: Feishu messages store actual user text AFTER the
 * Sender JSON block. We extract lines after "```" closing the sender.
 */

import { readFileSync } from "fs";
import {
  detectSignals,
  shouldEmitSignal,
} from "./src/signal-detector.ts";

// ─── Load Real Data ────────────────────────────────────────────

const EXPORT_FILE = "/tmp/gm-export.json";
let exportData: any;
try {
  const raw = readFileSync(EXPORT_FILE, "utf-8");
  exportData = JSON.parse(raw);
} catch (e) {
  console.error("⚠️  Cannot load export file:", e);
  process.exit(1);
}

const messages: any[] = exportData.messages;
const nodes: any[] = exportData.nodes;

console.log(`Loaded: ${messages.length} messages, ${nodes.length} nodes\n`);

// ─── Robust User Text Extractor ────────────────────────────────

function extractUserText(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed.content ?? parsed;
    let full = "";
    if (Array.isArray(inner)) {
      for (const block of inner) {
        if (block?.type === "text") {
          full = block.text ?? "";
          break;
        }
      }
    } else if (typeof inner === "string") {
      full = inner;
    } else {
      return null;
    }

    // User text is after the closing ``` of the Sender JSON block
    const senderIdx = full.lastIndexOf("Sender ");
    if (senderIdx < 0) return null;

    const afterSender = full.slice(senderIdx);
    const lines = afterSender.split("\n");

    const result: string[] = [];
    let capture = false;

    for (const line of lines) {
      // Start capturing after the closing ```
      if (line.trim() === "```") {
        capture = true;
        continue;
      }
      if (capture) {
        result.push(line);
      }
    }

    const text = result.join("\n").trim();
    return text.length >= 2 ? text : null;
  } catch {
    return null;
  }
}

// ─── Load Real Nodes ────────────────────────────────────────────

const realNodes = nodes.map((n: any) => ({
  id: n.id,
  name: n.name,
  type: n.type,
  description: n.description ?? "",
  content: n.content ?? "",
  status: n.status ?? "active",
  flags: JSON.parse(n.flags ?? "[]"),
  pagerank: n.pagerank ?? 0,
  validatedCount: n.validated_count ?? 0,
  belief: n.belief ?? 0.5,
  successCount: n.success_count ?? 0,
  failureCount: n.failure_count ?? 0,
}));

// ─── Build Test Scenarios from Real Messages ──────────────────

interface TestScenario {
  userText: string;
  expectedSignal: "correction" | "confirm" | "none";
  keyword: string;
}

const scenarios: TestScenario[] = [];

// Keywords for each category
const correctionKw = [
  "不对", "不是", "错了", "纠正", "取消", "停", "别",
  "wrong", "incorrect", "not right",
];
const confirmKw = [
  "对的", "可以", "好", "行", "明白了", "谢谢", "好的", "正确",
  "ok", "yes", "correct",
];
const safeKw = [
  "天气", "日程", "文件", "哪里", "查一下", "帮我",
];

const seen = new Set<string>();

for (const m of messages) {
  if (m.role !== "user") continue;

  const raw = String(m.content ?? "");
  if (!raw.includes("oc_d050f2d80f167097736186e7d9e744ea")) continue;

  const userText = extractUserText(raw);
  if (!userText || userText.length < 3) continue;

  // Skip system/cron messages
  if (
    userText.includes("Heartbeat") ||
    userText.startsWith("[cron") ||
    userText.startsWith("Pre-compaction") ||
    userText.startsWith("[Sun") ||
    userText.startsWith("<<<")
  )
    continue;

  const key = userText.slice(0, 40);
  if (seen.has(key)) continue;

  let expectedSignal: "correction" | "confirm" | "none" = "none";
  let keyword = "";

  for (const kw of correctionKw) {
    if (userText.includes(kw)) {
      expectedSignal = "correction";
      keyword = kw;
      break;
    }
  }
  if (!expectedSignal) {
    for (const kw of confirmKw) {
      if (userText.includes(kw)) {
        expectedSignal = "confirm";
        keyword = kw;
        break;
      }
    }
  }

  // Only add scenarios with clear signal or clearly safe
  if (expectedSignal !== "none") {
    seen.add(key);
    scenarios.push({ userText, expectedSignal, keyword });
  } else if (userText.length > 5) {
    // Safe messages with no signal keywords
    let hasSafe = safeKw.some((kw) => userText.includes(kw));
    if (hasSafe) {
      seen.add(key);
      scenarios.push({ userText, expectedSignal: "none", keyword: "" });
    }
  }

  if (scenarios.length >= 40) break;
}

console.log(`Built ${scenarios.length} real test scenarios\n`);

// ─── Run Tests ─────────────────────────────────────────────────

console.log(
  "╔══════════════════════════════════════════════════════════════╗\n" +
  "║   Real Session Signal Detection Tests                    ║\n" +
  "╚══════════════════════════════════════════════════════════════╝\n"
);

let tp = 0, fp = 0, fn = 0;

const corrections = scenarios.filter((s) => s.expectedSignal === "correction");
const confirms = scenarios.filter((s) => s.expectedSignal === "confirm");
const safe = scenarios.filter((s) => s.expectedSignal === "none");

console.log(`CORRECTION scenarios: ${corrections.length}`);
for (const sc of corrections.slice(0, 15)) {
  const detected = detectSignals({
    turnMessages: [],
    recalledNodes: realNodes.slice(0, 5),
    userText: sc.userText,
    toolResults: [],
    sessionId: "test",
  });
  const filtered = detected.filter((s) => shouldEmitSignal(s, [], 0.5));
  const hasCorrection = filtered.some(
    (s) => s.type === "user_correction" || s.type === "recall_rejected"
  );
  const status = hasCorrection ? "✅" : "❌";
  console.log(
    `  ${status} [CORRECTION] "${sc.keyword}" | ${sc.userText.slice(0, 60)}...`
  );
  if (filtered.length > 0) {
    console.log(
      `     Signals: ${filtered.map((s) => `${s.type}(${s.confidence.toFixed(2)})`).join(", ")}`
    );
  }
  if (hasCorrection) tp++;
  else fp++;
}

console.log(`\nCONFIRM scenarios: ${confirms.length}`);
for (const sc of confirms.slice(0, 10)) {
  const detected = detectSignals({
    turnMessages: [],
    recalledNodes: realNodes.slice(0, 5),
    userText: sc.userText,
    toolResults: [],
    sessionId: "test",
  });
  const filtered = detected.filter((s) => shouldEmitSignal(s, [], 0.5));
  const hasConfirm = filtered.some(
    (s) => s.type === "explicit_confirm" || s.type === "recall_used"
  );
  const status = hasConfirm ? "✅" : "❌";
  console.log(
    `  ${status} [CONFIRM] "${sc.keyword}" | ${sc.userText.slice(0, 60)}...`
  );
  if (filtered.length > 0) {
    console.log(
      `     Signals: ${filtered.map((s) => `${s.type}(${s.confidence.toFixed(2)})`).join(", ")}`
    );
  }
  if (hasConfirm) tp++;
  else fp++;
}

console.log(`\nSAFE (no signal expected) scenarios: ${safe.length}`);
for (const sc of safe.slice(0, 8)) {
  const detected = detectSignals({
    turnMessages: [],
    recalledNodes: realNodes.slice(0, 5),
    userText: sc.userText,
    toolResults: [],
    sessionId: "test",
  });
  const filtered = detected.filter((s) => shouldEmitSignal(s, [], 0.5));
  const hadSignal = filtered.length > 0;
  const status = hadSignal ? "❌" : "✅";
  console.log(
    `  ${status} "${sc.userText.slice(0, 60)}" → ${hadSignal ? "UNEXPECTED: " + filtered.map((s) => s.type).join(", ") : "✅ no signal"}`
  );
  if (!hadSignal) tp++;
  else fp++;
}

// ─── Summary ──────────────────────────────────────────────────

const total = tp + fp + fn;
const accuracy = total > 0 ? (tp / total) * 100 : 0;

console.log(
  "\n╔══════════════════════════════════════════════════════════════╗\n" +
  `║  Results: ${tp} correct / ${fp} wrong / ${fn} missed               ║\n` +
  `║  Accuracy: ${accuracy.toFixed(1)}%                                   ║\n` +
  "╚══════════════════════════════════════════════════════════════╝"
);
