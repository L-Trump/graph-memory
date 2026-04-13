/**
 * graph-memory — gm_dream 真实数据库隔离测试 v3
 * 使用 /tmp/gm-test.db（真实数据库副本）
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "@photostructure/sqlite";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import {
  getRecentlyRecalledNodes,
  getRecentlyCreatedNodes,
  findById,
} from "../src/store/store.ts";

const TEST_DB = "/tmp/gm-test.db";

// 真实 buildSubgraphResult（从 index.ts 复制，tier 过滤版，无连通性过滤）
function buildSubgraphResult(roots: any[], nodes: any[], edges: any[]) {
  // 只保留 L1 节点
  const tieredNodes = nodes.filter((n: any) => n.tier === "L1");
  const nodeIds = new Set(tieredNodes.map((n: any) => n.id));
  const filteredEdges = edges.filter(
    (e: any) => nodeIds.has(e.fromId) && nodeIds.has(e.toId),
  );

  // 返回所有 L1/L2 节点（图孤立但语义相关的节点也需要被梦到）
  const allNodes = tieredNodes;
  const allNodeIds = new Set(allNodes.map((n: any) => n.id));
  const subgraphEdges = filteredEdges.filter(
    (e: any) => allNodeIds.has(e.fromId) && allNodeIds.has(e.toId),
  );

  const subgraphs = roots.map((root: any) => {
    return { seed: root.name, nodes: allNodes, edges: subgraphEdges };
  });

  return {
    seeds: roots.map((r: any) => ({
      id: r.id, name: r.name, type: r.type,
      description: r.description ?? "",
      content: (r.content ?? "").slice(0, 200),
    })),
    subgraphs,
  };
}

describe("gm_dream 真实数据库测试", () => {
  it("池A和池B有数据", () => {
    const db = new DatabaseSync(TEST_DB);
    const POOL_HOURS = 168;

    const recalled = getRecentlyRecalledNodes(db, POOL_HOURS, 50);
    const created = getRecentlyCreatedNodes(db, POOL_HOURS, 50);

    console.log(`池A（召回）: ${recalled.length} 条`);
    console.log(`池B（创建）: ${created.length} 条`);

    // 去重
    const recalledDedup = new Map<string, typeof recalled[0]>();
    for (const r of recalled) {
      if (!recalledDedup.has(r.nodeId)) recalledDedup.set(r.nodeId, r);
    }
    const createdDedup = new Map<string, typeof created[0]>();
    for (const c of created) {
      if (!createdDedup.has(c.id)) createdDedup.set(c.id, c);
    }
    console.log(`池A去重后: ${recalledDedup.size} 个独立节点`);
    console.log(`池B去重后: ${createdDedup.size} 个独立节点`);

    expect(recalled.length).toBeGreaterThan(0);
    expect(created.length).toBeGreaterThan(0);

    db.close();
  });

  it("exploreSubgraph 能召回节点（用边最多的节点，通过 id）", async () => {
    const db = new DatabaseSync(TEST_DB);
    const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });

    // 用 id，不是 name
    const seedNode = findById(db, "n-1775085785709-xgcg9");
    console.log("种子节点:", seedNode?.name, seedNode?.id);

    const result = await recaller.exploreSubgraph("n-1775085785709-xgcg9");

    console.log(`召回: roots=${result.roots.length} nodes=${result.nodes.length} edges=${result.edges.length}`);

    const l1 = result.nodes.filter((n: any) => n.tier === "L1").length;
    const l2 = result.nodes.filter((n: any) => n.tier === "L2").length;
    const l3 = result.nodes.filter((n: any) => n.tier === "L3").length;
    const filt = result.nodes.filter((n: any) => n.tier === "filtered").length;
    console.log(`L1=${l1} L2=${l2} L3=${l3} filtered=${filt}`);

    if (result.nodes.length > 0) {
      console.log(`示例: ${result.nodes[0].name} [${result.nodes[0].tier}]`);
    }

    expect(result.roots.length).toBeGreaterThan(0);

    db.close();
  });

  it("buildSubgraphResult 正确过滤 filtered 节点", async () => {
    const db = new DatabaseSync(TEST_DB);
    const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });

    const result = await recaller.exploreSubgraph("n-1775085785709-xgcg9");

    if (result.nodes.length === 0) {
      console.log("exploreSubgraph 返回 0 节点，跳过此测试");
      db.close();
      return;
    }

    const { seeds, subgraphs } = buildSubgraphResult(result.roots, result.nodes, result.edges);

    for (const sg of subgraphs) {
      const excluded = sg.nodes.filter((n: any) => n.tier === "L2" || n.tier === "L3" || n.tier === "filtered").length;
      const l1 = sg.nodes.filter((n: any) => n.tier === "L1").length;
      console.log(
        `子图 "${sg.seed}": ${sg.nodes.length} 节点 (L1=${l1}), ${sg.edges.length} 边`,
      );
      expect(excluded).toBe(0); // 不应有 L2/L3/filtered 节点
      expect(sg.nodes.length).toBe(l1); // 节点数应该等于 L1 数量
    }

    db.close();
  });

  it("gm_dream 两个锚点选中的节点", async () => {
    const db = new DatabaseSync(TEST_DB);
    const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });

    const recalled = getRecentlyRecalledNodes(db, 168, 50);
    const created = getRecentlyCreatedNodes(db, 168, 50);

    if (recalled.length === 0 || created.length === 0) {
      console.log("池为空，跳过");
      db.close();
      return;
    }

    // 取第一个候选测试
    const seedId = recalled[0].nodeId;
    const seedNode = findById(db, seedId);
    console.log("锚点节点:", seedNode?.name, seedNode?.type);

    const result = await recaller.exploreSubgraph(seedId);
    console.log(`召回: roots=${result.roots.length} nodes=${result.nodes.length} edges=${result.edges.length}`);

    if (result.nodes.length > 0) {
      const l1 = result.nodes.filter((n: any) => n.tier === "L1").length;
      const l2 = result.nodes.filter((n: any) => n.tier === "L2").length;
      const l3 = result.nodes.filter((n: any) => n.tier === "L3").length;
      const filt = result.nodes.filter((n: any) => n.tier === "filtered").length;
      console.log(`L1=${l1} L2=${l2} L3=${l3} filtered=${filt} (exploreSubgraph全量)`);
    }

    db.close();
  });
});
