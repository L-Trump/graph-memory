/**
 * graph-memory — 图算法测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 测试个性化 PageRank、全局 PageRank、向量去重
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { personalizedPageRank, computeGlobalPageRank, invalidateGraphCache } from "../src/graph/pagerank.ts";
import { detectDuplicates, dedup } from "../src/graph/dedup.ts";
import { runMaintenance } from "../src/graph/maintenance.ts";
import { findById, saveVector } from "../src/store/store.ts";
import { DEFAULT_CONFIG, type GmConfig } from "../src/types.ts";
import { getDb, resetDb } from "../src/store/db.ts";

let db: DatabaseSyncInstance;
const cfg: GmConfig = { ...DEFAULT_CONFIG };

beforeEach(() => {
  db = createTestDb();
  invalidateGraphCache();
});

// ═══════════════════════════════════════════════════════════════
// 个性化 PageRank
// ═══════════════════════════════════════════════════════════════

describe("Personalized PageRank", () => {
  /**
   * 构建测试图：
   *
   *   [docker-deploy] → [docker-compose-up] → [docker-port-expose]
   *                                          ↓
   *                                    [nginx-config]
   *
   *   [conda-env-create] → [pip-install]
   *
   * 从 docker-deploy 出发，docker 相关节点应该分数远高于 conda 相关
   */
  it("从种子出发的节点分数高于远端节点", () => {
    const dockerDeploy = insertNode(db, { name: "docker-deploy", type: "TASK" });
    const composeUp = insertNode(db, { name: "docker-compose-up", type: "SKILL" });
    const portExpose = insertNode(db, { name: "docker-port-expose", type: "SKILL" });
    const nginx = insertNode(db, { name: "nginx-config", type: "SKILL" });
    const condaCreate = insertNode(db, { name: "conda-env-create", type: "SKILL" });
    const pipInstall = insertNode(db, { name: "pip-install", type: "SKILL" });

    insertEdge(db, { fromId: dockerDeploy, toId: composeUp, name: "USED_SKILL" });
    insertEdge(db, { fromId: composeUp, toId: portExpose, name: "REQUIRES" });
    insertEdge(db, { fromId: composeUp, toId: nginx, name: "USED_SKILL" });
    insertEdge(db, { fromId: condaCreate, toId: pipInstall, name: "REQUIRES" });

    const all = [dockerDeploy, composeUp, portExpose, nginx, condaCreate, pipInstall];

    // 从 docker-deploy 出发
    const { scores } = personalizedPageRank(db, [dockerDeploy], all, cfg);

    const dockerScore = scores.get(composeUp) || 0;
    const condaScore = scores.get(condaCreate) || 0;

    // docker 相关节点应该分数远高于 conda（没有路径连接）
    expect(dockerScore).toBeGreaterThan(condaScore);
    expect(dockerScore).toBeGreaterThan(0);
  });

  it("不同种子产生不同排序", () => {
    const a = insertNode(db, { name: "node-a" });
    const b = insertNode(db, { name: "node-b" });
    const c = insertNode(db, { name: "shared-node" });

    insertEdge(db, { fromId: a, toId: c });
    insertEdge(db, { fromId: b, toId: c });

    const all = [a, b, c];

    const fromA = personalizedPageRank(db, [a], all, cfg);
    const fromB = personalizedPageRank(db, [b], all, cfg);

    // 从 a 出发：a 的分数最高
    expect((fromA.scores.get(a) || 0)).toBeGreaterThan((fromA.scores.get(b) || 0));
    // 从 b 出发：b 的分数最高
    expect((fromB.scores.get(b) || 0)).toBeGreaterThan((fromB.scores.get(a) || 0));
  });

  it("空种子返回空 scores", () => {
    insertNode(db, { name: "some-node" });
    const { scores } = personalizedPageRank(db, [], ["some-node"], cfg);
    expect(scores.size).toBe(0);
  });

  it("空图不报错", () => {
    const { scores } = personalizedPageRank(db, ["fake-id"], ["fake-id"], cfg);
    expect(scores.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 全局 PageRank
// ═══════════════════════════════════════════════════════════════

describe("Global PageRank", () => {
  it("hub 节点分数最高", () => {
    // hub 被多个节点连接
    const hub = insertNode(db, { name: "hub-skill" });
    const a = insertNode(db, { name: "task-a", type: "TASK" });
    const b = insertNode(db, { name: "task-b", type: "TASK" });
    const c = insertNode(db, { name: "task-c", type: "TASK" });
    const leaf = insertNode(db, { name: "leaf-node" });

    insertEdge(db, { fromId: a, toId: hub });
    insertEdge(db, { fromId: b, toId: hub });
    insertEdge(db, { fromId: c, toId: hub });
    insertEdge(db, { fromId: hub, toId: leaf });

    const { scores, topK } = computeGlobalPageRank(db, cfg);

    expect(topK[0].name).toBe("hub-skill");
    expect((scores.get(hub) || 0)).toBeGreaterThan((scores.get(leaf) || 0));
  });

  it("写入 gm_nodes.pagerank 列", () => {
    const a = insertNode(db, { name: "node-a" });
    const b = insertNode(db, { name: "node-b" });
    insertEdge(db, { fromId: a, toId: b });

    computeGlobalPageRank(db, cfg);

    const row = db.prepare("SELECT pagerank FROM gm_nodes WHERE id=?").get(a) as any;
    expect(row.pagerank).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 向量去重
// ═══════════════════════════════════════════════════════════════

describe("Vector Dedup", () => {
  it("相似向量被检测为重复", async () => {
    const a = insertNode(db, { name: "conda-env-create", type: "SKILL" });
    const b = insertNode(db, { name: "conda-create-environment", type: "SKILL" });

    // 构造两个非常相似的向量
    const vecA = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    const vecB = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1) + 0.01); // 微小差异

    saveVector(db, a, "content a", vecA);
    saveVector(db, b, "content b", vecB);

    const pairs = await detectDuplicates(db, { ...cfg, dedupThreshold: 0.9 });
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0].similarity).toBeGreaterThan(0.9);
  });

  it("不同向量不被当作重复", async () => {
    const a = insertNode(db, { name: "docker-build", type: "SKILL" });
    const b = insertNode(db, { name: "conda-create", type: "SKILL" });

    // 构造正交向量：前半 vs 后半，余弦相似度 ≈ 0
    const vecA = Array.from({ length: 64 }, (_, i) => i < 32 ? 1 : 0);
    const vecB = Array.from({ length: 64 }, (_, i) => i >= 32 ? 1 : 0);

    saveVector(db, a, "content a", vecA);
    saveVector(db, b, "content b", vecB);

    const pairs = await detectDuplicates(db, { ...cfg, dedupThreshold: 0.9 });
    expect(pairs).toHaveLength(0);
  });

  it("dedup 自动合并同类型重复节点", async () => {
    const a = insertNode(db, { name: "skill-v1", type: "SKILL", validatedCount: 5 });
    const b = insertNode(db, { name: "skill-v1-dup", type: "SKILL", validatedCount: 2 });

    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, a, "content", vec);
    saveVector(db, b, "content", vec); // 完全相同的向量

    const { merged } = await dedup(db, { ...cfg, dedupThreshold: 0.9 });
    expect(merged).toBe(1);

    // a 应该还是 active（validatedCount 更高）
    const aAfter = db.prepare("SELECT status, validated_count FROM gm_nodes WHERE id=?").get(a) as any;
    expect(aAfter.status).toBe("active");
    expect(aAfter.validated_count).toBe(7); // 5 + 2

    // b 应该 deprecated
    const bAfter = db.prepare("SELECT status FROM gm_nodes WHERE id=?").get(b) as any;
    expect(bAfter.status).toBe("deprecated");
  });

  it("不同类型不合并", async () => {
    const a = insertNode(db, { name: "skill-x", type: "SKILL" });
    const b = insertNode(db, { name: "event-x", type: "EVENT" });

    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, a, "content", vec);
    saveVector(db, b, "content", vec);

    const { merged } = await dedup(db, { ...cfg, dedupThreshold: 0.9 });
    expect(merged).toBe(0);
  });


  it("detectDuplicates skips cross-type vector comparisons", async () => {
    const skill = insertNode(db, { name: "same-vector-skill", type: "SKILL" });
    const event = insertNode(db, { name: "same-vector-event", type: "EVENT" });

    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, skill, "content skill", vec);
    saveVector(db, event, "content event", vec);

    const pairs = await detectDuplicates(db, { ...cfg, dedupThreshold: 0.9 });
    expect(pairs).toHaveLength(0);
  });

  it("dedup respects per-run merge budget", async () => {
    for (let i = 0; i < 4; i++) {
      const a = insertNode(db, { name: `budget-skill-${i}-a`, type: "SKILL", validatedCount: 2 });
      const b = insertNode(db, { name: `budget-skill-${i}-b`, type: "SKILL", validatedCount: 1 });
      const vec = Array.from({ length: 64 }, (_, j) => Math.sin(j * 0.1 + i));
      saveVector(db, a, `content ${i} a`, vec);
      saveVector(db, b, `content ${i} b`, vec);
    }

    const { pairs, merged } = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.9,
      dedupMaxMergesPerRun: 2,
      dedupMaxPairsPerRun: 0,
    });

    expect(pairs.length).toBeGreaterThanOrEqual(4);
    expect(merged).toBe(2);
  });


  it("dedup only rechecks pending vectors after first incremental pass", async () => {
    const baseVec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    const otherVec = Array.from({ length: 64 }, (_, i) => Math.cos(i * 0.1));
    const base = insertNode(db, { name: "incremental-base", type: "SKILL" });
    const other = insertNode(db, { name: "incremental-other", type: "SKILL" });
    saveVector(db, base, "base", baseVec);
    saveVector(db, other, "other", otherVec);

    const first = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.99,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 0,
      dedupMaxPendingVectorsPerRun: 10,
    });
    expect(first.incremental).toBe(true);
    expect(first.checkedVectors).toBe(2);

    const second = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.99,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 0,
      dedupMaxPendingVectorsPerRun: 10,
    });
    expect(second.checkedVectors).toBe(0);
    expect(second.comparisons).toBe(0);

    const fresh = insertNode(db, { name: "incremental-fresh", type: "SKILL" });
    saveVector(db, fresh, "fresh", baseVec);
    const third = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.99,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 0,
      dedupMaxPendingVectorsPerRun: 10,
    });
    expect(third.checkedVectors).toBe(1);
    expect(third.pairs).toHaveLength(1);
    expect(third.pairs[0].nameA).toBe("incremental-fresh");
    expect(third.pairs[0].nameB).toBe("incremental-base");
  });

  it("saveVector does not dirty an already checked vector when content hash is unchanged", async () => {
    const node = insertNode(db, { name: "idempotent-vector", type: "SKILL" });
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, node, "same content", vec);
    await dedup(db, { ...cfg, dedupMaxPendingVectorsPerRun: 10 });

    saveVector(db, node, "same content", vec);
    const result = await dedup(db, { ...cfg, dedupMaxPendingVectorsPerRun: 10 });
    expect(result.checkedVectors).toBe(0);
    expect(result.comparisons).toBe(0);
  });

  it("dedup pending vector budget limits checked vectors per pass", async () => {
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    for (let i = 0; i < 3; i++) {
      const node = insertNode(db, { name: `pending-budget-${i}`, type: "SKILL" });
      saveVector(db, node, `pending ${i}`, vec.map(x => x + i * 0.01));
    }

    const result = await dedup(db, {
      ...cfg,
      dedupThreshold: 1.1,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 0,
      dedupMaxPendingVectorsPerRun: 1,
    });

    expect(result.incremental).toBe(true);
    expect(result.checkedVectors).toBe(1);
  });

  it("dedup full-scan fallback pair cap still marks vectors checked after scanning all pairs", async () => {
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    for (let i = 0; i < 3; i++) {
      const node = insertNode(db, { name: `full-cap-${i}`, type: "SKILL" });
      saveVector(db, node, `full cap ${i}`, vec);
    }

    const result = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.9,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 1,
      dedupMaxPendingVectorsPerRun: 0,
    });

    expect(result.incremental).toBe(false);
    expect(result.pairs).toHaveLength(1);
    expect(result.checkedVectors).toBe(3);
    expect(result.comparisons).toBe(3);
  });

  it("dedup incremental pair cap still makes forward progress on duplicate-heavy pending batch", async () => {
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    for (let i = 0; i < 3; i++) {
      const node = insertNode(db, { name: `incremental-cap-${i}`, type: "SKILL" });
      saveVector(db, node, `incremental cap ${i}`, vec);
    }

    const first = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.9,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 1,
      dedupMaxPendingVectorsPerRun: 3,
    });

    expect(first.incremental).toBe(true);
    expect(first.pairs).toHaveLength(1);
    expect(first.checkedVectors).toBe(3);

    const second = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.9,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 1,
      dedupMaxPendingVectorsPerRun: 3,
    });
    expect(second.checkedVectors).toBe(0);
    expect(second.comparisons).toBe(0);
  });

  it("dedup pair budget caps returned candidate pairs", async () => {
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    for (let i = 0; i < 3; i++) {
      const node = insertNode(db, { name: `pair-cap-${i}`, type: "SKILL" });
      saveVector(db, node, `content ${i}`, vec);
    }

    const pairs = await detectDuplicates(db, {
      ...cfg,
      dedupThreshold: 0.9,
      dedupMaxPairsPerRun: 1,
    });

    expect(pairs).toHaveLength(1);
  });

  it("dedup merge budget 0 detects pairs without merging", async () => {
    const a = insertNode(db, { name: "detect-only-a", type: "SKILL", validatedCount: 2 });
    const b = insertNode(db, { name: "detect-only-b", type: "SKILL", validatedCount: 1 });
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, a, "content a", vec);
    saveVector(db, b, "content b", vec);

    const { pairs, merged } = await dedup(db, {
      ...cfg,
      dedupThreshold: 0.9,
      dedupMaxMergesPerRun: 0,
      dedupMaxPairsPerRun: 0,
    });

    expect(pairs).toHaveLength(1);
    expect(merged).toBe(0);
    expect(findById(db, b)?.status).toBe("active");
  });

  it("没有向量时安全跳过", async () => {
    insertNode(db, { name: "no-vec" });
    const { pairs, merged } = await dedup(db, cfg);
    expect(pairs).toHaveLength(0);
    expect(merged).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 全套 maintenance
// ═══════════════════════════════════════════════════════════════

describe("runMaintenance", () => {
  it("already-recorded v16 dev DB still gets dedup tracking schema guard", () => {
    resetDb();
    const dir = mkdtempSync(join(tmpdir(), "gm-v16-guard-test-"));
    const dbPath = join(dir, "graph-memory.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL);
      INSERT INTO _migrations (v, at) VALUES (16, 1);
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
        last_signal_at INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE gm_vectors (
        node_id TEXT PRIMARY KEY REFERENCES gm_nodes(id),
        content_hash TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
    `);
    legacy.close();

    const migrated = getDb(dbPath);
    try {
      const columns = migrated.prepare("PRAGMA table_info(gm_vectors)").all() as Array<{ name: string }>;
      expect(columns.map(col => col.name)).toEqual(expect.arrayContaining(["updated_at", "dedup_checked_at"]));
      const index = migrated.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_gm_vectors_dedup_pending'").get() as any;
      expect(index?.name).toBe("ix_gm_vectors_dedup_pending");
      const state = migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gm_dedup_state'").get() as any;
      expect(state?.name).toBe("gm_dedup_state");
    } finally {
      resetDb();
    }
  });

  it("fresh migrated DB creates maintenance edge indexes on final schema", () => {
    resetDb();
    const dir = mkdtempSync(join(tmpdir(), "gm-migration-test-"));
    const migrated = getDb(join(dir, "graph-memory.db"));
    try {
      const rows = migrated.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name IN ('ix_gm_edges_from_to_name','ix_gm_edges_to_from_name')").all() as Array<{ name: string; sql: string }>;
      const byName = new Map(rows.map(row => [row.name, row.sql]));
      expect(byName.get("ix_gm_edges_from_to_name")).toContain("gm_edges(from_id, to_id, name)");
      expect(byName.get("ix_gm_edges_to_from_name")).toContain("gm_edges(to_id, from_id, name)");
    } finally {
      resetDb();
    }
  });

  it("test schema includes maintenance indexes", () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('ix_gm_nodes_status_rank','ix_gm_nodes_status_type','ix_gm_edges_from_to_name','ix_gm_edges_to_from_name')").all() as any[];
    expect(rows.map(r => r.name).sort()).toEqual([
      "ix_gm_edges_from_to_name",
      "ix_gm_edges_to_from_name",
      "ix_gm_nodes_status_rank",
      "ix_gm_nodes_status_type",
    ]);
  });

  it("全套运行不报错", async () => {
    const a = insertNode(db, { name: "skill-a" });
    const b = insertNode(db, { name: "skill-b" });
    const c = insertNode(db, { name: "task-c", type: "TASK" });
    insertEdge(db, { fromId: c, toId: a, name: "USED_SKILL" });
    insertEdge(db, { fromId: c, toId: b, name: "USED_SKILL" });

    const result = await runMaintenance(db, cfg);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.pagerank.topK.length).toBeGreaterThan(0);
  });

  it("空图不报错", async () => {
    const result = await runMaintenance(db, cfg);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.pagerank.topK).toHaveLength(0);
  });
});