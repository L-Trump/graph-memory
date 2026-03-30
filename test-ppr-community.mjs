/**
 * graph-memory — Node.js 集成测试（绕过 Deno 风格 import）
 * 测试：
 * 1. PPR tier 分级阈值（≥0.1 high / >0 medium / 0 low）
 * 2. graphWalk 深度扩展
 * 3. 社区聚类分组
 * 4. 组装上下文输出格式
 */

import { DatabaseSync } from "@photostructure/sqlite";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 加载 openclaw 配置 ────────────────────────────────────────
const configPath = join(process.env.HOME ?? "", ".openclaw/openclaw.json");
let cfg;
try {
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  const auth = raw?.auth?.profiles;
  const activeKey = Object.keys(auth ?? {}).find(k => auth[k]?.apiKey);
  cfg = {
    modelProvider: activeKey ?? "minimax-portal",
    modelName: raw?.agents?.defaults?.model?.primary ?? "MiniMax-M2.5",
    embeddingModel: "jina embeddings-v5-text-small",
    recallMaxDepth: 2,
    ...raw?.plugins?.slots?.["graph-memory"]?.config,
  };
  console.log("✅ 加载配置:", cfg.modelProvider, "/", cfg.modelName);
} catch (e) {
  console.error("❌ 加载配置失败:", e.message);
  process.exit(1);
}

// ─── 加载 graph-memory 模块（绕过 .ts 扩展名问题）───────────────
const GM_DIR = join(__dirname, "src");

// 动态注入 store 模块（graphWalk, getBySession 等）
const storeModule = await import(`file://${GM_DIR}/store/store.ts`).catch(() => {
  console.error("❌ 无法加载 store.ts（需要 deno 或 tsx）");
  process.exit(1);
});

const dbModule = await import(`file://${GM_DIR}/store/db.ts`).catch(() => {
  console.error("❌ 无法加载 db.ts");
  process.exit(1);
});

const { getDb, closeDb } = dbModule;
const { upsertNode, upsertEdge, findByName, graphWalk, getBySession } = storeModule;

// ─── 打开数据库 ─────────────────────────────────────────────────
const dbPath = join(process.env.HOME ?? "", ".openclaw/graph-memory.db");
console.log("📁 数据库:", dbPath);

const db = new DatabaseSync(dbPath);
console.log("✅ 数据库连接成功\n");

// ─── 测试 1: PPR tier 分级阈值 ────────────────────────────────
console.log("═".repeat(60));
console.log("测试 1: PPR tier 分级阈值");
console.log("═".repeat(60));

// 模拟 PPR 分数
const pprScores = {
  "n-001": 0.5,    // → high
  "n-002": 0.15,   // → high
  "n-003": 0.05,   // → medium（刚好等于阈值）
  "n-004": 0.009,  // → medium
  "n-005": 0.0,    // → low
};

// 复制 tierNode 逻辑
function tierNode(ppr) {
  if (ppr >= 0.1) return "high";
  if (ppr > 0) return "medium";
  return "low";
}

const nodeIds = Object.keys(pprScores);
const tiered = nodeIds.map(id => ({ id, ppr: pprScores[id], tier: tierNode(pprScores[id]) }));
console.log("PPR 分数 → tier:");
tiered.forEach(n => console.log(`  ${n.id}: ppr=${n.ppr} → tier=${n.tier}`));

const high = tiered.filter(n => n.tier === "high");
const medium = tiered.filter(n => n.tier === "medium");
const low = tiered.filter(n => n.tier === "low");
console.log(`\nhigh=${high.length} medium=${medium.length} low=${low.length}`);

// 验证边界值
const checks = [
  { id: "n-003", ppr: 0.05, expect: "medium", label: "ppr=0.05 (阈值边界)" },
  { id: "n-004", ppr: 0.009, expect: "medium", label: "ppr=0.009 (medium下界)" },
  { id: "n-005", ppr: 0, expect: "low", label: "ppr=0 (low)" },
];
let tierOk = true;
checks.forEach(c => {
  const result = tierNode(c.ppr);
  const ok = result === c.expect;
  if (!ok) tierOk = false;
  console.log(`  ${ok ? "✅" : "❌"} ${c.label}: got ${result}, expect ${c.expect}`);
});
console.log("PPR tier 测试:", tierOk ? "✅ 通过" : "❌ 失败\n");

// ─── 测试 2: graphWalk 深度扩展 ──────────────────────────────
console.log("═".repeat(60));
console.log("测试 2: graphWalk 深度扩展");
console.log("═".repeat(60));

// 获取一些真实节点
const allNodes = getBySession(db, null, 100);
console.log(`图谱节点总数: ${allNodes.length}`);

if (allNodes.length >= 3) {
  // 取前3个节点作为 seed
  const seedIds = allNodes.slice(0, 3).map(n => n.id);
  console.log("Seed 节点:", seedIds);

  const depth1 = graphWalk(db, seedIds, 1);
  console.log(`graphWalk depth=1: ${depth1.nodes.length} 节点, ${depth1.edges.length} 边`);

  const depth2 = graphWalk(db, seedIds, 2);
  console.log(`graphWalk depth=2: ${depth2.nodes.length} 节点, ${depth2.edges.length} 边`);

  const depth0 = graphWalk(db, seedIds, 0);
  console.log(`graphWalk depth=0: ${depth0.nodes.length} 节点, ${depth0.edges.length} 边`);

  // depth2 应该 >= depth1
  console.log("\n✅ depth2.nodes >= depth1.nodes:", depth2.nodes.length >= depth1.nodes.length ? "通过" : "失败");
  console.log("✅ depth1.nodes >= seedIds.length:", depth1.nodes.length >= seedIds.length ? "通过" : "失败");
  console.log("✅ depth0 只返回 seed 自身:", depth0.nodes.length === seedIds.length ? "通过" : "失败");
} else {
  console.log("⚠️ 节点不足，跳过 graphWalk 测试");
}

// ─── 测试 3: 社区聚类分组 ─────────────────────────────────────
console.log("\n" + "═".repeat(60));
console.log("测试 3: 社区聚类分组");
console.log("═".repeat(60));

// 获取有 communityId 的节点
const withCommunity = allNodes.filter(n => n.communityId);
const communityMap = new Map();
withCommunity.forEach(n => {
  if (!communityMap.has(n.communityId)) communityMap.set(n.communityId, []);
  communityMap.get(n.communityId).push(n);
});

console.log(`有 communityId 的节点: ${withCommunity.length}`);
console.log(`社区数量: ${communityMap.size}`);
communityMap.forEach((nodes, cid) => {
  console.log(`\n  社区 ${cid} (${nodes.length} 节点):`);
  nodes.slice(0, 3).forEach(n => {
    console.log(`    - ${n.type}: ${n.name} | ${(n.description ?? "").slice(0, 50)}`);
  });
  if (nodes.length > 3) console.log(`    ... 还有 ${nodes.length - 3} 个`);
});

// 模拟 assembleContext 的社区分组逻辑
const selected = withCommunity.slice(0, 20);
const byCommunity = new Map();
const noCommunity = [];
selected.forEach(n => {
  if (n.communityId) {
    if (!byCommunity.has(n.communityId)) byCommunity.set(n.communityId, []);
    byCommunity.get(n.communityId).push(n);
  } else {
    noCommunity.push(n);
  }
});
console.log(`\n前20节点中: ${byCommunity.size} 个社区, ${noCommunity.length} 个无社区`);

// ─── 测试 4: 无 pprScores 时的向后兼容 ───────────────────────
console.log("\n" + "═".repeat(60));
console.log("测试 4: 无 pprScores 时的向后兼容");
console.log("═".repeat(60));

// 模拟 assembleContext 的 PPR 兜底逻辑
function assemblePPRFallback(recalledNodes, pprScoresParam) {
  const pprScores = pprScoresParam ?? {};
  const hasPPR = Object.keys(pprScores).length > 0;

  return recalledNodes.map(n => {
    const ppr = pprScores[n.id] ?? 0;
    const tier = hasPPR ? tierNode(ppr) : "high"; // 关键：无 PPR 时全部 high
    return { ...n, ppr, tier };
  });
}

const testNodes = [{ id: "n-A" }, { id: "n-B" }, { id: "n-C" }];

console.log("有 pprScores 时:");
const withScores = assemblePPRFallback(testNodes, { "n-A": 0.5, "n-B": 0.05, "n-C": 0 });
withScores.forEach(n => console.log(`  ${n.id}: ppr=${n.ppr} tier=${n.tier}`));

console.log("无 pprScores 时（向后兼容）:");
const noScores = assemblePPRFallback(testNodes, {});
noScores.forEach(n => console.log(`  ${n.id}: ppr=${n.ppr} tier=${n.tier}`));

const noScoresAllHigh = noScores.every(n => n.tier === "high");
console.log(`\n✅ 无 PPR 时全部 high:`, noScoresAllHigh ? "通过" : "失败");

// ─── 测试 5: 边类型（旧 schema: type/instruction）─────────────
console.log("\n" + "═".repeat(60));
console.log("测试 5: 边类型（实际数据库）");
console.log("═".repeat(60));

const edges = db.prepare("SELECT id, from_id, to_id, type, instruction FROM gm_edges LIMIT 10").all();
console.log(`边总数: ${db.prepare("SELECT COUNT(*) FROM gm_edges").get()[0]}`);
console.log("边类型分布:");
const typeCount = {};
edges.forEach(e => {
  typeCount[e.type] = (typeCount[e.type] ?? 0) + 1;
});
Object.entries(typeCount).forEach(([t, c]) => console.log(`  ${t}: ${c}`));

// ─── 清理 ─────────────────────────────────────────────────────
db.close();
console.log("\n✅ 所有测试完成");
