/**
 * 竞态条件测试 V2 — 精确定位向量写入问题
 */

import { DatabaseSync } from "@photostructure/sqlite";
import { getDb, closeDb } from "./src/store/db.ts";
import { upsertNode } from "./src/store/store.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";
import { readFileSync, unlinkSync } from "fs";

// 加载配置
let cfg: any = {};
try {
  const raw = readFileSync("/home/ltrump/.openclaw/openclaw.json", "utf-8");
  cfg = JSON.parse(raw);
} catch (e) {
  console.error("无法读取配置文件:", e);
  process.exit(1);
}

const embeddingCfg = cfg.plugins?.entries?.["graph-memory"]?.config?.embedding;
if (!embeddingCfg?.apiKey) {
  console.error("找不到 embedding 配置");
  process.exit(1);
}

console.log("✅ 配置加载完成\n");

const TEST_DB = `/tmp/gm-race-test2-${Date.now()}.db`;
closeDb();
try { unlinkSync(TEST_DB); } catch { /* ignore */ }

const db = getDb(`file:${TEST_DB}`);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const gmCfg: GmConfig = {
  ...DEFAULT_CONFIG,
  dbPath: `file:${TEST_DB}`,
  recallMaxDepth: 2,
};

async function main() {
  console.log("═══ 竞态条件测试 V2 ═══\n");

  // 初始化 recaller
  const recaller = new Recaller(db, gmCfg);

  // ── 场景A：embedFn 未设置就调用 syncEmbed（模拟竞态） ──
  console.log("[场景A] embedFn=NULL 时调用 syncEmbed");
  const { node: nodeA } = upsertNode(db, {
    type: "KNOWLEDGE",
    name: "scenario-a-node",
    description: "场景A测试节点",
    content: "scenario-a-node\n场景A测试内容。",
  }, "session-a");

  console.log(`  节点已创建: ${nodeA.id}`);
  console.log(`  recaller.embed = ${recaller.embed}`);

  await recaller.syncEmbed(nodeA).catch(e => console.log(`  syncEmbed 抛错: ${e}`));

  const vectorsAfterA = db.prepare("SELECT node_id, length(embedding) as emb_len FROM gm_vectors").all() as any[];
  console.log(`  向量表记录: ${JSON.stringify(vectorsAfterA)}`);

  // ── 场景B：embedFn 设置后调用 syncEmbed（正常流程） ──
  console.log("\n[场景B] embedFn 初始化后调用 syncEmbed");

  const embedFn = await createEmbedFn({
    apiKey: embeddingCfg.apiKey,
    baseURL: embeddingCfg.baseURL,
    model: embeddingCfg.model,
    dimensions: embeddingCfg.dimensions,
  });

  console.log(`  embedFn 类型: ${typeof embedFn}`);
  console.log(`  embedFn 可调用: ${typeof embedFn === "function"}`);

  recaller.setEmbedFn(embedFn);
  console.log(`  setEmbedFn 已调用`);
  console.log(`  recaller.embed = ${typeof recaller.embed}`);

  // 先测试 embedFn 本身是否工作
  console.log("\n  [测试] embedFn 直接调用...");
  try {
    const vec = await embedFn("测试文本");
    console.log(`  ✅ embedFn 成功，返回 ${vec.length} 维向量`);
  } catch (e: any) {
    console.log(`  ❌ embedFn 失败: ${e.message}`);
  }

  // 创建节点B并同步
  const { node: nodeB } = upsertNode(db, {
    type: "KNOWLEDGE",
    name: "scenario-b-node",
    description: "场景B测试节点",
    content: "scenario-b-node\n场景B测试内容。",
  }, "session-b");

  console.log(`\n  节点B已创建: ${nodeB.id}`);
  await recaller.syncEmbed(nodeB).catch(e => console.log(`  syncEmbed 抛错: ${e}`));

  const vectorsAfterB = db.prepare("SELECT node_id, length(embedding) as emb_len FROM gm_vectors").all() as any[];
  console.log(`  向量表记录: ${JSON.stringify(vectorsAfterB)}`);

  // ── 场景C：直接在 store.ts 层面测试 saveVector ──
  console.log("\n[场景C] 直接测试 saveVector");
  const { saveVector } = await import("./src/store/store.ts");

  try {
    const testVec = new Array(1024).fill(0.1);
    saveVector(db, nodeB.id, "direct-test-content", testVec);
    console.log("  ✅ saveVector 直接调用成功");

    const vectorsAfterC = db.prepare("SELECT node_id, length(embedding) as emb_len FROM gm_vectors").all() as any[];
    console.log(`  向量表记录: ${JSON.stringify(vectorsAfterC)}`);
  } catch (e: any) {
    console.log(`  ❌ saveVector 失败: ${e.message}`);
    console.log(`     ${e.stack}`);
  }

  closeDb();
  console.log("\n✅ 测试完成");
}

main().catch(e => {
  console.error("测试失败:", e);
  closeDb();
  process.exit(1);
});
