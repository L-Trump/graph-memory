/**
 * 竞态条件测试 — 模拟插件真实行为
 *
 * 插件初始化时序：
 * 1. register() 中 createEmbedFn(cfg.embedding) 返回 Promise
 * 2. Promise.then(setEmbedFn) — embedFn 在这里才被设置
 * 3. 但 register() 立即返回，插件开始处理消息
 * 4. runTurnExtract / gm_record 调用 syncEmbed — 此时 embedFn 可能还是 null
 */

import { DatabaseSync } from "@photostructure/sqlite";
import { getDb, closeDb } from "./src/store/db.ts";
import { upsertNode } from "./src/store/store.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";
import { readFileSync, unlinkSync } from "fs";

// 加载配置
interface OpenClawConfig {
  plugins?: {
    entries?: {
      "graph-memory"?: { config?: { embedding?: { apiKey?: string; baseURL?: string; model?: string; dimensions?: number } } };
    };
  };
}

let cfg: OpenClawConfig = {};
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

console.log("✅ 配置加载完成");
console.log(`   Embedding: ${embeddingCfg.model} @ ${embeddingCfg.baseURL}\n`);

// ─── 模拟插件的 register 行为 ─────────────────────────────────
const TEST_DB = `/tmp/gm-race-test-${Date.now()}.db`;
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
  console.log("═══ 竞态条件测试 ═══\n");

  // 模拟 Recaller（和插件里一样）
  const recaller = new Recaller(db, gmCfg);

  // 模拟插件 register() 中的异步初始化
  console.log("[1] 调用 createEmbedFn()（异步）...");
  const embedPromise = createEmbedFn({
    apiKey: embeddingCfg.apiKey,
    baseURL: embeddingCfg.baseURL,
    model: embeddingCfg.model,
    dimensions: embeddingCfg.dimensions,
  });

  // 模拟插件立即处理消息（不等 embedFn 初始化完成）
  console.log("[2] 插件 register() 返回，立即创建节点并调用 syncEmbed（此时 embedFn 尚未设置！）");

  const SESSION_ID = "race-test";
  const { node } = upsertNode(db, {
    type: "KNOWLEDGE",
    name: "race-test-node",
    description: "竞态条件测试节点",
    content: "race-test-node\n这是一个测试节点，用于验证 syncEmbed 在 embedFn 未初始化时的行为。",
  }, SESSION_ID);

  console.log(`[3] 节点已创建: ${node.id}`);
  console.log(`[4] 调用 syncEmbed()（embedFn=${recaller.embed ? "已设置" : "NULL！"}）`);

  // 这是关键 — 模拟插件真实行为：syncEmbed 在 embedFn 设置之前被调用
  try {
    await recaller.syncEmbed(node);
    console.log("[5] syncEmbed 返回（未抛出异常）");
  } catch (e) {
    console.error(`[5] syncEmbed 抛出异常: ${e}`);
  }

  // 等待一下，然后检查 embedFn 是否被设置了
  console.log("[6] 等待 embedPromise resolve...");
  const embedFn = await embedPromise;
  console.log(`[7] embedFn 实际初始化完成: ${embedFn ? "成功" : "失败"}`);

  // 手动设置（模拟 .then(setEmbedFn)）
  if (embedFn) {
    recaller.setEmbedFn(embedFn);
    console.log("[8] 已调用 setEmbedFn()");
  }

  // 等待一小段时间
  await new Promise(r => setTimeout(r, 1000));

  // 检查向量是否被写入
  console.log("\n[9] 检查向量是否写入数据库...");
  const vectors = db.prepare("SELECT * FROM gm_vectors").all();
  console.log(`    gm_vectors 表记录数: ${vectors.length}`);
  if (vectors.length > 0) {
    console.log(`    ✅ 向量已写入！`);
    for (const v of vectors as any[]) {
      const blob = v.embedding as Blob;
      console.log(`       node_id=${v.node_id}, embedding_bytes=${blob?.length ?? 0}`);
    }
  } else {
    console.log(`    ❌ 向量未写入！`);
    console.log(`       这是竞态条件导致的 — syncEmbed 在 embedFn 未初始化时被调用，静默失败了`);
  }

  // 再创建一个节点，用正确初始化的 embedFn
  console.log("\n[10] 创建第二个节点（embedFn 已正确初始化）...");
  const { node: node2 } = upsertNode(db, {
    type: "KNOWLEDGE",
    name: "race-test-node-2",
    description: "正常测试节点",
    content: "race-test-node-2\n这个节点在 embedFn 正确初始化后才创建。",
  }, SESSION_ID);

  await recaller.syncEmbed(node2);
  await new Promise(r => setTimeout(r, 1000));

  const vectors2 = db.prepare("SELECT * FROM gm_vectors").all();
  console.log(`    gm_vectors 表记录数: ${vectors2.length}`);
  if (vectors2.length > 1) {
    console.log(`    ✅ 第二个节点向量已写入！`);
  } else {
    console.log(`    ❌ 第二个节点向量也未写入！`);
  }

  closeDb();
  console.log("\n✅ 测试完成");
}

main().catch(e => {
  console.error("测试失败:", e);
  closeDb();
  process.exit(1);
});
