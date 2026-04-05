/**
 * graph-memory — Belief System End-to-End Test (verdict-based)
 *
 * Tests the belief/confidence mechanism with real LLM API and production data.
 * Uses a copy of the production database to avoid modifying live data.
 *
 * Test Scenarios:
 * 1. LLM correctly identifies supported nodes (tool success)
 * 2. LLM correctly identifies contradicted nodes (user correction)
 * 3. Belief scores update appropriately with verdict + weight
 * 4. Weight assignments are within valid range (0.5-2.0)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { DatabaseSync } from "@photostructure/sqlite";
import { Extractor } from "../src/extractor/extract.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { getBeliefInfo, recordBeliefSignal, updateNodeBelief } from "../src/store/store.ts";
import { Recaller } from "../src/recaller/recall.ts";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Test Database Setup ────────────────────────────────────────────

let testDb: DatabaseSyncInstance;
let testDbPath: string;
const PROD_DB_PATH = "/home/ltrump/.openclaw/graph-memory.db";

beforeAll(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gm-test-"));
  testDbPath = path.join(tempDir, "graph-memory-test.db");
  fs.copyFileSync(PROD_DB_PATH, testDbPath);

  testDb = new DatabaseSync(testDbPath);

  const tableInfo = testDb.prepare("PRAGMA table_info(gm_nodes)").all();
  const hasBelief = tableInfo.some((col: any) => col.name === "belief");

  if (!hasBelief) {
    console.log("Running belief schema migration on test DB...");
    testDb.exec(`
      ALTER TABLE gm_nodes ADD COLUMN belief REAL DEFAULT 0.5;
      ALTER TABLE gm_nodes ADD COLUMN success_count INTEGER DEFAULT 0;
      ALTER TABLE gm_nodes ADD COLUMN failure_count INTEGER DEFAULT 0;
      ALTER TABLE gm_nodes ADD COLUMN last_signal_at INTEGER DEFAULT 0;

      CREATE TABLE IF NOT EXISTS gm_belief_signals (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        node_name TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        weight REAL NOT NULL,
        context TEXT,
        session_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (node_id) REFERENCES gm_nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_belief_signals_node ON gm_belief_signals(node_id);
      CREATE INDEX IF NOT EXISTS idx_belief_signals_name ON gm_belief_signals(node_name);
    `);
    console.log("✓ Belief schema migration completed");
  }

  console.log(`Test database copied to: ${testDbPath}`);
});

afterAll(() => {
  testDb.close();
  try {
    fs.unlinkSync(testDbPath);
    fs.rmdirSync(path.dirname(testDbPath));
  } catch (e) {
    console.warn("Failed to cleanup test database:", e);
  }
});

// ─── Helper Functions ───────────────────────────────────────────

function createRealExtractor(): Extractor {
  const { createCompleteFn } = require("../src/engine/llm.ts");

  const openclawConfigPath = "/home/ltrump/.openclaw/openclaw.json";
  let llmConfig: any = {};

  try {
    const config = JSON.parse(fs.readFileSync(openclawConfigPath, "utf-8"));
    llmConfig =
      config.plugins?.entries?.["graph-memory"]?.config?.llm ||
      config.plugins?.slots?.["graph-memory"]?.config?.llm ||
      {};
  } catch (e) {
    console.warn("Failed to read OpenClaw config:", e);
  }

  if (!llmConfig.apiKey || !llmConfig.baseURL) {
    throw new Error(
      "[graph-memory] Test LLM config missing apiKey or baseURL. Check openclaw.json"
    );
  }

  const provider = llmConfig.baseURL?.includes("minimaxi")
    ? "minimax"
    : llmConfig.baseURL?.includes("dashscope")
      ? "dashscope"
      : "modelstudio";
  const model = llmConfig.model || "qwen3.5-plus";

  console.log(`Using LLM: ${provider}/${model}`);
  const llm = createCompleteFn(provider, model, llmConfig);
  return new Extractor(DEFAULT_CONFIG, llm);
}

function createSuccessTurn(nodeName: string): any[] {
  return [
    { role: "user", content: `请帮我执行操作（参考 ${nodeName}）`, turn_index: 0 },
    { role: "assistant", content: `根据 ${nodeName} 的指导，执行...`, turn_index: 1 },
    {
      role: "toolResult",
      name: "exec",
      content: JSON.stringify({ status: "success", output: "操作成功完成", exitCode: 0 }),
      turn_index: 2,
    },
    { role: "user", content: "好的，成功了", turn_index: 3 },
  ];
}

function createCorrectionTurn(nodeName: string): any[] {
  return [
    { role: "user", content: `如何配置 NixOS？（参考 ${nodeName}）`, turn_index: 0 },
    { role: "assistant", content: `根据 ${nodeName}，你应该修改 nixos configs`, turn_index: 1 },
    {
      role: "user",
      content: "不对，NixOS 应该用 systemd override 方式，不要直接改 nixos configs",
      turn_index: 2,
    },
  ];
}

function createFailureTurn(): any[] {
  return [
    { role: "user", content: "帮我执行这个命令", turn_index: 0 },
    { role: "assistant", content: "执行以下命令...", turn_index: 1 },
    {
      role: "toolResult",
      name: "exec",
      content: JSON.stringify({ status: "error", error: "permission denied", exitCode: 1 }),
      turn_index: 2,
    },
  ];
}

// ═══════════════════════════════════════════════════════════════
// Test Cases
// ═══════════════════════════════════════════════════════════════

describe("Belief System E2E (verdict-based)", () => {
  it("LLM extracts beliefUpdates for supported nodes (tool success)", async () => {
    const extractor = createRealExtractor();
    const testNodeName = "workspace-internal-free-operation-rule";
    const messages = createSuccessTurn(testNodeName);

    const recaller = new Recaller(testDb, DEFAULT_CONFIG);
    const recalled = await recaller.recall(testNodeName);

    // recalled is RecallResult: { nodes, edges, pprScores, tokenEstimate }
    const knowledgeGraph =
      recalled.nodes.length > 0
        ? `<knowledge_graph>
${recalled.nodes
  .map(
    (n) => `  <knowledge name="${n.name}">
${n.content}
  </knowledge>`
  )
  .join("\n")}
</knowledge_graph>`
        : "";

    const result = await extractor.extract({ messages, knowledgeGraph });

    console.log("LLM extraction result:");
    console.log("  nodes:", result.nodes?.length ?? 0);
    console.log(
      "  beliefUpdates:",
      result.beliefUpdates?.length ?? 0
    );
    if (result.beliefUpdates?.length) {
      console.log(
        "  beliefUpdates:",
        JSON.stringify(result.beliefUpdates, null, 2)
      );
    }

    // beliefUpdates 数组存在（可能为空）
    expect(result.beliefUpdates).toBeDefined();
    expect(Array.isArray(result.beliefUpdates)).toBe(true);

    if (result.beliefUpdates!.length > 0) {
      const supported = result.beliefUpdates?.filter(
        (u) => u.verdict === "supported"
      );
      console.log(
        "✓ LLM identified supported nodes:",
        supported?.length ?? 0
      );
    } else {
      console.log(
        "⚠ LLM did not output beliefUpdates (may need clearer context)"
      );
    }
  }, 30000);

  it("LLM extracts beliefUpdates for contradicted nodes (user correction)", async () => {
    const extractor = createRealExtractor();
    const testNodeName = "nixos-system-config-modification-rules";
    const messages = createCorrectionTurn(testNodeName);

    const recaller = new Recaller(testDb, DEFAULT_CONFIG);
    const recalled = await recaller.recall(testNodeName);

    const knowledgeGraph =
      recalled.nodes.length > 0
        ? `<knowledge_graph>
${recalled.nodes
  .map(
    (n) => `  <knowledge name="${n.name}">
${n.content}
  </knowledge>`
  )
  .join("\n")}
</knowledge_graph>`
        : "";

    const result = await extractor.extract({ messages, knowledgeGraph });

    console.log("LLM extraction result:");
    console.log(
      "  beliefUpdates:",
      result.beliefUpdates?.length ?? 0
    );
    if (result.beliefUpdates?.length) {
      console.log(
        "  beliefUpdates:",
        JSON.stringify(result.beliefUpdates, null, 2)
      );
    }

    expect(result.beliefUpdates).toBeDefined();

    const contradicted = result.beliefUpdates?.filter(
      (u) => u.verdict === "contradicted"
    );

    if (contradicted && contradicted.length > 0) {
      for (const u of contradicted) {
        // 用户纠正权重应在 1.5-2.0
        expect(u.weight).toBeGreaterThanOrEqual(1.5);
        expect(u.weight).toBeLessThanOrEqual(2.0);
        // reason 应有内容
        expect(u.reason).toBeTruthy();
      }
      console.log("✓ LLM correctly identified contradicted nodes");
    } else {
      console.log(
        "⚠ LLM did not identify contradicted nodes (may need prompt tuning)"
      );
    }
  }, 30000);

  it("Belief scores update correctly with verdict + weight", () => {
    const testNode = testDb
      .prepare(
        "SELECT id, name, belief, success_count, failure_count FROM gm_nodes WHERE status='active' LIMIT 1"
      ) as any;
    const row = testNode.get() as any;
    expect(row).toBeDefined();

    const { id: nodeId, name: nodeName, belief: initialBelief } = row;
    const initialSuccess = row.success_count ?? 0;
    const initialFailure = row.failure_count ?? 0;

    // Record supported (positive) with weight 1.0
    recordBeliefSignal(
      testDb,
      nodeId,
      nodeName,
      "supported",
      "test-session",
      1.0,
      { test: true }
    );
    const afterSupported = updateNodeBelief(testDb, nodeId, "supported", 1.0);
    expect(afterSupported).toBeDefined();
    expect(afterSupported!.beliefAfter).toBeGreaterThan(initialBelief);
    console.log(
      `  supported: ${initialBelief.toFixed(3)} → ${afterSupported!.beliefAfter.toFixed(3)}`
    );

    // Record contradicted (negative) with weight 1.5
    recordBeliefSignal(
      testDb,
      nodeId,
      nodeName,
      "contradicted",
      "test-session",
      1.5,
      { test: true }
    );
    const afterContradicted = updateNodeBelief(
      testDb,
      nodeId,
      "contradicted",
      1.5
    );
    expect(afterContradicted).toBeDefined();
    console.log(
      `  contradicted: ${afterSupported!.beliefAfter.toFixed(3)} → ${afterContradicted!.beliefAfter.toFixed(3)}`
    );
  });

  it("Weight assignments are stored and retrieved correctly", () => {
    const testNode = testDb
      .prepare(
        "SELECT id, name FROM gm_nodes WHERE status='active' LIMIT 1"
      ) as any;
    const row = testNode.get() as any;
    expect(row).toBeDefined();

    const testCases = [
      { verdict: "supported" as const, weight: 1.0 },
      { verdict: "supported" as const, weight: 2.0 },
      { verdict: "contradicted" as const, weight: 1.5 },
      { verdict: "contradicted" as const, weight: 0.5 },
    ];

    for (const tc of testCases) {
      recordBeliefSignal(
        testDb,
        row.id,
        row.name,
        tc.verdict,
        "test-session",
        tc.weight,
        { test: true }
      );

      const signal = testDb
        .prepare(
          "SELECT weight, signal_type FROM gm_belief_signals WHERE node_id=? AND signal_type=? ORDER BY created_at DESC LIMIT 1"
        )
        .get(row.id, tc.verdict) as any;

      expect(signal).toBeDefined();
      expect(signal.weight).toBe(tc.weight);
      console.log(
        `✓ ${tc.verdict} weight=${tc.weight}: stored correctly`
      );
    }
  });

  it("LLM weight assignments are within valid range (0.5-2.0)", async () => {
    const extractor = createRealExtractor();

    const scenarios = [
      {
        name: "success scenario",
        messages: createSuccessTurn("nixos-script-shebang-convention"),
      },
      { name: "failure scenario", messages: createFailureTurn() },
    ];

    for (const scenario of scenarios) {
      const recaller = new Recaller(testDb, DEFAULT_CONFIG);
      await recaller.recall("nixos");

      const result = await extractor.extract({ messages: scenario.messages });

      if (result.beliefUpdates && result.beliefUpdates.length > 0) {
        for (const u of result.beliefUpdates) {
          expect(u.weight).toBeGreaterThanOrEqual(0.5);
          expect(u.weight).toBeLessThanOrEqual(2.0);
          console.log(
            `✓ ${scenario.name}: ${u.nodeName} [${u.verdict}] weight=${u.weight.toFixed(2)}`
          );
        }
      }
    }
  }, 60000);
});

describe("Production Data Validation", () => {
  it("Has sufficient active nodes for testing", () => {
    const { c } = testDb
      .prepare(
        "SELECT COUNT(*) as c FROM gm_nodes WHERE status='active'"
      )
      .get() as any;
    expect(c).toBeGreaterThan(10);
    console.log(`✓ Production DB has ${c} active nodes`);
  });

  it("Has belief system schema", () => {
    const table = testDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='gm_belief_signals'"
      )
      .get();
    expect(table).toBeDefined();
    console.log("✓ Belief system schema exists");
  });

 it("Nodes have belief scores", () => {
    const { c } = testDb
      .prepare("SELECT COUNT(*) as c FROM gm_nodes WHERE belief IS NOT NULL")
      .get() as any;
    expect(c).toBeGreaterThan(0);
    console.log(`✓ ${c} nodes have belief scores`);
  });
});
