/**
 * graph-memory — Belief System Test Harness
 *
 * Tests all belief schemes against the REAL production database.
 * Populates the test DB with real nodes from production, then runs belief experiments.
 */

import { DatabaseSync } from "@photostructure/sqlite";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";

// ─── SQLite Helpers ─────────────────────────────────────────────

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
import { homedir } from "os";

// ─── SQLite Helpers ─────────────────────────────────────────────

function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

function resolvePath(p: string): string {
  return p.replace(/^~\//, homedir());
}

// ─── Load Data from JSON Export ─────────────────────────────────

const EXPORT_FILE = "/tmp/gm-export.json";
console.log(`📂 Loading data from: ${EXPORT_FILE}`);

interface ExportData {
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    description: string;
    content: string;
    status: string;
    validated_count: number;
    source_sessions: string;
    community_id: string | null;
    pagerank: number;
    flags: string;
    created_at: number;
    updated_at: number;
  }>;
  edges: Array<{
    id: string;
    from_id: string;
    to_id: string;
    name: string;
    description: string;
    session_id: string;
    created_at: number;
  }>;
  messages: Array<{
    id: string;
    session_id: string;
    turn_index: number;
    role: string;
    content: string;
    extracted: number;
    created_at: number;
  }>;
}

let exportData: ExportData;
try {
  const raw = readFileSync(EXPORT_FILE, "utf-8");
  exportData = JSON.parse(raw);
} catch (e) {
  console.error(`❌ Failed to load export file: ${e}`);
  process.exit(1);
}

const prodNodes = exportData.nodes;
const prodEdges = exportData.edges;
const prodMessages = exportData.messages;

console.log(`\n📊 Loaded from production DB:`);
console.log(`  Nodes: ${prodNodes.length}`);
console.log(`  Edges: ${prodEdges.length}`);
console.log(`  Messages: ${prodMessages.length}`);

// ─── Setup Test DB ─────────────────────────────────────────────

const TEST_DB_PATH = "/tmp/gm-test-belief.db";
if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
const testDb = openDb(TEST_DB_PATH);

// Build schema
testDb.exec(`
  CREATE TABLE gm_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    validated_count INTEGER NOT NULL DEFAULT 1,
    source_sessions TEXT NOT NULL DEFAULT '[]',
    community_id TEXT,
    pagerank REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    flags TEXT NOT NULL DEFAULT '[]',
    belief REAL NOT NULL DEFAULT 0.5,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_signal_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX ux_gm_nodes_name ON gm_nodes(name);
  CREATE INDEX ix_gm_nodes_type_status ON gm_nodes(type, status);

  CREATE TABLE gm_edges (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ix_gm_edges_from ON gm_edges(from_id);
  CREATE INDEX ix_gm_edges_to ON gm_edges(to_id);

  CREATE TABLE gm_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    extracted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ix_gm_msg_session ON gm_messages(session_id, turn_index);

  CREATE TABLE gm_belief_signals (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    context TEXT NOT NULL DEFAULT '{}',
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ix_belief_sig_node ON gm_belief_signals(node_id, created_at);
  CREATE INDEX ix_belief_sig_session ON gm_belief_signals(session_id);

  CREATE TABLE gm_recall_feedback (
    id TEXT PRIMARY KEY,
    recall_query TEXT NOT NULL,
    recall_session TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    outcome TEXT NOT NULL,
    belief_after REAL NOT NULL,
    belief_before REAL NOT NULL,
    signal_emitted TEXT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

console.log(`\n📂 Test DB: ${TEST_DB_PATH}`);

// ─── Copy Data to Test DB ──────────────────────────────────────

console.log("\n🔄 Populating test DB...");

const insertNode = testDb.prepare(`
  INSERT INTO gm_nodes (id, type, name, description, content, status, validated_count,
    source_sessions, community_id, pagerank, flags, created_at, updated_at,
    belief, success_count, failure_count, last_signal_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
testDb.exec("BEGIN");
for (const n of prodNodes) {
  insertNode.run(
    n.id, n.type, n.name, n.description, n.content, n.status, n.validated_count,
    n.source_sessions, n.community_id, n.pagerank, n.flags, n.created_at, n.updated_at,
    0.5, 0, 0, 0
  );
}
testDb.exec("COMMIT");
console.log(`  Nodes: ${prodNodes.length} (including deprecated)`);

const insertEdge = testDb.prepare(`
  INSERT INTO gm_edges (id, from_id, to_id, name, description, session_id, created_at)
  VALUES (?,?,?,?,?,?,?)
`);
testDb.exec("BEGIN");
for (const e of prodEdges) {
  insertEdge.run(e.id, e.from_id, e.to_id, e.name, e.description, e.session_id, e.created_at);
}
testDb.exec("COMMIT");
console.log(`  Edges: ${prodEdges.length}`);

const insertMsg = testDb.prepare(`
  INSERT INTO gm_messages (id, session_id, turn_index, role, content, extracted, created_at)
  VALUES (?,?,?,?,?,?,?)
`);
testDb.exec("BEGIN");
for (const m of prodMessages) {
  insertMsg.run(m.id, m.session_id, m.turn_index, m.role, m.content, m.extracted, m.created_at);
}
testDb.exec("COMMIT");
console.log(`  Messages: ${prodMessages.length}`);

console.log("\n✅ Test DB ready!");

// ─── Belief System Core ─────────────────────────────────────────

type BeliefSignalType =
  | "tool_success" | "tool_error" | "user_correction" | "explicit_confirm"
  | "recall_used" | "recall_rejected" | "belief_increase" | "belief_decrease" | "initial";

function uid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// Beta-Bayesian Count: belief = (α + s) / (α + β + s + f)
function beliefA(successCount: number, failureCount: number): number {
  const α = 1, β = 1;
  return (α + successCount) / (α + β + successCount + failureCount);
}

// Exponential Moving Average
function beliefB(currentBelief: number, signal: number, λ = 0.85): number {
  const newBelief = λ * currentBelief + (1 - λ) * (signal > 0 ? 1 : signal < 0 ? 0 : 0.5);
  return Math.max(0, Math.min(1, newBelief));
}

// Weighted Bayesian with Recency
function beliefC(signals: Array<{ weight: number; createdAt: number; isPositive: boolean }>, λ = 0.1): number {
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
  return Math.max(0.05, Math.min(0.95, 1 / (1 + Math.exp(-weightedSum))));
}

function getBeliefInfo(db: DatabaseSync, nodeId: string) {
  const row = db.prepare(
    "SELECT belief, success_count, failure_count FROM gm_nodes WHERE id=?"
  ).get(nodeId) as any;
  return row ? { belief: row.belief, successCount: row.success_count, failureCount: row.failure_count } : null;
}

function findNodeByName(db: DatabaseSync, name: string) {
  return db.prepare("SELECT * FROM gm_nodes WHERE name=?").get(normalizeName(name)) as any;
}

function recordSignal(db: DatabaseSync, nodeId: string, nodeName: string, signalType: BeliefSignalType, sessionId: string, weight = 1.0) {
  db.prepare(`
    INSERT INTO gm_belief_signals (id, node_id, node_name, signal_type, weight, context, session_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(uid("bsig"), nodeId, nodeName, signalType, weight, "{}", sessionId, Date.now());
}

function applyBeliefUpdate(db: DatabaseSync, nodeId: string, scheme: string, signalType?: BeliefSignalType): { before: number; after: number; delta: number } | null {
  const info = getBeliefInfo(db, nodeId);
  if (!info) return null;
  const before = info.belief;
  let newSuccess = info.successCount;
  let newFailure = info.failureCount;

  if (signalType) {
    const pos = ["tool_success", "explicit_confirm", "recall_used", "belief_increase", "initial"].includes(signalType);
    const neg = ["tool_error", "user_correction", "recall_rejected", "belief_decrease"].includes(signalType);
    if (pos) newSuccess++;
    else if (neg) newFailure++;
  }

  let after: number;
  if (scheme === "A") {
    after = beliefA(newSuccess, newFailure);
  } else if (scheme === "B") {
    let signal = 0;
    if (signalType) {
      if (["tool_success", "explicit_confirm", "recall_used", "belief_increase"].includes(signalType)) signal = 1;
      else if (["tool_error", "user_correction", "recall_rejected", "belief_decrease"].includes(signalType)) signal = -1;
    }
    after = beliefB(before, signal);
  } else {
    const signals = (db.prepare(
      "SELECT weight, created_at, signal_type FROM gm_belief_signals WHERE node_id=? ORDER BY created_at"
    ).all(nodeId) as any[]).map((r: any) => ({
      weight: r.weight,
      createdAt: r.created_at,
      isPositive: ["tool_success", "explicit_confirm", "recall_used", "belief_increase", "initial"].includes(r.signal_type),
    }));
    after = beliefC(signals);
  }

  db.prepare(`
    UPDATE gm_nodes SET belief=?, success_count=?, failure_count=?, last_signal_at=?, updated_at=? WHERE id=?
  `).run(after, newSuccess, newFailure, Date.now(), Date.now(), nodeId);

  return { before, after, delta: after - before };
}

// ─── Extract Signals from Messages ───────────────────────────────

interface ExtractedSignal {
  sessionId: string;
  text: string;
  signalType: BeliefSignalType | null;
  confidence: number;
  nodeName: string | null;
}

function extractSignalsFromMessages(db: DatabaseSync, knownNodes: string[]): ExtractedSignal[] {
  const signals: ExtractedSignal[] = [];
  const messages = db.prepare(
    "SELECT session_id, turn_index, role, content FROM gm_messages ORDER BY created_at DESC LIMIT 5000"
  ).all() as any[];

  const correctionPatterns = [
    /不对|错误|不是|错了|纠正|修正|取消|停|不正确|有误|失败|不行|没用|无用|不对的|别|不要/i,
    /不对|错了|不是|纠正|取消|停/i,
  ];
  const confirmPatterns = [
    /对的|可以|好|行|明白了|知道了|谢谢|正确|成功|完成了|好的/i,
  ];

  for (const msg of messages) {
    let text = "";
    try {
      const parsed = JSON.parse(msg.content);
      if (typeof parsed === "string") text = parsed;
      else if (typeof parsed?.content === "string") text = parsed.content;
      else if (Array.isArray(parsed)) {
        text = parsed.filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("\n");
      }
    } catch { text = String(msg.content); }

    if (!text.trim() || text.length < 3) continue;
    if (!msg.role) continue;

    const isUser = msg.role === "user";

    // Find matching node
    let matchedNode: string | null = null;
    for (const nodeName of knownNodes) {
      if (nodeName.length < 4) continue;
      const variants = [nodeName, nodeName.replace(/-/g, " "), nodeName.replace(/-/g, "")];
      if (variants.some(v => text.includes(v))) {
        matchedNode = nodeName;
        break;
      }
    }

    if (isUser) {
      const hasCorrection = correctionPatterns.some(p => p.test(text));
      const hasConfirm = confirmPatterns.some(p => p.test(text));

      if (hasCorrection && !hasConfirm) {
        signals.push({
          sessionId: msg.session_id,
          text: text.slice(0, 80),
          signalType: "user_correction",
          confidence: 0.8,
          nodeName: matchedNode,
        });
      } else if (hasConfirm && !hasCorrection) {
        signals.push({
          sessionId: msg.session_id,
          text: text.slice(0, 80),
          signalType: "explicit_confirm",
          confidence: 0.6,
          nodeName: matchedNode,
        });
      }
    }
  }

  return signals;
}

// ─── Predefined Correction Scenarios ───────────────────────────

interface Scenario {
  name: string;
  nodeName: string;
  signalType: BeliefSignalType;
  expected: "increase" | "decrease";
  note: string;
}

const SCENARIOS: Scenario[] = [
  {
    name: "workspace-external-file-safety-rule (workspace外操作需确认)",
    nodeName: "workspace-external-file-safety-rule",
    signalType: "user_correction",
    expected: "decrease",
    note: "用户违反过这条规则被纠正",
  },
  {
    name: "gateway-restart-red-line-rule (Gateway重启必须询问)",
    nodeName: "gateway-restart-red-line-rule",
    signalType: "explicit_confirm",
    expected: "increase",
    note: "用户多次强调这条规则的重要性",
  },
  {
    name: "nixos-system-config-modification-rules (NixOS配置修改需确认)",
    nodeName: "nixos-system-config-modification-rules",
    signalType: "tool_success",
    expected: "increase",
    note: "配置修改规则被正确遵守",
  },
  {
    name: "graph-memory-development-directory-rule (开发要在Codes目录)",
    nodeName: "graph-memory-development-directory-rule",
    signalType: "user_correction",
    expected: "decrease",
    note: "这条规则被违反过",
  },
  {
    name: "hot-layer-scope-definition (hot层范围定义)",
    nodeName: "hot-layer-scope-definition",
    signalType: "explicit_confirm",
    expected: "increase",
    note: "hot层规则被明确定义",
  },
  {
    name: "mail-system-claw-mmm-fan-config (Claw邮箱配置)",
    nodeName: "mail-system-claw-mmm-fan-config",
    signalType: "tool_success",
    expected: "increase",
    note: "邮箱配置被正确使用",
  },
  {
    name: "rbw-vaultwarden-config-usage-spec (RBW密码管理配置)",
    nodeName: "rbw-vaultwarden-config-usage-spec",
    signalType: "tool_success",
    expected: "increase",
    note: "RBW密码管理配置被正确使用",
  },
];

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║       Graph Memory Belief System — Test Harness              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const allNodes = testDb.prepare(
    "SELECT id, name, type FROM gm_nodes WHERE status='active'"
  ).all() as any[];
  const knownNodeNames = allNodes.map((n: any) => n.name);

  console.log(`\n📊 Test DB: ${allNodes.length} active nodes, ${prodEdges.length} edges, ${prodMessages.length} messages`);

  // Extract signals from messages
  console.log("\n🔍 Extracting signals from message history...");
  const extractedSignals = extractSignalsFromMessages(testDb, knownNodeNames);
  console.log(`  Total potential signals: ${extractedSignals.length}`);
  console.log(`  - user_correction: ${extractedSignals.filter(s => s.signalType === "user_correction").length}`);
  console.log(`  - explicit_confirm: ${extractedSignals.filter(s => s.signalType === "explicit_confirm").length}`);

  // ── Test each scheme ─────────────────────────────────────────
  const schemeResults: Array<{
    scheme: string;
    scenarioResults: Array<{ name: string; before: number; after: number; delta: number; correct: boolean }>;
    beliefDist: { high: number; medium: number; low: number };
    avgBelief: number;
    notes: string[];
  }> = [];

  for (const scheme of ["A", "B", "C"] as string[]) {
    console.log(`\n🧪 Testing Scheme ${scheme}...`);

    // Reset beliefs to 0.5 for fresh start
    testDb.prepare("UPDATE gm_nodes SET belief=0.5, success_count=0, failure_count=0, last_signal_at=0").run();
    testDb.prepare("DELETE FROM gm_belief_signals").run();

    // Record extracted signals
    let recordedCount = 0;
    for (const sig of extractedSignals) {
      if (!sig.nodeName) continue;
      const node = findNodeByName(testDb, sig.nodeName);
      if (!node) continue;
      try {
        recordSignal(testDb, node.id, node.name, sig.signalType!, "test-session", sig.confidence);
        recordedCount++;
      } catch { /* ignore */ }
    }
    console.log(`  Recorded ${recordedCount} signals`);

    // Test predefined scenarios
    const scenarioResults: Array<{ name: string; before: number; after: number; delta: number; correct: boolean }> = [];
    const notes: string[] = [];

    for (const scenario of SCENARIOS) {
      const node = findNodeByName(testDb, scenario.nodeName);
      if (!node) {
        notes.push(`Node not found: ${scenario.nodeName}`);
        continue;
      }

      const beforeInfo = getBeliefInfo(testDb, node.id);
      const before = beforeInfo?.belief ?? 0.5;

      const result = applyBeliefUpdate(testDb, node.id, scheme, scenario.signalType);
      if (!result) {
        notes.push(`Failed to update: ${scenario.nodeName}`);
        continue;
      }

      const correct =
        (scenario.expected === "increase" && result.delta > 0.01) ||
        (scenario.expected === "decrease" && result.delta < -0.01);

      scenarioResults.push({
        name: scenario.name,
        before,
        after: result.after,
        delta: result.delta,
        correct,
      });

      if (!correct) {
        notes.push(`${scheme}: "${scenario.name}" — ${before.toFixed(3)}→${result.after.toFixed(3)} (Δ=${result.delta.toFixed(3)}, expected=${scenario.expected})`);
      }
    }

    // Belief distribution
    const beliefs = testDb.prepare(
      "SELECT belief FROM gm_nodes WHERE status='active'"
    ).all() as any[];
    const avgBelief = beliefs.reduce((s: number, r: any) => s + r.belief, 0) / (beliefs.length || 1);
    const high = beliefs.filter((r: any) => r.belief > 0.7).length;
    const med = beliefs.filter((r: any) => r.belief >= 0.4 && r.belief <= 0.7).length;
    const low = beliefs.filter((r: any) => r.belief < 0.4).length;

    schemeResults.push({ scheme, scenarioResults, beliefDist: { high, medium: med, low }, avgBelief, notes });
  }

  // ── Print Results ────────────────────────────────────────────

  console.log("\n\n╔══════════════════════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                               SCHEME COMPARISON RESULTS                                          ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════════════════════════╣");

  for (const r of schemeResults) {
    const correct = r.scenarioResults.filter(s => s.correct).length;
    const total = r.scenarioResults.length;
    const score = total > 0 ? correct / total : 0;
    console.log(`║ Scheme ${r.scheme}:`);
    console.log(`║   Scenario accuracy: ${(score * 100).toFixed(0)}% (${correct}/${total})`);
    console.log(`║   Avg belief: ${r.avgBelief.toFixed(3)}`);
    console.log(`║   Distribution: high=${r.beliefDist.high} | med=${r.beliefDist.medium} | low=${r.beliefDist.low}`);
    for (const note of r.notes.slice(0, 2)) {
      console.log(`║   ⚠️  ${note.slice(0, 85)}`);
    }
    console.log("╠══════════════════════════════════════════════════════════════════════════════════════════════════╣");
  }

  // ── Scenario Detail Table ───────────────────────────────────

  console.log("\n\n╔══════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                            SCENARIO DETAIL TABLE                                    ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════════╣");

  const schemes = schemeResults;
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    console.log(`║ ${i + 1}. ${s.name}`);
    console.log(`║    Note: ${s.note}`);
    for (const r of schemes) {
      const sr = r.scenarioResults[i];
      if (!sr) { console.log(`║    Scheme ${r.scheme}: N/A`); continue; }
      const status = sr.correct ? "✅" : "❌";
      const dir = sr.delta > 0.01 ? "↑" : sr.delta < -0.01 ? "↓" : "→";
      console.log(`║    ${status} Scheme ${r.scheme}: ${sr.before.toFixed(3)} → ${sr.after.toFixed(3)} (${dir}${Math.abs(sr.delta).toFixed(3)})`);
    }
  }

  // ── Top/Bottom by Belief ────────────────────────────────────

  console.log("\n\n╔════════════════════════════════╗");
  console.log("║  TOP 10 NODES BY BELIEF (A) ║");
  console.log("╚════════════════════════════════╝");
  const topByBelief = testDb.prepare(
    "SELECT name, type, belief, success_count, failure_count FROM gm_nodes WHERE status='active' ORDER BY belief DESC LIMIT 10"
  ).all() as any[];
  for (const n of topByBelief) {
    console.log(`  ${n.belief.toFixed(3)} [${n.type}] ${n.name} (s=${n.success_count} f=${n.failure_count})`);
  }

  console.log("\n╔════════════════════════════════╗");
  console.log("║  BOTTOM 10 NODES BY BELIEF (A)║");
  console.log("╚════════════════════════════════╝");
  const bottomByBelief = testDb.prepare(
    "SELECT name, type, belief, success_count, failure_count FROM gm_nodes WHERE status='active' ORDER BY belief ASC LIMIT 10"
  ).all() as any[];
  for (const n of bottomByBelief) {
    console.log(`  ${n.belief.toFixed(3)} [${n.type}] ${n.name} (s=${n.success_count} f=${n.failure_count})`);
  }

  // ── Overall Stats ──────────────────────────────────────────

  const allBeliefs = testDb.prepare(
    "SELECT belief FROM gm_nodes WHERE status='active'"
  ).all() as any[];
  const avgBelief = allBeliefs.reduce((s: number, r: any) => s + r.belief, 0) / allBeliefs.length;
  const totalSignals = (testDb.prepare("SELECT COUNT(*) as c FROM gm_belief_signals").get() as any)?.c ?? 0;

  console.log("\n╔════════════════════════════════╗");
  console.log("║  BELIEF DISTRIBUTION STATS  ║");
  console.log("╚════════════════════════════════╝");
  console.log(`  Total active nodes: ${allBeliefs.length}`);
  console.log(`  Total belief signals: ${totalSignals}`);
  console.log(`  Average belief: ${avgBelief.toFixed(3)}`);
  console.log(`  High belief (>0.7): ${allBeliefs.filter((r: any) => r.belief > 0.7).length}`);
  console.log(`  Medium (0.4-0.7): ${allBeliefs.filter((r: any) => r.belief >= 0.4 && r.belief <= 0.7).length}`);
  console.log(`  Low belief (<0.4): ${allBeliefs.filter((r: any) => r.belief < 0.4).length}`);

  // Force WAL checkpoint to ensure all data is written to main db file
  try { testDb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
  testDb.close();

  console.log("\n\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║                       RECOMMENDATION                                     ║");
  console.log("╠══════════════════════════════════════════════════════════════════════╣");
  console.log("║  Scheme A (Beta-Bayesian Count):                                       ║");
  console.log("║    belief = (1 + s) / (2 + s + f)  where s=successes, f=failures    ║");
  console.log("║    - Most interpretable (directly readable as probability)             ║");
  console.log("║    - Mathematically principled (Beta-Bayesian model)                   ║");
  console.log("║    - Stable (smooth updates, no oscillation)                          ║");
  console.log("║    - Recommended as default scheme                                     ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log("\n✅ Test harness complete!");
}

main().catch(console.error);
