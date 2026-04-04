/**
 * graph-memory — Belief System Integration Test
 *
 * Tests the full signal detection → belief update pipeline.
 */

import { DatabaseSync } from "@photostructure/sqlite";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import {
  detectSignals,
  extractTextFromContent,
  getSignalWeight,
  shouldEmitSignal,
} from "./src/signal-detector.ts";
import {
  updateNodeBelief,
  recordBeliefSignal,
  findByName,
} from "./src/store/store.ts";
import { getDb, closeDb } from "./src/store/db.ts";

// ─── Test DB Setup ──────────────────────────────────────────────

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

// Load from JSON export
const EXPORT_FILE = "/tmp/gm-export.json";
let exportData: any;
try {
  const raw = readFileSync(EXPORT_FILE, "utf-8");
  exportData = JSON.parse(raw);
} catch (e) {
  console.error("⚠️  Cannot load export file:", e);
  console.log("Run: python3 export-gm-data.py (or the inline export command)");
  process.exit(1);
}

const TEST_DB = "/tmp/gm-test-belief-int.db";
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

const db = getDb(`file:${TEST_DB}`);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA foreign_keys=ON");

// Build schema with belief
db.exec(`
  CREATE TABLE gm_nodes (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', validated_count INTEGER NOT NULL DEFAULT 1,
    source_sessions TEXT NOT NULL DEFAULT '[]', community_id TEXT,
    pagerank REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    flags TEXT NOT NULL DEFAULT '[]',
    belief REAL NOT NULL DEFAULT 0.5, success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0, last_signal_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX ux_gm_nodes_name ON gm_nodes(name);

  CREATE TABLE gm_edges (
    id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL, created_at INTEGER NOT NULL
  );

  CREATE TABLE gm_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, extracted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE gm_belief_signals (
    id TEXT PRIMARY KEY, node_id TEXT NOT NULL, node_name TEXT NOT NULL,
    signal_type TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1.0,
    context TEXT NOT NULL DEFAULT '{}', session_id TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);

// Insert test nodes
const testNodes = [
  { id: "n1", name: "workspace-external-file-safety-rule", type: "KNOWLEDGE", content: "workspace外操作需确认", description: "workspace外文件操作要授权" },
  { id: "n2", name: "nixos-system-config-modification-rules", type: "KNOWLEDGE", content: "NixOS配置修改需询问", description: "NixOS配置修改要确认" },
  { id: "n3", name: "graph-memory-development-directory-rule", type: "KNOWLEDGE", content: "开发在Codes目录", description: "graph-memory开发在Codes目录" },
];

const insertNode = db.prepare(`
  INSERT INTO gm_nodes (id, type, name, description, content, status, validated_count,
    source_sessions, pagerank, created_at, updated_at, flags, belief, success_count, failure_count, last_signal_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
for (const n of testNodes) {
  insertNode.run(n.id, n.type, n.name, n.description, n.content, "active", 1,
    "[]", 0, Date.now(), Date.now(), "[]", 0.5, 0, 0, 0);
}

// ─── Test Cases ─────────────────────────────────────────────────

interface TestCase {
  name: string;
  userText: string;
  recalledNodes: any[];
  expectedSignals: number;
  expectedTypes: string[];
}

const testCases: TestCase[] = [
  {
    name: "User correction: '不对，不是这样的'",
    userText: "不对，workspace外操作不是这样处理的，你没有先问我。",
    recalledNodes: testNodes.map(n => ({ id: n.id, name: n.name, description: n.description, content: n.content })),
    expectedSignals: 1,
    expectedTypes: ["user_correction"],
  },
  {
    name: "User confirmation: '对的，NixOS配置修改确实要问我'",
    userText: "对的，NixOS配置修改确实要问我确认。",
    recalledNodes: testNodes.map(n => ({ id: n.id, name: n.name, description: n.description, content: n.content })),
    expectedSignals: 1,
    expectedTypes: ["explicit_confirm"],
  },
  {
    name: "Tool error: recall_used then tool fails",
    userText: "用 graph-memory 开发规则来处理",
    recalledNodes: testNodes.map(n => ({ id: n.id, name: n.name, description: n.description, content: n.content })),
    expectedSignals: 1,
    expectedTypes: ["recall_used"],
  },
  {
    name: "Multiple corrections",
    userText: "你搞错了，workspace外操作要确认这个规则你违反了两次。",
    recalledNodes: testNodes.map(n => ({ id: n.id, name: n.name, description: n.description, content: n.content })),
    expectedSignals: 2,
    expectedTypes: ["user_correction"],
  },
  {
    name: "No signal: casual conversation",
    userText: "今天天气真好。",
    recalledNodes: testNodes.map(n => ({ id: n.id, name: n.name, description: n.description, content: n.content })),
    expectedSignals: 0,
    expectedTypes: [],
  },
];

// ─── Run Tests ─────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║    Graph Memory Belief System — Integration Test          ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  console.log(`🧪 ${tc.name}`);
  console.log(`   User: "${tc.userText.slice(0, 60)}${tc.userText.length > 60 ? "..." : ""}"`);

  const signals = detectSignals({
    turnMessages: [],
    recalledNodes: tc.recalledNodes,
    userText: tc.userText,
    toolResults: [],
    sessionId: "test-session",
  });

  const emitFiltered = signals.filter(s => shouldEmitSignal(s, [], 0.5));
  const typeNames = emitFiltered.map(s => s.type);
  const nodeNames = emitFiltered.map(s => s.nodeName).filter(Boolean);

  const typeMatch = tc.expectedTypes.length === typeNames.length &&
    tc.expectedTypes.every(t => typeNames.includes(t));

  if (emitFiltered.length === tc.expectedSignals && typeMatch) {
    console.log(`   ✅ PASS — ${emitFiltered.length} signal(s): ${typeNames.join(", ")} ${nodeNames.length ? `→ ${nodeNames.join(", ")}` : ""}`);
    passed++;
  } else {
    console.log(`   ❌ FAIL — Expected ${tc.expectedSignals} signal(s) [${tc.expectedTypes.join(", ")}], got ${emitFiltered.length}: ${typeNames.join(", ")} ${nodeNames.length ? `→ ${nodeNames.join(", ")}` : ""}`);
    failed++;
  }

  if (signals.length > 0) {
    console.log(`   📋 All detected (before dedup): ${signals.map(s => `${s.type}(${s.confidence.toFixed(2)})@${s.nodeName ?? "?"}`).join(", ")}`);
  }
  console.log();
}

// ─── Belief Update Test ────────────────────────────────────────

console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║              Belief Update Tests                          ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

// Test belief updates
const beliefTests = [
  { nodeName: "n1", signalType: "user_correction", expectedDelta: "< 0", description: "user_correction should decrease belief" },
  { nodeName: "n2", signalType: "explicit_confirm", expectedDelta: "> 0", description: "explicit_confirm should increase belief" },
  { nodeName: "n3", signalType: "tool_success", expectedDelta: "> 0", description: "tool_success should increase belief" },
  { nodeName: "n1", signalType: "tool_error", expectedDelta: "< 0", description: "tool_error should decrease belief" },
];

for (const bt of beliefTests) {
  const node = findByName(db, bt.nodeName);
  if (!node) { console.log(`  ❌ Node not found: ${bt.nodeName}`); continue; }

  const before = (db.prepare("SELECT belief FROM gm_nodes WHERE id=?").get(node.id) as any)?.belief ?? 0.5;
  const result = updateNodeBelief(db, node.id, bt.signalType as any);
  const after = (db.prepare("SELECT belief FROM gm_nodes WHERE id=?").get(node.id) as any)?.belief ?? 0.5;

  const delta = after - before;
  const signCorrect = (bt.expectedDelta === "> 0" && delta > 0) || (bt.expectedDelta === "< 0" && delta < 0) || (bt.expectedDelta === "= 0" && delta === 0);

  if (signCorrect) {
    console.log(`  ✅ ${bt.nodeName} + ${bt.signalType}: ${before.toFixed(3)} → ${after.toFixed(3)} (Δ=${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`);
    passed++;
  } else {
    console.log(`  ❌ ${bt.nodeName} + ${bt.signalType}: ${before.toFixed(3)} → ${after.toFixed(3)} (Δ=${delta.toFixed(3)}) — ${bt.description}`);
    failed++;
  }
}

// ─── Signal Weight Test ────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║              Signal Weight Test                           ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

const weights = [
  { type: "user_correction", expectedMin: 2.5 },
  { type: "recall_rejected", expectedMin: 2.0 },
  { type: "explicit_confirm", expectedMin: 1.5 },
  { type: "tool_error", expectedMin: 1.5 },
  { type: "recall_used", expectedMin: 0.8 },
  { type: "tool_success", expectedMin: 0.8 },
];

for (const w of weights) {
  const weight = getSignalWeight(w.type as any);
  const ok = weight >= w.expectedMin;
  console.log(`  ${ok ? "✅" : "❌"} ${w.type}: weight=${weight.toFixed(1)} ${ok ? "" : `(expected >= ${w.expectedMin})`}`);
  if (ok) passed++; else failed++;
}

// ─── Summary ──────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log(`║  Results: ${passed} passed, ${failed} failed                              ║`);
console.log("╚══════════════════════════════════════════════════════════════╝");

db.close();
process.exit(failed > 0 ? 1 : 0);
