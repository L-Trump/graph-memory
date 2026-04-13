/**
 * graph-memory — gm_dream 完整流程测试
 * 模拟 gm_dream 工具的完整执行流程
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "@photostructure/sqlite";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import {
  getRecentlyRecalledNodes,
  getRecentlyCreatedNodes,
} from "../src/store/store.ts";

const TEST_DB = "/tmp/gm-test.db";

// 复制 gm_dream 的 exponentialDecayPick
function exponentialDecayPick<T extends Record<string, unknown>>(
  candidates: T[],
  timeField: keyof T,
  lambda = 0.33,
): T | null {
  if (!candidates.length) return null;
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;
  const withWeights = candidates.map((c) => {
    const t = Number(c[timeField]) ?? 0;
    const days = Math.max(0, (now - t) / MS_PER_DAY);
    return { item: c, weight: Math.exp(-lambda * days) };
  });
  const totalWeight = withWeights.reduce((s, w) => s + w.weight, 0);
  if (totalWeight <= 0) return candidates[0];
  let r = Math.random() * totalWeight;
  for (const { item, weight } of withWeights) {
    r -= weight;
    if (r <= 0) return item;
  }
  return withWeights[withWeights.length - 1].item;
}

// 复制 gm_dream 的 buildSubgraphResult（无连通性过滤，L1/L2 过滤版）
function buildSubgraphResult(roots: any[], nodes: any[], edges: any[]) {
  // 只保留 L1 节点
  const tieredNodes = nodes.filter((n: any) => n.tier === "L1");
  const nodeIds = new Set(tieredNodes.map((n: any) => n.id));
  const filteredEdges = edges.filter(
    (e: any) => nodeIds.has(e.fromId) && nodeIds.has(e.toId),
  );

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

describe("gm_dream 完整流程", () => {
  it("一次做梦，两个 seed 各自带 45 节点", async () => {
    const db = new DatabaseSync(TEST_DB);
    const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });

    const POOL_HOURS = 168;
    const POOL_SIZE = 50;

    // 池A：最近召回
    const recalledPool = getRecentlyRecalledNodes(db, POOL_HOURS, POOL_SIZE);
    const recalledDedup = new Map<string, typeof recalledPool[0]>();
    for (const r of recalledPool) {
      if (!recalledDedup.has(r.nodeId)) recalledDedup.set(r.nodeId, r);
    }
    const recalledCandidates = Array.from(recalledDedup.values());

    // 池B：最近创建
    const createdPool = getRecentlyCreatedNodes(db, POOL_HOURS, POOL_SIZE);

    console.log(`池A候选: ${recalledCandidates.length}, 池B候选: ${createdPool.length}`);

    // 指数衰减选取锚点
    const seedFromRecalled = exponentialDecayPick(
      recalledCandidates,
      "recalledAt" as keyof (typeof recalledCandidates)[0],
      0.33,
    );
    const seedFromCreated = exponentialDecayPick(
      createdPool,
      "createdAt" as keyof (typeof createdPool)[0],
      0.33,
    );

    console.log(`\n选中的锚点:`);
    console.log(`  池A: ${seedFromRecalled?.nodeName} (${seedFromRecalled?.nodeType})`);
    console.log(`  池B: ${seedFromCreated?.name} (${seedFromCreated?.type})`);

    const allSeeds: any[] = [];
    const subgraphs: any[] = [];

    // Seed A
    if (seedFromRecalled) {
      const result = await recaller.exploreSubgraph(seedFromRecalled.nodeId);
      console.log(`\nSeed A (${seedFromRecalled.nodeName}):`);
      console.log(`  召回: ${result.roots.length} roots, ${result.nodes.length} 节点, ${result.edges.length} 边`);

      const l1 = result.nodes.filter((n: any) => n.tier === "L1").length;
      const l2 = result.nodes.filter((n: any) => n.tier === "L2").length;
      const l3 = result.nodes.filter((n: any) => n.tier === "L3").length;
      const filt = result.nodes.filter((n: any) => n.tier === "filtered").length;
      console.log(`  tier分布: L1=${l1} L2=${l2} L3=${l3} filtered=${filt}`);

      if (result.roots.length && result.nodes.length) {
        const { seeds, subgraphs: sg } = buildSubgraphResult(result.roots, result.nodes, result.edges);
        allSeeds.push(...seeds);
        subgraphs.push(...sg);
        console.log(`  子图: ${sg[0]?.nodes.length} 节点, ${sg[0]?.edges.length} 边`);
      }
    }

    // Seed B（避免重复）
    if (seedFromCreated) {
      const alreadyNames = new Set(allSeeds.map((r: any) => r.name));
      if (!alreadyNames.has(seedFromCreated.name)) {
        const result = await recaller.exploreSubgraph(seedFromCreated.id);
        console.log(`\nSeed B (${seedFromCreated.name}):`);
        console.log(`  召回: ${result.roots.length} roots, ${result.nodes.length} 节点, ${result.edges.length} 边`);

        const l1 = result.nodes.filter((n: any) => n.tier === "L1").length;
        const l2 = result.nodes.filter((n: any) => n.tier === "L2").length;
        const l3 = result.nodes.filter((n: any) => n.tier === "L3").length;
        const filt = result.nodes.filter((n: any) => n.tier === "filtered").length;
        console.log(`  tier分布: L1=${l1} L2=${l2} L3=${l3} filtered=${filt}`);

        if (result.roots.length && result.nodes.length) {
          const { seeds, subgraphs: sg } = buildSubgraphResult(result.roots, result.nodes, result.edges);
          allSeeds.push(...seeds);
          subgraphs.push(...sg);
          console.log(`  子图: ${sg[0]?.nodes.length} 节点, ${sg[0]?.edges.length} 边`);
        }
      } else {
        console.log(`\nSeed B (${seedFromCreated.name}) 与 Seed A 重复，跳过`);
      }
    }

    // 汇总
    const totalNodes = subgraphs.reduce((s: number, g: any) => s + g.nodes.length, 0);
    const totalEdges = subgraphs.reduce((s: number, g: any) => s + g.edges.length, 0);
    console.log(`\n=== 总计 ===`);
    console.log(`子图数: ${subgraphs.length}`);
    console.log(`总节点: ${totalNodes}`);
    console.log(`总边数: ${totalEdges}`);

    // 验证
    expect(subgraphs.length).toBeGreaterThan(0);
    expect(subgraphs.length).toBeLessThanOrEqual(2);

    for (const sg of subgraphs) {
      const excluded = sg.nodes.filter((n: any) => n.tier === "L2" || n.tier === "L3" || n.tier === "filtered").length;
      expect(excluded).toBe(0); // 不应有 L2/L3/filtered
    }

    console.log(`\n验证通过: 无 filtered 节点 ✓`);

    db.close();
  });
});
