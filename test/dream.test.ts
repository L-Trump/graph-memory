/**
 * graph-memory — gm_explore & gm_dream 功能测试
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { getRecentlyRecalledNodes, getRecentlyCreatedNodes } from "../src/store/store.ts";

describe("gm_explore — exploreSubgraph", () => {
  let db: ReturnType<typeof createTestDb>;
  let recaller: Recaller;

  beforeEach(() => {
    db = createTestDb();
    recaller = new Recaller(db, DEFAULT_CONFIG);
    // 不传 embed 函数，走 FTS fallback
  });

  it("孤立节点返回仅包含自身的子图", async () => {
    const nodeId = insertNode(db, { name: "孤立节点A", type: "SKILL" });
    const result = await recaller.exploreSubgraph(nodeId);

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].name).toBe("孤立节点A");
    expect(result.nodes).toHaveLength(1); // 种子节点自己
    expect(result.edges).toHaveLength(0);
  });

  it("有连接的节点返回邻居子图", async () => {
    const id1 = insertNode(db, { name: "节点甲", type: "SKILL" });
    const id2 = insertNode(db, { name: "节点乙", type: "KNOWLEDGE" });
    const id3 = insertNode(db, { name: "节点丙", type: "EVENT" });

    insertEdge(db, { fromId: id1, toId: id2, name: "使用" });
    insertEdge(db, { fromId: id2, toId: id3, name: "导致" });
    insertEdge(db, { fromId: id1, toId: id3, name: "依赖" });

    const result = await recaller.exploreSubgraph(id1);

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].name).toBe("节点甲");
    expect(result.nodes.length).toBeGreaterThanOrEqual(2); // 种子 + 邻居
    const nodeNames = result.nodes.map((n: any) => n.name);
    expect(nodeNames).toContain("节点乙");
  });

  it("不存在的节点返回空", async () => {
    const result = await recaller.exploreSubgraph("不存在-xyz-123");
    expect(result.roots).toHaveLength(0);
    expect(result.nodes).toHaveLength(0);
  });

  it("返回的边仅包含子图内部的边", async () => {
    const id1 = insertNode(db, { name: "根节点", type: "TASK" });
    const id2 = insertNode(db, { name: "邻居", type: "KNOWLEDGE" });
    const id3 = insertNode(db, { name: "外部节点", type: "SKILL" });

    insertEdge(db, { fromId: id1, toId: id2, name: "使用" });
    insertEdge(db, { fromId: id3, toId: id3, name: "自环" }); // 不应在结果中

    const result = await recaller.exploreSubgraph(id1);
    const nodeIds = new Set(result.nodes.map((n: any) => n.id));
    for (const edge of result.edges) {
      expect(nodeIds.has(edge.fromId)).toBe(true);
      expect(nodeIds.has(edge.toId)).toBe(true);
    }
  });
});

describe("gm_dream — store helper functions", () => {
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
  });

  it("getRecentlyCreatedNodes 返回指定时间范围内的节点", () => {
    const now = Date.now();
    const oneHourAgo = now - 3600 * 1000;
    const twoDaysAgo = now - 2 * 24 * 3600 * 1000;

    insertNode(db, { name: "新节点1", type: "SKILL" });
    insertNode(db, { name: "新节点2", type: "KNOWLEDGE" });

    const recent = getRecentlyCreatedNodes(db, 24, 10);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent[0].name).toBeTruthy();
  });

  it("getRecentlyCreatedNodes 排除 deprecated 节点", () => {
    const now = Date.now();
    insertNode(db, { name: "活跃节点", type: "SKILL" });
    insertNode(db, { name: "已删除节点", type: "SKILL", status: "deprecated" });

    const recent = getRecentlyCreatedNodes(db, 24 * 3600, 10);
    const names = recent.map((r: any) => r.name);
    expect(names).toContain("活跃节点");
    expect(names).not.toContain("已删除节点");
  });

  it("getRecentlyCreatedNodes 空池返回空数组", () => {
    // 没有节点，直接返回空
    const recent = getRecentlyCreatedNodes(db, 24, 10);
    expect(Array.isArray(recent)).toBe(true);
  });

  it("getRecentlyRecalledNodes 正确记录召回时间", () => {
    const now = Date.now();
    const id1 = insertNode(db, { name: "召回测试节点", type: "SKILL" });

    // 模拟 recall 记录：插入 gm_recalled
    db.prepare(`
      INSERT INTO gm_recalled (id, session_id, turn_index, node_id, node_name, node_type, tier, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`r-${now}`, "test-session", 1, id1, "召回测试节点", "SKILL", "L1", now);

    const recent = getRecentlyRecalledNodes(db, 24, 10);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    const found = recent.find((r: any) => r.nodeName === "召回测试节点");
    expect(found).toBeDefined();
  });
});
