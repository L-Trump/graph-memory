/**
 * graph-memory — gm_dream 真实数据库隔离测试
 * 使用 /tmp/gm-test.db（真实数据库副本）进行测试
 */
import { DatabaseSync } from "@photostructure/sqlite";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import {
  getRecentlyRecalledNodes,
  getRecentlyCreatedNodes,
} from "../src/store/store.ts";

// ─── 加载真实数据库副本 ─────────────────────────────────────────
const TEST_DB_PATH = "/tmp/gm-test.db";
const db = new DatabaseSync(`file:${TEST_DB_PATH}?mode=ro`, { readonly: true });
// 重新打开为读写以便某些操作（如 access_count 更新）
const dbRw = new DatabaseSync(TEST_DB_PATH);

console.log("=== gm_dream 隔离测试（真实数据库副本）===\n");

// ─── 1. 检查池状态 ──────────────────────────────────────────────
console.log("【1. 记忆池状态】");
const POOL_HOURS = 168; // 7天
const POOL_SIZE = 50;

const recalledPool = getRecentlyRecalledNodes(dbRw, POOL_HOURS, POOL_SIZE);
const createdPool = getRecentlyCreatedNodes(dbRw, POOL_HOURS, POOL_SIZE);

console.log(`  池A（最近召回，7天内）: ${recalledPool.length} 条记录`);
console.log(`  池B（最近创建，7天内）: ${createdPool.length} 条记录`);

// 去重
const recalledDedup = new Map<string, typeof recalledPool[0]>();
for (const r of recalledPool) {
  if (!recalledDedup.has(r.nodeId)) recalledDedup.set(r.nodeId, r);
}
const createdDedup = new Map<string, typeof createdPool[0]>();
for (const c of createdPool) {
  if (!createdDedup.has(c.id)) createdDedup.set(c.id, c);
}
console.log(`  池A去重后: ${recalledDedup.size} 个独立节点`);
console.log(`  池B去重后: ${createdDedup.size} 个独立节点`);

// ─── 2. 指数衰减采样测试 ────────────────────────────────────────
console.log("\n【2. 指数衰减采样（lambda=0.33）】");

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

// 多次采样看分布
const SAMPLES = 5;
const recalledCandidates = Array.from(recalledDedup.values());
const createdCandidates = Array.from(createdDedup.values());

console.log(`\n  池A（召回池）采样 ${SAMPLES} 次：`);
for (let i = 0; i < SAMPLES; i++) {
  const picked = exponentialDecayPick(recalledCandidates, "recalledAt" as keyof (typeof recalledCandidates)[0], 0.33);
  if (picked) {
    const days = (Date.now() - Number(picked.recalledAt)) / 86_400_000;
    console.log(`    选中: ${picked.nodeName} (${days.toFixed(1)} 天前)`);
  }
}

console.log(`\n  池B（创建池）采样 ${SAMPLES} 次：`);
for (let i = 0; i < SAMPLES; i++) {
  const picked = exponentialDecayPick(createdCandidates, "createdAt" as keyof (typeof createdCandidates)[0], 0.33);
  if (picked) {
    const days = (Date.now() - Number(picked.createdAt)) / 86_400_000;
    console.log(`    选中: ${picked.name} (${days.toFixed(1)} 天前)`);
  }
}

// ─── 3. exploreSubgraph + tier 过滤测试 ─────────────────────────
console.log("\n【3. exploreSubgraph + tier 过滤】");
const recaller = new Recaller(dbRw, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });

// 用池A的候选节点测试
if (recalledCandidates.length > 0) {
  // 取最近的3个节点分别测试
  const testNodes = recalledCandidates.slice(0, Math.min(3, recalledCandidates.length));
  for (const candidate of testNodes) {
    console.log(`\n  锚点: ${candidate.nodeName} (${candidate.nodeType})`);
    const result = await recaller.exploreSubgraph(candidate.nodeName);

    const l1 = result.nodes.filter((n: any) => n.tier === "L1").length;
    const l2 = result.nodes.filter((n: any) => n.tier === "L2").length;
    const l3 = result.nodes.filter((n: any) => n.tier === "L3").length;
    const filtered = result.nodes.filter((n: any) => n.tier === "filtered").length;
    console.log(`    召回节点: L1=${l1} L2=${l2} L3=${l3} filtered=${filtered} 总计=${result.nodes.length}`);
    console.log(`    边数: ${result.edges.length}`);

    if (result.nodes.length > 0) {
      const sampleNode = result.nodes[0];
      console.log(`    示例节点: ${sampleNode.name} [${sampleNode.type}] tier=${sampleNode.tier}`);
    }
  }
} else {
  console.log("  池A为空，跳过 exploreSubgraph 测试");
}

// ─── 4. buildSubgraphResult tier 过滤测试 ───────────────────────
console.log("\n【4. buildSubgraphResult tier 过滤验证】");

function buildSubgraphResult(
  roots: any[],
  nodes: any[],
  edges: any[],
): { seeds: any[]; subgraphs: any[] } {
  // 只保留 L1/L2/L3 节点，排除 filtered
  const tieredNodes = nodes.filter((n: any) => n.tier !== "filtered");
  const nodeIds = new Set(tieredNodes.map((n: any) => n.id));
  const filteredEdges = edges.filter(
    (e: any) => nodeIds.has(e.fromId) && nodeIds.has(e.toId),
  );

  const subgraphs = roots.map((root: any) => {
    const rootId = root.id;
    const subgraphNodes = tieredNodes.filter(
      (n: any) =>
        n.id === rootId ||
        filteredEdges.some(
          (e: any) =>
            (e.fromId === rootId && e.toId === n.id) ||
            (e.toId === rootId && e.fromId === n.id),
        ),
    );
    const subgraphNodeIds = new Set(subgraphNodes.map((n: any) => n.id));
    const subgraphEdges = filteredEdges.filter(
      (e: any) => subgraphNodeIds.has(e.fromId) && subgraphNodeIds.has(e.toId),
    );
    return { seed: root.name, nodes: subgraphNodes, edges: subgraphEdges };
  });

  return {
    seeds: roots.map((r: any) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      description: r.description ?? "",
      content: (r.content ?? "").slice(0, 200),
    })),
    subgraphs,
  };
}

if (recalledCandidates.length > 0) {
  const seedName = recalledCandidates[0].nodeName;
  const result = await recaller.exploreSubgraph(seedName);

  if (result.nodes.length > 0) {
    const { seeds, subgraphs } = buildSubgraphResult(result.roots, result.nodes, result.edges);

    console.log(`  种子: ${seeds[0]?.name}`);
    for (const sg of subgraphs) {
      const l1 = sg.nodes.filter((n: any) => n.tier === "L1").length;
      const l2 = sg.nodes.filter((n: any) => n.tier === "L2").length;
      const l3 = sg.nodes.filter((n: any) => n.tier === "L3").length;
      const filtered = sg.nodes.filter((n: any) => n.tier === "filtered").length;
      console.log(`    子图节点: L1=${l1} L2=${l2} L3=${l3} filtered=${filtered} 总计=${sg.nodes.length}`);
      console.log(`    子图边数: ${sg.edges.length}`);

      // 验证：确认没有 filtered 节点
      if (filtered > 0) {
        console.log(`    ⚠️ 警告：仍有 ${filtered} 个 filtered 节点！`);
      } else {
        console.log(`    ✓ 验证通过：无 filtered 节点`);
      }
    }
  }
}

console.log("\n=== 测试完成 ===");
db.close();
dbRw.close();
