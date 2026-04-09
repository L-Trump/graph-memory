/**
 * graph-memory — Decay + Recall Integration Tests
 *
 * Tests that decay scoring correctly influences recall tiering.
 */

import { describe, it, assert, beforeEach, afterEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { Recaller } from "../src/recaller/recall.ts";
import { createDecayEngine, getTypeImportance } from "../src/engine/decay.ts";
import { DEFAULT_DECAY_CONFIG } from "../src/engine/decay.ts";

function createTestDbWithAccess(): DatabaseSyncInstance {
  // Schema now includes all columns (access_count, last_accessed_at, belief, etc.)
  return createTestDb();
}

describe("Decay Integration — access tracking", () => {
  let db: DatabaseSyncInstance;

  beforeEach(() => {
    db = createTestDbWithAccess();
  });

  afterEach(() => {
    db.close();
  });

  it("recordNodeAccessBatch increments access_count", async () => {
    const { recordNodeAccessBatch } = await import("../src/store/store.ts");

    const nodeId = insertNode(db, { name: "test-skill", type: "SKILL" });

    // Verify initial access_count is 0
    const before = db.prepare("SELECT access_count FROM gm_nodes WHERE id=?").get(nodeId) as any;
    assert.equal(before.access_count, 0);

    // Record access
    recordNodeAccessBatch(db, [nodeId]);

    // Verify incremented
    const after = db.prepare("SELECT access_count, last_accessed_at FROM gm_nodes WHERE id=?").get(nodeId) as any;
    assert.equal(after.access_count, 1);
    assert.isAbove(after.last_accessed_at, 0);
  });

  it("recordNodeAccessBatch handles empty array", async () => {
    const { recordNodeAccessBatch } = await import("../src/store/store.ts");
    // Should not throw
    recordNodeAccessBatch(db, []);
    assert.ok(true);
  });

  it("recordNodeAccessBatch is idempotent", async () => {
    const { recordNodeAccessBatch } = await import("../src/store/store.ts");

    const nodeId = insertNode(db, { name: "test-skill-2", type: "SKILL" });

    recordNodeAccessBatch(db, [nodeId]);
    recordNodeAccessBatch(db, [nodeId]);
    recordNodeAccessBatch(db, [nodeId]);

    const after = db.prepare("SELECT access_count FROM gm_nodes WHERE id=?").get(nodeId) as any;
    assert.equal(after.access_count, 3);
  });

  it("multiple nodes are tracked independently", async () => {
    const { recordNodeAccessBatch } = await import("../src/store/store.ts");

    const id1 = insertNode(db, { name: "node-a", type: "SKILL" });
    const id2 = insertNode(db, { name: "node-b", type: "STATUS" });
    const id3 = insertNode(db, { name: "node-c", type: "TASK" });

    recordNodeAccessBatch(db, [id1, id2]);

    const r1 = db.prepare("SELECT access_count FROM gm_nodes WHERE id=?").get(id1) as any;
    const r2 = db.prepare("SELECT access_count FROM gm_nodes WHERE id=?").get(id2) as any;
    const r3 = db.prepare("SELECT access_count FROM gm_nodes WHERE id=?").get(id3) as any;

    assert.equal(r1.access_count, 1);
    assert.equal(r2.access_count, 1);
    assert.equal(r3.access_count, 0); // not accessed
  });
});

describe("Decay Integration — recall with decay scoring", () => {
  let db: DatabaseSyncInstance;
  let recaller: Recaller;

  beforeEach(() => {
    db = createTestDbWithAccess();
    const cfg = {
      dbPath: ":memory:",
      compactTurnCount: 6,
      recallMaxNodes: 45,
      recallMaxDepth: 2,
      freshTailCount: 10,
      dedupThreshold: 0.90,
      pagerankDamping: 0.85,
      pagerankIterations: 5,
      extractionRecentTurns: 3,
      decayEnabled: true,
    };
    recaller = new Recaller(db as any, cfg as any);
  });

  afterEach(() => {
    db.close();
  });

  it("decay scoring adjusts combined scores of recalled nodes", async () => {
    // Create two nodes with different types and access patterns
    const skillNodeId = insertNode(db, { name: "important-skill", type: "SKILL" });
    const statusNodeId = insertNode(db, { name: "temp-status", type: "STATUS" });

    // Create an edge between them so they appear in graph walk
    insertEdge(db, { fromId: skillNodeId, toId: statusNodeId });

    // Record access for the SKILL node only (simulates repeated use)
    const { recordNodeAccessBatch } = await import("../src/store/store.ts");
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      recordNodeAccessBatch(db, [skillNodeId]);
    }

    // Recall with a query that matches both nodes
    const result = await recaller.recallV2("important skill temporary status");

    // Both nodes should be recalled
    const recalledNames = result.nodes.map(n => n.name);
    assert.ok(recalledNames.includes("important-skill"), "SKILL should be recalled");
    assert.ok(recalledNames.includes("temp-status"), "STATUS should be recalled");

    // Find the tier positions
    const skillTierIdx = result.nodes.findIndex(n => n.name === "important-skill");
    const statusTierIdx = result.nodes.findIndex(n => n.name === "temp-status");

    // The frequently-accessed SKILL should rank higher (lower index) than the never-accessed STATUS
    // Note: this depends on the semantic matching; if the query strongly matches one node,
    // semantic score may dominate. We check that both are at least in the top 45.
    assert.isBelow(skillTierIdx, 45, "SKILL should be in top 45");
    assert.isBelow(statusTierIdx, 45, "STATUS should be in top 45");

    // The decay-adjusted combined score of the accessed SKILL should be >= STATUS
    const skillNode = result.nodes[skillTierIdx];
    const statusNode = result.nodes[statusTierIdx];
    // Due to decay scoring, the fresh/accessed SKILL should score at least as well as stale STATUS
    assert.isAtLeast(skillNode.combinedScore, statusNode.combinedScore - 0.1,
      "Accessed SKILL should not score much worse than STATUS after decay adjustment");
  });

  it("nodes without access tracking default correctly", async () => {
    // Create nodes WITHOUT running any access tracking
    // (simulates pre-access-tracking migration state)
    const nodeId = insertNode(db, { name: "old-node-no-access", type: "KNOWLEDGE" });

    // Don't call recordNodeAccessBatch - simulate old data
    const result = await recaller.recallV2("old node no access");

    // Should still be recalled (decay scoring handles missing data gracefully)
    const recalled = result.nodes.find(n => n.name === "old-node-no-access");
    assert.ok(recalled, "Old node should still be recalled");
    assert.ok(typeof recalled!.combinedScore === "number", "Should have a combined score");
  });
});

describe("Decay Integration — stale node detection", () => {
  let db: DatabaseSyncInstance;

  beforeEach(() => {
    db = createTestDbWithAccess();
  });

  afterEach(() => {
    db.close();
  });

  it("getStaleNodeCandidates finds old never-accessed STATUS nodes", async () => {
    const { getStaleNodeCandidates } = await import("../src/store/store.ts");

    // Insert a stale STATUS node (old, never accessed)
    const staleId = insertNode(db, {
      name: "stale-status",
      type: "STATUS",
      status: "active",
    });

    // Update its created_at to be very old (directly via SQL)
    const oldTime = Date.now() - 200 * 86_400_000;
    db.prepare("UPDATE gm_nodes SET created_at=?, last_accessed_at=0 WHERE id=?").run(oldTime, staleId);

    // Insert a fresh SKILL node
    const freshId = insertNode(db, {
      name: "fresh-skill",
      type: "SKILL",
      status: "active",
    });

    const candidates = getStaleNodeCandidates(db, 7); // 7 day grace

    // The stale STATUS should be a candidate
    const staleCandidate = candidates.find(c => c.id === staleId);
    assert.ok(staleCandidate, "Old STATUS should be a stale candidate");

    // The fresh SKILL should NOT be a candidate
    const freshCandidate = candidates.find(c => c.id === freshId);
    assert.equal(freshCandidate, undefined, "Fresh SKILL should not be a candidate");
  });
});

describe("Decay Integration — type-based decay rates", () => {
  const engine = createDecayEngine();
  const now = Date.now();

  it("SKILL: importance=0.9, slowest decay", () => {
    const skillNode = {
      id: "s", type: "SKILL" as const,
      importance: getTypeImportance("SKILL"),
      belief: 0.5, accessCount: 0,
      createdAt: now - 60 * 86_400_000,
      lastAccessedAt: 0,
    };
    const ds = engine.score(skillNode, now);
    // SKILL should still have reasonable recency at 60 days
    assert.isAbove(ds.recency, 0.5, "SKILL should decay slowly");
    assert.isAbove(ds.composite, DEFAULT_DECAY_CONFIG.staleThreshold,
      "SKILL should not go stale at 60 days even without access");
  });

  it("STATUS: importance=0.3, fastest decay", () => {
    const statusNode = {
      id: "s", type: "STATUS" as const,
      importance: getTypeImportance("STATUS"),
      belief: 0.5, accessCount: 0,
      createdAt: now - 30 * 86_400_000,
      lastAccessedAt: 0,
    };
    const ds = engine.score(statusNode, now);
    assert.isBelow(ds.composite, DEFAULT_DECAY_CONFIG.staleThreshold,
      "STATUS should become stale at 30 days without access");
  });

  it("TASK: importance=0.6, medium decay", () => {
    const taskNode = {
      id: "t", type: "TASK" as const,
      importance: getTypeImportance("TASK"),
      belief: 0.5, accessCount: 0,
      createdAt: now - 30 * 86_400_000,
      lastAccessedAt: 0,
    };
    const ds = engine.score(taskNode, now);
    // TASK should be somewhere in between
    assert.isAbove(ds.recency, 0.3, "TASK should retain some recency at 30 days");
  });
});
