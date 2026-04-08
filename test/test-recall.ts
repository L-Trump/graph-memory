import { getDb } from "./src/store/db.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { assembleContext } from "./src/format/assemble.ts";
import { DEFAULT_CONFIG } from "./src/types.ts";
import { readFileSync } from "fs";

const cfg = JSON.parse(readFileSync("/home/ltrump/.openclaw/openclaw.json", "utf-8"));
const embCfg = cfg.plugins?.entries?.["memory-lancedb-pro"]?.config?.embedding;

if (!embCfg?.apiKey) { console.error("no embedding cfg"); process.exit(1); }

const db = getDb("/tmp/gm-test-integration.db");
const embedFn = await createEmbedFn({ apiKey: embCfg.apiKey, baseURL: embCfg.baseURL, model: embCfg.model, dimensions: embCfg.dimensions });
if (!embedFn) { console.error("no embed fn"); process.exit(1); }

const recaller = new Recaller(db, { dbPath: "/tmp/gm-test-integration.db", recallMaxNodes: 50, recallMaxDepth: 1 });
recaller.setEmbedFn(embedFn);

const result = await recaller.recallV2("npm 安装 graph-memory 知识图谱");
console.log(`召回: ${result.nodes.length} 节点, ${result.edges.length} 边\n`);

const { xml } = assembleContext(db, { ...DEFAULT_CONFIG, dbPath: "/tmp/gm-test-integration.db" }, {
  tokenBudget: 128_000,
  activeNodes: [],
  activeEdges: [],
  recalledNodes: result.nodes,
  recalledEdges: result.edges,
  pprScores: result.pprScores,
  graphWalkDepth: 1,
});

console.log("XML 输出:");
console.log(xml);
