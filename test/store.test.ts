/**
 * graph-memory — store 层测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb, insertNode, insertEdge, copySqliteDatabaseConsistently } from "./helpers.ts";
import {
  findByName, findById, upsertNode, upsertEdge, deprecate,
  mergeNodes, edgesFrom, edgesTo, allActiveNodes, allEdges,
  searchNodes, topNodes, graphWalk, getBySession,
  saveMessage, getMessages, getUnextracted, getRecentExtractedMessages, markExtracted,
  saveSignal, pendingSignals, markSignalsDone,
  getStats, saveVector, vectorSearch, vectorSearchWithScore, getAllVectors,
  setNodeFlags, withTransaction, updatePageranks, markVectorsDedupChecked,
  recordNodeAccessBatch, setScopesForSession,
} from "../src/store/store.ts";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
});

// ═══════════════════════════════════════════════════════════════
// 节点 CRUD
// ═══════════════════════════════════════════════════════════════

describe("node CRUD", () => {
  it("upsertNode 创建新节点", () => {
    const { node, isNew } = upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "创建 conda 环境", content: "## conda-env-create\n### 步骤\n1. conda create -n xxx",
    }, "s1");

    expect(isNew).toBe(true);
    expect(node.name).toBe("conda-env-create");
    expect(node.type).toBe("SKILL");
    expect(node.validatedCount).toBe(1);
  });

  it("upsertNode 同名节点 merge 而非重复创建", () => {
    upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "短描述", content: "短内容",
    }, "s1");

    const { node, isNew } = upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "更长的描述说明", content: "更长更完整的内容说明文档",
    }, "s2");

    expect(isNew).toBe(false);
    expect(node.validatedCount).toBe(2);
    // 保留更长的
    expect(node.description).toBe("更长的描述说明");
    expect(node.content).toBe("更长更完整的内容说明文档");
  });

  it("name 自动标准化：大写→小写，空格→连字符", () => {
    upsertNode(db, {
      type: "SKILL", name: "Docker Port Expose",
      description: "test", content: "test",
    }, "s1");

    const found = findByName(db, "docker-port-expose");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("docker-port-expose");
  });

  it("upsertNode UPDATE 时合并 flags（union），不覆盖已有 flags", () => {
    // 第一次插入，带 flags
    const { node: n1 } = upsertNode(db, {
      type: "TASK", name: "flag-test",
      description: "测试 flags 合并", content: "内容",
      flags: ["hot"],
    }, "s1");
    expect(n1.flags).toContain("hot");

    // 第二次用不同 session 更新，传入不同 flags
    const { node: n2, isNew } = upsertNode(db, {
      type: "TASK", name: "flag-test",
      description: "更新描述", content: "新内容",
      flags: ["reviewed"],
    }, "s2");
    expect(isNew).toBe(false);
    // 两次 flags 都保留（union）
    expect(n2.flags).toContain("hot");
    expect(n2.flags).toContain("reviewed");
  });

  it("deprecate 标记节点失效", () => {
    const { node } = upsertNode(db, {
      type: "EVENT", name: "old-error",
      description: "旧错误", content: "已过时",
    }, "s1");

    deprecate(db, node.id);
    const after = findById(db, node.id);
    expect(after!.status).toBe("deprecated");
  });

  it("upsertNode 复活 deprecated 节点", () => {
    // 第一次插入
    const { node: n1 } = upsertNode(db, {
      type: "TASK", name: "revive-test",
      description: "v1", content: "内容",
    }, "s1");
    // 标记为 deprecated
    deprecate(db, n1.id);
    // 再次 upsert 同一 name，节点应自动复活
    const { node: n2, isNew } = upsertNode(db, {
      type: "TASK", name: "revive-test",
      description: "v2", content: "新内容",
    }, "s1");
    expect(isNew).toBe(false);
    expect(n2.status).toBe("active");
    expect(n2.description).toBe("v2");
    expect(n2.content).toBe("新内容");
  });

  it("setNodeFlags 复活 deprecated 节点", () => {
    // 第一次插入
    const { node } = upsertNode(db, {
      type: "TASK", name: "revive-test-2",
      description: "待复活", content: "内容",
    }, "s1");
    // 标记为 deprecated
    deprecate(db, node.id);
    // 通过 setNodeFlags 复活
    setNodeFlags(db, node.id, ["hot"]);
    const after = findByName(db, "revive-test-2");
    expect(after!.status).toBe("active");
    expect(after!.flags).toContain("hot");
  });

  it("findByName 找不到返回 null", () => {
    expect(findByName(db, "not-exist")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 边 CRUD
// ═══════════════════════════════════════════════════════════════

describe("edge CRUD", () => {
  it("upsertEdge 创建边", () => {
    const a = insertNode(db, { name: "task-a", type: "TASK" });
    const b = insertNode(db, { name: "skill-b", type: "SKILL" });

    upsertEdge(db, {
      fromId: a, toId: b,
      name: "使用",
      description: "第 1 步使用", sessionId: "s1",
    });

    const from = edgesFrom(db, a);
    const to = edgesTo(db, b);
    expect(from).toHaveLength(1);
    expect(to).toHaveLength(1);
    expect(from[0].name).toBe("使用");
  });

  it("upsertEdge 同 from+to+name 更新 description 而非重复", () => {
    const a = insertNode(db, { name: "task-a", type: "TASK" });
    const b = insertNode(db, { name: "skill-b", type: "SKILL" });

    upsertEdge(db, { fromId: a, toId: b, name: "使用", description: "v1", sessionId: "s1" });
    upsertEdge(db, { fromId: a, toId: b, name: "使用", description: "v2", sessionId: "s2" });

    const edges = edgesFrom(db, a);
    expect(edges).toHaveLength(1);
    expect(edges[0].description).toBe("v2");
  });
});

// ═══════════════════════════════════════════════════════════════
// 节点合并
// ═══════════════════════════════════════════════════════════════

describe("mergeNodes", () => {
  it("合并后边迁移、被合并节点 deprecated", () => {
    const a = insertNode(db, { name: "keep-node", validatedCount: 5 });
    const b = insertNode(db, { name: "merge-node", validatedCount: 3 });
    const c = insertNode(db, { name: "other-node" });

    insertEdge(db, { fromId: b, toId: c, name: "SOLVED_BY" });

    mergeNodes(db, a, b);

    // b 应该 deprecated
    const bAfter = findById(db, b);
    expect(bAfter!.status).toBe("deprecated");

    // a 的 validatedCount = 5 + 3 = 8
    const aAfter = findById(db, a);
    expect(aAfter!.validatedCount).toBe(8);

    // 边应该迁移到 a
    const edges = edgesFrom(db, a);
    expect(edges.some(e => e.toId === c)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FTS5 搜索
// ═══════════════════════════════════════════════════════════════

describe("FTS5 search", () => {
  it("按关键词搜索节点", () => {
    upsertNode(db, {
      type: "SKILL", name: "docker-compose-up",
      description: "启动 Docker Compose 服务",
      content: "docker compose up -d",
    }, "s1");

    upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "创建 conda 环境",
      content: "conda create -n myenv python=3.10",
    }, "s1");

    const results = searchNodes(db, "docker", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("docker-compose-up");
  });

  it("搜索空字符串返回 topNodes", () => {
    insertNode(db, { name: "node-a", validatedCount: 10 });
    insertNode(db, { name: "node-b", validatedCount: 1 });

    const results = searchNodes(db, "", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 图遍历
// ═══════════════════════════════════════════════════════════════

describe("graphWalk", () => {
  it("从种子节点遍历 1 跳", () => {
    const a = insertNode(db, { name: "seed" });
    const b = insertNode(db, { name: "neighbor-1" });
    const c = insertNode(db, { name: "neighbor-2" });
    const d = insertNode(db, { name: "far-away" });

    insertEdge(db, { fromId: a, toId: b });
    insertEdge(db, { fromId: a, toId: c });
    insertEdge(db, { fromId: c, toId: d });

    const { nodes, edges } = graphWalk(db, [a], 1);

    // 1 跳应该找到 a, b, c（不包括 d）
    const names = nodes.map(n => n.name).sort();
    expect(names).toContain("seed");
    expect(names).toContain("neighbor-1");
    expect(names).toContain("neighbor-2");
    expect(names).not.toContain("far-away");
  });

  it("2 跳能到达更远的节点", () => {
    const a = insertNode(db, { name: "seed" });
    const b = insertNode(db, { name: "hop-1" });
    const c = insertNode(db, { name: "hop-2" });

    insertEdge(db, { fromId: a, toId: b });
    insertEdge(db, { fromId: b, toId: c });

    const { nodes } = graphWalk(db, [a], 2);
    expect(nodes.map(n => n.name)).toContain("hop-2");
  });

  it("空种子返回空", () => {
    const { nodes, edges } = graphWalk(db, [], 2);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("maxNodes cap is enforced inside a hub-heavy expansion", () => {
    const seed = insertNode(db, { name: "hub-seed" });
    for (let i = 0; i < 20; i++) {
      const child = insertNode(db, { name: `hub-child-${i}` });
      insertEdge(db, { fromId: seed, toId: child, name: "links" });
    }

    const { nodes } = graphWalk(db, [seed], 1, 5);
    expect(nodes).toHaveLength(5);
    expect(nodes.map(n => n.name)).toContain("hub-seed");
  });
});

// ═══════════════════════════════════════════════════════════════
// 消息 + 信号
// ═══════════════════════════════════════════════════════════════

describe("messages & signals", () => {
  it("saveMessage + getUnextracted + markExtracted", () => {
    saveMessage(db, "s1", 1, "user", "hello");
    saveMessage(db, "s1", 2, "assistant", "hi");
    saveMessage(db, "s1", 3, "user", "help me");

    let unext = getUnextracted(db, "s1", 10);
    expect(unext).toHaveLength(3);

    markExtracted(db, "s1", 2);
    unext = getUnextracted(db, "s1", 10);
    expect(unext).toHaveLength(1);
    expect(unext[0].turn_index).toBe(3);
  });

  it("getRecentExtractedMessages handles maxTurn 0", () => {
    saveMessage(db, "s-turn0", 0, "user", "first turn");
    markExtracted(db, "s-turn0", 0);

    const recent = getRecentExtractedMessages(db, "s-turn0", 1);
    expect(recent).toHaveLength(1);
    expect(recent[0].turn_index).toBe(0);
  });

  it("saveSignal + pendingSignals + markSignalsDone", () => {
    saveSignal(db, "s1", { type: "tool_error", turnIndex: 3, data: { snippet: "Error: xxx" } });
    saveSignal(db, "s1", { type: "task_completed", turnIndex: 5, data: { snippet: "done" } });

    let pending = pendingSignals(db, "s1");
    expect(pending).toHaveLength(2);
    expect(pending[0].type).toBe("tool_error");

    markSignalsDone(db, "s1");
    pending = pendingSignals(db, "s1");
    expect(pending).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 统计
// ═══════════════════════════════════════════════════════════════

describe("getStats", () => {
  it("正确统计节点和边", () => {
    const a = insertNode(db, { name: "skill-1", type: "SKILL" });
    const b = insertNode(db, { name: "task-1", type: "TASK" });
    insertEdge(db, { fromId: b, toId: a, name: "USED_SKILL" });

    const stats = getStats(db);
    expect(stats.totalNodes).toBe(2);
    expect(stats.byType["SKILL"]).toBe(1);
    expect(stats.byType["TASK"]).toBe(1);
    expect(stats.totalEdges).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// SQLite test copy helpers
// ═══════════════════════════════════════════════════════════════

describe("copySqliteDatabaseConsistently", () => {
  it("copies a WAL-mode database as a readable standalone snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-wal-copy-test-"));
    const srcPath = join(dir, "src.db");
    const dstPath = join(dir, "dst.db");
    const src = new DatabaseSync(srcPath);
    try {
      src.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO items (value) VALUES ('from-wal');
      `);
      copySqliteDatabaseConsistently(srcPath, dstPath);
    } finally {
      src.close();
    }

    const dst = new DatabaseSync(dstPath);
    try {
      const row = dst.prepare("SELECT value FROM items WHERE id=1").get() as any;
      expect(row.value).toBe("from-wal");
    } finally {
      dst.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// composable transactions
// ═══════════════════════════════════════════════════════════════

describe("withTransaction", () => {
  it("composes store helpers inside an outer transaction", () => {
    const node = insertNode(db, { name: "tx-node" });
    saveVector(db, node, "tx-vector", [1, 0, 0]);

    withTransaction(db, () => {
      updatePageranks(db, new Map([[node, 0.42]]));
      markVectorsDedupChecked(db, [node], 1234);
      recordNodeAccessBatch(db, [node], 5678);
      setScopesForSession(db, "session-tx", ["scope-a", "scope-b"]);
    });

    const row = db.prepare("SELECT pagerank, access_count, last_accessed_at FROM gm_nodes WHERE id=?").get(node) as any;
    expect(row.pagerank).toBeCloseTo(0.42);
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at).toBe(5678);
    const vector = db.prepare("SELECT dedup_checked_at FROM gm_vectors WHERE node_id=?").get(node) as any;
    expect(vector.dedup_checked_at).toBe(1234);
    expect(db.prepare("SELECT COUNT(*) AS c FROM gm_scopes WHERE session_id='session-tx'").get() as any).toMatchObject({ c: 2 });
  });

  it("rolls back nested helper changes on outer transaction failure", () => {
    const node = insertNode(db, { name: "tx-rollback-node" });
    saveVector(db, node, "tx-vector", [1, 0, 0]);

    expect(() => withTransaction(db, () => {
      updatePageranks(db, new Map([[node, 0.99]]));
      markVectorsDedupChecked(db, [node], 4321);
      throw new Error("boom");
    })).toThrow("boom");

    const row = db.prepare("SELECT pagerank FROM gm_nodes WHERE id=?").get(node) as any;
    expect(row.pagerank).toBe(0);
    const vector = db.prepare("SELECT dedup_checked_at FROM gm_vectors WHERE node_id=?").get(node) as any;
    expect(vector.dedup_checked_at).toBe(0);
  });

  it("rolls back only the inner savepoint when an inner transaction fails and is caught", () => {
    const keep = insertNode(db, { name: "tx-keep" });
    const inner = insertNode(db, { name: "tx-inner" });

    withTransaction(db, () => {
      updatePageranks(db, new Map([[keep, 0.25]]));
      try {
        withTransaction(db, () => {
          updatePageranks(db, new Map([[inner, 0.75]]));
          throw new Error("inner");
        });
      } catch {
        // outer transaction should continue after rolling back the inner savepoint
      }
    });

    expect((db.prepare("SELECT pagerank FROM gm_nodes WHERE id=?").get(keep) as any).pagerank).toBeCloseTo(0.25);
    expect((db.prepare("SELECT pagerank FROM gm_nodes WHERE id=?").get(inner) as any).pagerank).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// vector search
// ═══════════════════════════════════════════════════════════════

describe("vector search", () => {
  it("returns the same top-K ordering without full sorting", () => {
    const x = insertNode(db, { name: "vec-x" });
    const y = insertNode(db, { name: "vec-y" });
    const z = insertNode(db, { name: "vec-z" });
    saveVector(db, x, "x", [1, 0, 0]);
    saveVector(db, y, "y", [0.9, 0.1, 0]);
    saveVector(db, z, "z", [0, 1, 0]);

    const results = vectorSearchWithScore(db, [1, 0, 0], 2, -1);
    expect(results.map(r => r.node.name)).toEqual(["vec-x", "vec-y"]);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it("checks cooperative deadline before scanning vectors", () => {
    const x = insertNode(db, { name: "vec-deadline" });
    saveVector(db, x, "x", [1, 0, 0]);
    expect(() => vectorSearchWithScore(db, [1, 0, 0], 1, -1, { deadlineAt: Date.now() - 1 })).toThrow(/deadline/);
  });
});

// ═══════════════════════════════════════════════════════════════
// 按 session 查询
// ═══════════════════════════════════════════════════════════════

describe("getBySession", () => {
  it("精确匹配 session ID", () => {
    insertNode(db, { name: "node-s1", sessions: ["session-abc"] });
    insertNode(db, { name: "node-s2", sessions: ["session-xyz"] });

    const result = getBySession(db, "session-abc");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("node-s1");
  });

  // ═══════════════════════════════════════════════════════════════
  // upsertEdge 跳过 deprecated 节点
  // ═══════════════════════════════════════════════════════════════

  it("upsertEdge 跳过连接到 deprecated 节点的边", () => {
    // 创建两个节点
    upsertNode(db, { type: "KNOWLEDGE", name: "node-a", description: "a", content: "a" }, "s1");
    upsertNode(db, { type: "KNOWLEDGE", name: "node-b", description: "b", content: "b" }, "s1");
    upsertNode(db, { type: "KNOWLEDGE", name: "node-c", description: "c", content: "c" }, "s1");

    const aId = findByName(db, "node-a")!.id;
    const bId = findByName(db, "node-b")!.id;
    const cId = findByName(db, "node-c")!.id;

    // 把 node-b 标记为 deprecated
    deprecate(db, bId);

    // 建三条边：a→b（deprecated）、a→c（active）、b→c（deprecated）
    upsertEdge(db, { fromId: aId, toId: bId, name: "ab-edge", description: "应被跳过", sessionId: "s1" });
    upsertEdge(db, { fromId: aId, toId: cId, name: "ac-edge", description: "应被创建", sessionId: "s1" });
    upsertEdge(db, { fromId: bId, toId: cId, name: "bc-edge", description: "应被跳过", sessionId: "s1" });

    const edges = db.prepare("SELECT * FROM gm_edges ORDER BY name").all() as any[];

    // 只有 a→c 这条边应该存在
    expect(edges).toHaveLength(1);
    expect(edges[0].name).toBe("ac-edge");
    expect(edges[0].from_id).toBe(aId);
    expect(edges[0].to_id).toBe(cId);
  });
});
// ═══════════════════════════════════════════════════════════════
// updateNodeFields 支持 type
// ═══════════════════════════════════════════════════════════════

import { updateNodeFields } from "../src/store/store.ts";

describe("updateNodeFields", () => {
  it("修改节点类型", () => {
    upsertNode(db, { type: "SKILL", name: "docker-up", description: "启动容器", content: "docker compose up" }, "s1");
    const updated = updateNodeFields(db, "docker-up", { type: "EVENT" });
    expect(updated).not.toBeNull();
    expect(updated!.type).toBe("EVENT");
  });

  it("同时修改内容和类型", () => {
    upsertNode(db, { type: "TASK", name: "task-abc", description: "旧描述", content: "旧内容" }, "s1");
    const updated = updateNodeFields(db, "task-abc", { content: "新内容", type: "KNOWLEDGE" });
    expect(updated!.content).toBe("新内容");
    expect(updated!.type).toBe("KNOWLEDGE");
  });
});

// ═══════════════════════════════════════════════════════════════
// cross-type merge（手动 gm_merge 允许跨类型）
// ═══════════════════════════════════════════════════════════════

describe("mergeNodes cross-type", () => {
  it("允许不同类型节点合并（mergeNodes 底层不校验类型）", () => {
    const a = insertNode(db, { name: "node-x", type: "SKILL" });
    const b = insertNode(db, { name: "node-y", type: "EVENT" });
    expect(a && b).toBeTruthy();
    // 直接调用 mergeNodes，不走 gm_merge tool 的类型校验
    mergeNodes(db, a, b);
    const aAfter = findById(db, a)!;
    expect(aAfter.status).toBe("active");
    const bAfter = findById(db, b)!;
    expect(bAfter.status).toBe("deprecated");
  });
});
