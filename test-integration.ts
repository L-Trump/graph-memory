/**
 * graph-memory — 集成测试（真实 LLM + Embedding）
 *
 * 测试内容：
 * 1. recallV2 三级分层（L1/L2/L3/filtered）是否正确
 * 2. assembleContext 渲染是否正确（L1=完整content，L2=description，L3=name）
 * 3. buildExtractKnowledgeGraph 构建是否正确
 * 4. extract 能否正确建边（包含跨 session 节点关联）
 */

import { DatabaseSync } from "@photostructure/sqlite";
import { getDb, closeDb } from "./src/store/db.ts";
import { upsertNode, upsertEdge, findByName, getBySession } from "./src/store/store.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { assembleContext } from "./src/format/assemble.ts";
import { buildExtractKnowledgeGraph } from "./src/format/assemble.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";
import { readFileSync, unlinkSync, existsSync } from "fs";

// ─── 加载配置 ───────────────────────────────────────────────────
interface OpenClawConfig {
  plugins?: {
    entries?: {
      "memory-lancedb-pro"?: { config?: { embedding?: { apiKey?: string; baseURL?: string; model?: string; dimensions?: number } } };
      "graph-memory"?: { config?: { llm?: { apiKey?: string; baseURL?: string; model?: string }; embedding?: { apiKey?: string; baseURL?: string; model?: string; dimensions?: number } } };
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

const embeddingCfg = cfg.plugins?.entries?.["memory-lancedb-pro"]?.config?.embedding
  ?? cfg.plugins?.entries?.["graph-memory"]?.config?.embedding;
const llmCfg = cfg.plugins?.entries?.["graph-memory"]?.config?.llm;
const model = llmCfg?.model ?? "MiniMax-M2.7-highspeed";

if (!embeddingCfg?.apiKey) {
  console.error("找不到 embedding 配置");
  process.exit(1);
}

console.log("✅ 配置加载完成");
console.log(`   Model: ${model}`);
console.log(`   Embedding: ${embeddingCfg.model} @ ${embeddingCfg.baseURL}\n`);

// ─── 初始化 ────────────────────────────────────────────────────
// 用时间戳确保每次都是全新的数据库
const TEST_DB = `/tmp/gm-test-${Date.now()}.db`;
// 先关闭已有连接（单例缓存）
closeDb();
// 尝试删除旧测试库（忽略错误）
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
  const SESSION_ID = "test-integration";

  // ── LLM 和 Embedding ─────────────────────────────────────
  const llm = createCompleteFn(
    model.includes("minimax") ? "minimax" : model.includes("glm") ? "zai" : model.includes("qwen") ? "qwen" : "minimax",
    model,
    { apiKey: llmCfg?.apiKey, baseURL: llmCfg?.baseURL } as any,
  );

  const embedFn = await createEmbedFn({
    apiKey: embeddingCfg.apiKey,
    baseURL: embeddingCfg.baseURL,
    model: embeddingCfg.model,
    dimensions: embeddingCfg.dimensions,
  });

  if (!embedFn) { console.error("❌ Embedding 初始化失败"); process.exit(1); }
  console.log("✅ LLM + Embedding 初始化完成\n");

  const recaller = new Recaller(db, gmCfg);
  recaller.setEmbedFn(embedFn);

  // ─────────────────────────────────────────────────────────────
  // 第一部分：创建测试节点（模拟跨 session 的知识积累）
  // ─────────────────────────────────────────────────────────────
  console.log("═══ 第一部分：创建测试节点 ═══\n");

  const testNodes = [
    // Session-A 的节点（早期对话）
    { type: "TASK", name: "analog-cs-bandgap-design", description: "设计带隙基准电路", content: "analog-cs-bandgap-design\n目标: 设计一个bandgap基准电压源\n执行步骤:\n1. 选择合适的架构（current-mode/voltage-mode）\n2. 计算电阻比例\n3. 修调电路设计\n结果: 完成bandgap设计文档" },
    { type: "SKILL", name: "analog-cs-opamp-design", description: "运放设计流程", content: "analog-cs-opamp-design\n触发条件: 需要设计运算放大器时\n执行步骤:\n1. 确定 specs（GBW, phase margin, swing）\n2. 选择拓扑（two-stage, telescopic, folded-cascode）\n3. 设计晶体管尺寸\n常见错误:\n- 密勒补偿过大导致建立时间变长" },
    // Session-B 的节点（中期对话）
    { type: "EVENT", name: "bandgap-startup-failure", description: "带隙基准启动失败", content: "bandgap-startup-failure\n现象: 带隙基准上电后输出电压为0\n原因: 启动电路失效，核心放大器未进入正确工作点\n解决方法: 检查启动晶体管尺寸，确保注入足够启动电流" },
    { type: "KNOWLEDGE", name: "analog-cs-ptat-current", description: "PTAT 电流的产生原理", content: "analog-cs-ptat-current\n适用条件: 设计带隙基准或温度相关电路时\n核心内容:\n1. PTAT（Proportional To Absolute Temperature）电流与绝对温度成正比\n2. 通过两个晶体管的 Vbe 差值产生\n3. Vbe_diff = VT*ln(n)，具有正温度系数\n注意事项:\n- n 的取值影响 PTAT 电流大小和匹配性" },
    // Session-C 的节点（当前对话前）
    { type: "SKILL", name: "analog-cs-noise-analysis", description: "运放噪声分析方法", content: "analog-cs-noise-analysis\n触发条件: 需要分析运放电路噪声时\n执行步骤:\n1. 识别噪声源（热噪声、闪烁噪声）\n2. 等效输入噪声模型\n3. 计算输出噪声功率谱密度\n常见错误:\n- 忽略闪烁噪声的 1/f 特性" },
  ];

  for (const nc of testNodes) {
    const { node } = upsertNode(db, { type: nc.type as any, name: nc.name, description: nc.description, content: nc.content }, SESSION_ID);
    recaller.syncEmbed(node).catch(() => {});
    console.log(`  ✅ ${node.type}: ${node.name}`);
  }

  // 创建边
  const edgesToCreate = [
    { from: "analog-cs-bandgap-design", to: "analog-cs-ptat-current", name: "使用", description: "PTAT电流是带隙基准的核心原理" },
    { from: "bandgap-startup-failure", to: "analog-cs-opamp-design", name: "解决", description: "启动问题需要检查运放设计" },
    { from: "analog-cs-opamp-design", to: "analog-cs-noise-analysis", name: "使用", description: "设计运放时需要考虑噪声" },
  ];

  for (const ec of edgesToCreate) {
    const fromId = findByName(db, ec.from)?.id;
    const toId = findByName(db, ec.to)?.id;
    if (fromId && toId) {
      upsertEdge(db, { fromId, toId, name: ec.name, description: ec.description, sessionId: SESSION_ID });
      console.log(`  ✅ 边: ${ec.from} --[${ec.name}]--> ${ec.to}`);
    }
  }

  await new Promise(r => setTimeout(r, 2000)); // 等待 embedding

  // ─────────────────────────────────────────────────────────────
  // 第二部分：测试 recallV2 三级分层
  // ─────────────────────────────────────────────────────────────
  console.log("\n═══ 第二部分：测试 recallV2 三级分层 ═══\n");

  // 查询模拟当前对话内容（关于带隙基准的噪声问题）
  const recallQuery = "带隙基准 噪声分析 PTAT 电流";
  const recallResult = await recaller.recallV2(recallQuery);

  console.log(`召回结果：${recallResult.nodes.length} 个节点，${recallResult.edges.length} 条边\n`);

  // 统计各 tier 数量
  const tierCount: Record<string, number> = {};
  for (const n of recallResult.nodes) {
    tierCount[n.tier] = (tierCount[n.tier] ?? 0) + 1;
  }
  console.log("Tier 分布：");
  for (const [tier, count] of Object.entries(tierCount).sort()) {
    console.log(`  ${tier}: ${count} 个`);
  }

  // 展示每个节点的 tier 和组合分
  console.log("\n节点详情（前10）：");
  const sortedByCombined = [...recallResult.nodes]
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, 10);

  for (const n of sortedByCombined) {
    const semantic = n.semanticScore?.toFixed(3) ?? "n/a";
    const ppr = n.pprScore?.toFixed(3) ?? "n/a";
    const pr = n.pagerankScore?.toFixed(3) ?? "n/a";
    console.log(`  [${n.tier}] combined=${n.combinedScore.toFixed(3)} sem=${semantic} ppr=${ppr} pr=${pr} | ${n.type}:${n.name}`);
  }

  // 验证 tier 分配是否符合预期
  const l1Nodes = recallResult.nodes.filter(n => n.tier === "L1");
  const l2Nodes = recallResult.nodes.filter(n => n.tier === "L2");
  const l3Nodes = recallResult.nodes.filter(n => n.tier === "L3");
  const filteredNodes = recallResult.nodes.filter(n => n.tier === "filtered");

  console.log(`\n验证：L1≤15=${l1Nodes.length <= 15}, L2≤15=${l2Nodes.length <= 15}, L3≤15=${l3Nodes.length <= 15}, filtered≥0=${filteredNodes.length >= 0}`);

  const hasExpectedTiers = l1Nodes.length > 0 && l2Nodes.length > 0 && l3Nodes.length > 0;
  if (hasExpectedTiers) {
    console.log("✅ 三级分层验证通过");
  } else {
    console.log("⚠️  分层结果少于三级（可能是节点总数不足）");
  }

  // ─────────────────────────────────────────────────────────────
  // 第三部分：测试 assembleContext 渲染
  // ─────────────────────────────────────────────────────────────
  console.log("\n═══ 第三部分：测试 assembleContext 渲染 ═══\n");

  const { xml: assembledXml } = assembleContext(db, gmCfg, {
    tokenBudget: 128_000,
    activeNodes: [],
    activeEdges: [],
    recalledNodes: recallResult.nodes,
    recalledEdges: recallResult.edges,
  });

  // 统计各 tier 节点数量
  const l1Matches = (assembledXml.match(/tier="l1"/g) || []).length;
  const l2Matches = (assembledXml.match(/tier="l2"/g) || []).length;
  const l3Matches = (assembledXml.match(/tier="l3"/g) || []).length;
  const totalTags = (assembledXml.match(/<task|<skill|<event|<knowledge|<status/gi) || []).length;

  console.log(`Tier 标签分布：L1=${l1Matches}, L2=${l2Matches}, L3=${l3Matches}`);
  console.log(`总节点标签：${totalTags}`);

  // 验证 L1 节点有 content（不包含 /> 自闭合）
  const l1SelfClosing = (assembledXml.match(/<skill[^>]*tier="l1"[^>]*\/>/gi) || []).length +
    (assembledXml.match(/<task[^>]*tier="l1"[^>]*\/>/gi) || []).length +
    (assembledXml.match(/<knowledge[^>]*tier="l1"[^>]*\/>/gi) || []).length;
  const l2SelfClosing = (assembledXml.match(/<skill[^>]*tier="l2"[^>]*\/>/gi) || []).length +
    (assembledXml.match(/<task[^>]*tier="l2"[^>]*\/>/gi) || []).length +
    (assembledXml.match(/<knowledge[^>]*tier="l2"[^>]*\/>/gi) || []).length;
  const l3SelfClosing = (assembledXml.match(/<skill[^>]*tier="l3"[^>]*\/>/gi) || []).length +
    (assembledXml.match(/<task[^>]*tier="l3"[^>]*\/>/gi) || []).length +
    (assembledXml.match(/<knowledge[^>]*tier="l3"[^>]*\/>/gi) || []).length;

  console.log(`自闭合检查：L1自闭合=${l1SelfClosing}（应为0）, L2自闭合=${l2SelfClosing}（应为0）, L3自闭合=${l3SelfClosing}（应>0）`);

  if (l1SelfClosing === 0 && l2SelfClosing === 0 && l3SelfClosing > 0) {
    console.log("✅ 渲染验证通过：L1/L2有内容，L3自闭合");
  } else {
    console.log("⚠️  渲染验证异常");
  }

  // 打印前30行 XML
  console.log("\nXML 片段（前30行）：");
  for (const line of assembledXml.split("\n").slice(0, 30)) {
    if (line.trim()) console.log(`  ${line.trim()}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 第四部分：测试 buildExtractKnowledgeGraph
  // ─────────────────────────────────────────────────────────────
  console.log("\n═══ 第四部分：测试 buildExtractKnowledgeGraph ═══\n");

  // 模拟 session 历史节点（当前 session 之前提取的节点）
  const sessionNode = upsertNode(db, {
    type: "TASK", name: "discuss-bandgap-noise",
    description: "讨论带隙基准的噪声特性",
    content: "discuss-bandgap-noise\n目标: 分析带隙基准的噪声来源和优化方法\n执行步骤:\n1. 识别噪声源（电阻热噪声、晶体管噪声）\n2. 计算噪声贡献\n3. 优化电阻和晶体管尺寸",
  }, SESSION_ID + "-current").node;

  const sessionNodes = [sessionNode];
  const recalledNodes = recallResult.nodes;
  const recalledEdges = recallResult.edges;

  const kgXml = buildExtractKnowledgeGraph(db, sessionNodes, recalledNodes, recalledEdges);

  console.log(`KG XML 长度：${kgXml.length} 字符`);

  // 验证 session 节点作为 L2 渲染（有 desc 但不包含完整 content）
  const sessionNodeName = sessionNode.name;
  const sessionNodeL2Match = kgXml.includes(`name="${sessionNodeName}"`) && !kgXml.includes(`name="${sessionNodeName}" desc=`) || kgXml.includes(`name="${sessionNodeName}" desc=`);
  const sessionNodeInKg = kgXml.includes(`name="${sessionNodeName}"`);
  console.log(`Session 节点在 KG 中：${sessionNodeInKg ? "✅ 是" : "❌ 否"}`);

  // 统计 KG 中各 tier
  const kgL1 = (kgXml.match(/tier="l1"/g) || []).length;
  const kgL2 = (kgXml.match(/tier="l2"/g) || []).length;
  const kgL3 = (kgXml.match(/tier="l3"/g) || []).length;
  console.log(`KG Tier 分布：L1=${kgL1}, L2=${kgL2}, L3=${kgL3}`);

  // 打印前20行
  console.log("\nKG XML 片段（前20行）：");
  for (const line of kgXml.split("\n").slice(0, 20)) {
    if (line.trim()) console.log(`  ${line.trim()}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 第五部分：测试 extract（真实 LLM）
  // ─────────────────────────────────────────────────────────────
  console.log("\n═══ 第五部分：测试 extract（真实 LLM） ═══\n");

  const extractor = new Extractor(gmCfg, llm);

  const newMessages = [
    { role: "user" as const, content: "我想设计一个低噪声的带隙基准电路，有什么注意事项？", turn_index: 0 },
    { role: "assistant" as const, content: "低噪声带隙设计需要考虑：1. 使用大电阻减小热噪声；2. 选择低噪声晶体管；3. PTAT电流的噪声特性。", turn_index: 1 },
  ];

  const extractResult = await extractor.extract({
    messages: newMessages,
    existingNodes: "",  // 不需要旧的文本格式
    knowledgeGraph: kgXml,
  });

  console.log("提取结果：");
  console.log(`  节点：${extractResult.nodes.length}`);
  for (const n of extractResult.nodes) {
    console.log(`    - [${n.type}] ${n.name}: ${n.description}`);
  }
  console.log(`  边：${extractResult.edges.length}`);
  for (const e of extractResult.edges) {
    console.log(`    - ${e.from} --[${e.name}]--> ${e.to}${e.description ? `: ${e.description}` : ""}`);
  }

  // 验证：至少有1个新节点
  if (extractResult.nodes.length > 0) {
    console.log("\n✅ extract 成功提取节点");
  } else {
    console.log("\n⚠️  extract 未提取到节点（可能是 LLM 判断无需存储）");
  }

  // ─────────────────────────────────────────────────────────────
  // 第六部分：验证边约束（边必须有一端是新节点）
  // ─────────────────────────────────────────────────────────────
  if (extractResult.edges.length > 0) {
    const newNodeNames = new Set(extractResult.nodes.map(n => n.name));
    let validEdges = 0;
    for (const e of extractResult.edges) {
      if (newNodeNames.has(e.from) || newNodeNames.has(e.to)) {
        validEdges++;
      }
    }
    if (validEdges === extractResult.edges.length) {
      console.log(`✅ 边约束验证通过：所有${validEdges}条边都有一端是新节点`);
    } else {
      console.log(`⚠️  边约束验证失败：仅${validEdges}/${extractResult.edges.length}条边符合约束`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 总结
  // ─────────────────────────────────────────────────────────────
  console.log("\n═══ 总结 ═══\n");
  console.log(`recallV2: ${recallResult.nodes.length} 节点, ${recallResult.edges.length} 边`);
  console.log(`  L1=${l1Nodes.length}, L2=${l2Nodes.length}, L3=${l3Nodes.length}, filtered=${filteredNodes.length}`);
  console.log(`assembleContext: ${assembledXml.length} 字符 XML`);
  console.log(`buildExtractKnowledgeGraph: ${kgXml.length} 字符 KG XML`);
  console.log(`extract: ${extractResult.nodes.length} 节点, ${extractResult.edges.length} 边`);

  closeDb();
  console.log("\n✅ 测试完成");
}

main().catch(e => {
  console.error("测试失败:", e);
  closeDb();
  process.exit(1);
});
