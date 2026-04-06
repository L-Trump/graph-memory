/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 三级召回分层（基于组合评分 Top K，默认 k=45）：
 * - L1 (Top 15): 完整 content
 * - L2 (Top 15-30): description
 * - L3 (Top 30-45): name
 * - filtered: 不传递
 *
 * 节点三级：
 *   完整 content | description | name
 *
 * 边二级：
 *   带 description | 仅 name
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmNode, GmEdge } from "../types.ts";
import { getEpisodicMessages } from "../store/store.ts";
import type { GmConfig } from "../types.ts";
import type { TieredNode, RecallTier } from "../recaller/recall.ts";

const CHARS_PER_TOKEN = 3;

// ─── 统一节点合并去重（tier 优先级：hot > active > L1 > L2 > L3 > filtered）────────────
const TIER_PRIORITY: Record<RecallTier, number> = { hot: 5, active: 4, L1: 3, L2: 2, L3: 1, filtered: 0 };

/** mergeNodes 的输出类型：GmNode + tier，不含 TieredNode 的 score 字段 */
type MergedNode = GmNode & { tier: RecallTier };

// hotNodes: GmNode → tier强制为"hot"（优先级最高）
// recalledNodes: TieredNode（有tier）→ 保留原有tier
// activeNodes: GmNode（无tier）→ tier强制为"active"
function mergeNodes(
  hotNodes: GmNode[],
  recalledNodes: TieredNode[],
  activeNodes: GmNode[],
): MergedNode[] {
  type Entry = { node: GmNode; tier: RecallTier; _priority: number };
  const map = new Map<string, Entry>();

  for (const n of hotNodes) {
    map.set(n.id, { node: n, tier: "hot", _priority: TIER_PRIORITY.hot });
  }

  for (const n of recalledNodes) {
    const tier = n.tier ?? "L3";
    const existing = map.get(n.id);
    if (!existing || TIER_PRIORITY[tier] > existing._priority) {
      map.set(n.id, { node: n, tier, _priority: TIER_PRIORITY[tier] ?? 0 });
    }
  }

  for (const n of activeNodes) {
    const existing = map.get(n.id);
    const priority = TIER_PRIORITY.active; // = 4
    if (!existing || priority > existing._priority) {
      map.set(n.id, { node: n, tier: "active", _priority: priority });
    }
  }

  return Array.from(map.values()).map(({ node, tier }) => ({ ...node, tier } as MergedNode));
}

// ─── 统一边合并去重（active 优先）──────────────────────────
function mergeEdges(activeEdges: GmEdge[], recalledEdges: GmEdge[]): GmEdge[] {
  const seen = new Map<string, GmEdge>();
  for (const e of recalledEdges) seen.set(e.id, e);
  for (const e of activeEdges) seen.set(e.id, e); // active 覆盖 recalled
  return Array.from(seen.values());
}

// ─── 边渲染判断：仅两端都不是 filtered 时渲染 ───────────────
function shouldRenderEdge(fromTier: RecallTier, toTier: RecallTier): boolean {
  return fromTier !== "filtered" && toTier !== "filtered";
}

// ─── 边描述判断：至少一端是 hot、active 或 L1 时带 description ──
function edgeHasDescription(fromTier: RecallTier, toTier: RecallTier): boolean {
  return fromTier === "hot" || fromTier === "active" || fromTier === "L1" ||
         toTier === "hot" || toTier === "active" || toTier === "L1";
}

// ─── 边输出 ─────────────────────────────────────────────────

function formatEdge(e: GmEdge, fromName: string, toName: string, hasDescription: boolean): string {
  if (hasDescription) {
    return `    <e name="${escapeXml(e.name)}" from="${fromName}" to="${toName}">${escapeXml(e.description)}</e>`;
  } else {
    return `    <e name="${escapeXml(e.name)}" from="${fromName}" to="${toName}"/>`;
  }
}

// ─── System Prompt 引导文字 ──────────────────────────────────

export function buildSystemPromptAddition(params: {
  selectedNodes: Array<{ type: string; src: "active" | "recalled"; tier: string }>;
  edgeCount: number;
}): string {
  const { selectedNodes, edgeCount } = params;
  if (selectedNodes.length === 0) return "";

  const recalledCount = selectedNodes.filter(n => n.src === "recalled").length;
  const hasRecalled = recalledCount > 0;
  const skillCount = selectedNodes.filter(n => n.type === "SKILL").length;
  const eventCount = selectedNodes.filter(n => n.type === "EVENT").length;
  const taskCount = selectedNodes.filter(n => n.type === "TASK").length;
  const knowledgeCount = selectedNodes.filter(n => n.type === "KNOWLEDGE").length;
  const statusCount = selectedNodes.filter(n => n.type === "STATUS").length;
  const isRich = selectedNodes.length >= 4 || edgeCount >= 3;

  const sections: string[] = [];

  sections.push(
    "## Graph Memory — 知识图谱记忆",
    "",
    "Below `<knowledge_graph>` is your accumulated experience from past conversations.",
    "It contains structured knowledge — NOT raw conversation history.",
    "",
    "**⚠️ Real-time state takes priority over memory.** The knowledge graph provides memories — for "current code content, file state, directory structure, or system environment," always verify with actual commands. Memory tells you "how things were done before," not "what is true right now."" ,
    "",
    `Current graph: ${taskCount} tasks, ${skillCount} skills, ${eventCount} events, ${knowledgeCount} knowledge, ${statusCount} status, ${edgeCount} relationships.`,
  );

  if (hasRecalled) {
    sections.push(
      "",
      `**${recalledCount} nodes recalled from OTHER conversations** — these are proven solutions that worked before.`,
      "Apply them directly when the current situation matches their trigger conditions.",
    );
  }

  sections.push(
    "",
    "## Recalled context for this query",
    "",
    "This is a context engine. The following was retrieved by semantic search for the current message:",
    "",
    "- **`<episodic_context>`** — Trimmed conversation traces from sessions that produced the knowledge nodes, ordered by time.",
    "- **`<knowledge_graph>`** — Relevant triples (TASK/SKILL/EVENT/KNOWLEDGE/STATUS) and edges, grouped by community.",
    "- **Recent 5 turns** — Last turn in full, previous 4 turns as user+assistant text only.",
    "",
    "Read this context first. Use `gm_search` only if insufficient. Use `gm_record` to save new knowledge.",
  );

  if (isRich) {
    sections.push(
      "",
      "**Graph navigation:** Edges show how knowledge connects (edge `name` is free-form, description explains the relation):",
      "- `解决`: an EVENT was fixed by a SKILL — apply the skill when you see similar errors",
      "- `使用`: a TASK used a SKILL — reuse the same approach for similar tasks",
      "- `扩展`: a newer SKILL corrects an older one — prefer the newer version",
      "- `冲突`: two SKILLs are mutually exclusive — check conditions before choosing",
    );
  }

  return sections.join("\n");
}

// ─── 组装主函数 ──────────────────────────────────────────────

export interface AssembleParams {
  tokenBudget: number;
  hotNodes: GmNode[];
  hotEdges: GmEdge[];
  activeNodes: GmNode[];
  activeEdges: GmEdge[];
  recalledNodes: TieredNode[];   // V2: TieredNode[]（带 tier 信息）
  recalledEdges: GmEdge[];
  pprScores: Record<string, number>;
  graphWalkDepth?: number;
}

/**
 * 组装知识图谱为 XML context
 *
 * 节点合并逻辑：
 * - hotNodes + recalledNodes + activeNodes 合并去重，相同 id 取更高 tier（hot > active > L1 > L2 > L3 > filtered）
 *
 * 边合并逻辑：
 * - hotEdges + activeEdges + recalledEdges 合并去重
 *
 * 边渲染规则：
 * - 两端都不是 filtered → 渲染
 * - 至少一端是 hot、active 或 L1 → 带 description
 * - 否则 → 仅渲染 name
 */
export function assembleContext(
  db: DatabaseSyncInstance,
  cfg: GmConfig | null,
  params: AssembleParams,
): { xml: string | null; systemPrompt: string; tokens: number; episodicXml: string; episodicTokens: number } {
  const { recalledNodes, hotNodes, hotEdges } = params;

  // ── 节点合并去重（hot → recalled → active）─────────────────
  const mergedNodes = mergeNodes(hotNodes, recalledNodes, params.activeNodes);

  // 过滤 filtered
  const passNodes = mergedNodes.filter(n => n.tier !== "filtered");

  // 无节点时返回 null
  if (!passNodes.length) {
    return { xml: null, systemPrompt: "", tokens: 0, episodicXml: "", episodicTokens: 0 };
  }

  // ── 边合并去重（hot → active → recalled）────────────────────
  const allEdges = mergeEdges(hotEdges, mergeEdges(params.activeEdges, params.recalledEdges));

  // ── 构建节点 id → name 映射 ───────────────────────────────
  const idToName = new Map<string, string>();
  for (const n of passNodes) idToName.set(n.id, n.name);

  // ── 构建节点 XML（统一渲染，不分社区）──────────────────────
  const xmlParts: string[] = [];

  for (const n of passNodes) {
    const tag = n.type.toLowerCase();
    const tier = n.tier;
    const srcAttr = tier === "active" ? ` source="active"` : ` source="recalled"`;
    const tierAttr = ` tier="${tier.toLowerCase()}"`;
    const timeAttr = ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;
    const beliefAttr = n.belief !== undefined ? ` confidence="${n.belief.toFixed(2)}"` : "";

    if (tier === "L3") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}/>`);
    } else if (tier === "L2") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}/>`);
    } else {
      // L1 / active
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}>\n${n.content.trim()}\n  </${tag}>`);
    }
  }

  // ── 构建边 XML ──────────────────────────────────────────
  const seenEdgeIds = new Set<string>();
  const edgesXmlParts: string[] = [];

  for (const e of allEdges) {
    if (seenEdgeIds.has(e.id)) continue;

    const fromNode = passNodes.find(n => n.id === e.fromId);
    const toNode = passNodes.find(n => n.id === e.toId);
    const fromTier = (fromNode as any)?.tier as RecallTier ?? "filtered";
    const toTier = (toNode as any)?.tier as RecallTier ?? "filtered";

    if (!shouldRenderEdge(fromTier, toTier)) continue;
    seenEdgeIds.add(e.id);

    const fromName = idToName.get(e.fromId) ?? e.fromId;
    const toName = idToName.get(e.toId) ?? e.toId;
    const hasDesc = edgeHasDescription(fromTier, toTier);
    edgesXmlParts.push(formatEdge(e, fromName, toName, hasDesc));
  }

  const nodesXml = xmlParts.join("\n");
  const edgesXml = edgesXmlParts.length
    ? `\n  <edges>\n${edgesXmlParts.join("\n")}\n  </edges>`
    : "";
  const xml = `<knowledge_graph>\n${nodesXml}${edgesXml}\n</knowledge_graph>`;

  // ── System prompt ─────────────────────────────────────────
  const relevantEdges = allEdges.filter(e => {
    if (seenEdgeIds.has(e.id)) return true;
    const fromNode = passNodes.find(n => n.id === e.fromId);
    const toNode = passNodes.find(n => n.id === e.toId);
    const fromTier = (fromNode as any)?.tier as RecallTier ?? "filtered";
    const toTier = (toNode as any)?.tier as RecallTier ?? "filtered";
    return shouldRenderEdge(fromTier, toTier);
  });

  const systemPrompt = buildSystemPromptAddition({
    selectedNodes: passNodes.map(n => ({
      type: n.type,
      src: (n.tier === "active" ? "active" : "recalled") as "active" | "recalled",
      tier: n.tier.toLowerCase(),
    })),
    edgeCount: relevantEdges.length,
  });

  // ── 溯源片段：组合评分 top 3 节点 ─────────────────────────
  const topNodes = passNodes.filter(n => n.tier !== "active").slice(0, 3);
  const episodicParts: string[] = [];

  for (const node of topNodes) {
    if (!(node as any).sourceSessions?.length) continue;
    const recentSessions = (node as any).sourceSessions.slice(-2);
    const msgs = getEpisodicMessages(db, recentSessions, node.updatedAt, 500);
    if (!msgs.length) continue;

    const lines = msgs.map(m =>
      `    [${m.role.toUpperCase()}] ${escapeXml(m.text.slice(0, 200))}`
    ).join("\n");
    episodicParts.push(`  <trace node="${node.name}">\n${lines}\n  </trace>`);
  }

  const episodicXml = episodicParts.length
    ? `<episodic_context>\n${episodicParts.join("\n")}\n</episodic_context>`
    : "";

  const fullContent = systemPrompt + "\n\n" + xml + (episodicXml ? "\n\n" + episodicXml : "");
  return {
    xml,
    systemPrompt,
    tokens: Math.ceil(fullContent.length / CHARS_PER_TOKEN),
    episodicXml,
    episodicTokens: Math.ceil(episodicXml.length / CHARS_PER_TOKEN),
  };
}

// ─── Extract 用知识图谱 ──────────────────────────────────────

// extract 阶段不处理的节点类型（由 topic induction 阶段管理）
const EXTRACT_EXCLUDED_TYPES = new Set(["TOPIC"]);

/**
 * 为 extraction 构建知识图谱 XML
 *
 * 合并两类节点：
 * - sessionNodes：当前 session 的历史节点（作为 L2，仅传 description）
 * - recalledNodes：上次 recallV2 召回的节点（保持原有 tier：L1/L2/L3）
 * - recalledEdges：上次 recallV2 召回的边
 *
 * 合并策略：相同节点保留更高 tier 的
 *
 * 节点渲染规则（三级分层，无 graphWalk）：
 * - L1: 完整 content
 * - L2: description
 * - L3: name
 * - filtered: 不渲染
 *
 * 边渲染规则：两端都在渲染节点中（L1/L2/L3）且至少一端为 L1/L2
 *
 * 注意：TOPIC 节点会被过滤，不参与 extraction（由 topic induction 阶段单独管理）
 */
export function buildExtractKnowledgeGraph(
  db: DatabaseSyncInstance,
  sessionNodes: GmNode[],
  recalledNodes: TieredNode[],
  sessionEdges: GmEdge[],
  recalledEdges: GmEdge[],
): string {
  // ── 合并去重 ────────────────────────────────────────────
  type Entry = { node: GmNode; tier: RecallTier };
  const merged = new Map<string, Entry>();

  // recalled nodes 入场（保持原有 tier），过滤 TOPIC 类型
  for (const n of recalledNodes) {
    if (n.tier !== "filtered" && !EXTRACT_EXCLUDED_TYPES.has(n.type)) {
      merged.set(n.id, { node: n, tier: n.tier });
    }
  }

  // session nodes 入场（作为 L2），保留更高 tier，过滤 TOPIC 类型
  for (const n of sessionNodes) {
    if (EXTRACT_EXCLUDED_TYPES.has(n.type)) continue;
    const existing = merged.get(n.id);
    if (!existing || TIER_PRIORITY["L2"] > TIER_PRIORITY[existing.tier]) {
      merged.set(n.id, { node: n, tier: "L2" });
    }
  }

  // 过滤 filtered
  const passNodes: Entry[] = [];
  for (const entry of merged.values()) {
    if (entry.tier !== "filtered") passNodes.push(entry);
  }

  if (!passNodes.length) return "";

  // ── id → name 映射 ──────────────────────────────────────
  const idToName = new Map<string, string>();
  for (const { node } of passNodes) idToName.set(node.id, node.name);

  // ── 构建节点 XML（统一渲染，不分社区）──────────────────────
  // L1: 完整 content；L2: description；L3: name
  const xmlParts: string[] = [];

  for (const entry of passNodes) {
    const n = entry.node;
    const tag = n.type.toLowerCase();
    const tierAttr = ` tier="${entry.tier.toLowerCase()}"`;

    if (entry.tier === "L3") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}"${tierAttr}/>`);
    } else if (entry.tier === "L2") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${tierAttr}/>`);
    } else {
      // L1
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${tierAttr}>\n${n.content.trim()}\n  </${tag}>`);
    }
  }

  // ── 构建边 XML ─────────────────────────────────────────
  // 统一处理：sessionEdges + recalledEdges 合并，对合并后的节点集应用 L1/L2 过滤
  const passIdSet = new Set(passNodes.map(e => e.node.id));
  const edgesXmlParts: string[] = [];
  const seenEdgeIds = new Set<string>();

  // 合并所有边，统一去重
  const allEdges = [...sessionEdges, ...recalledEdges];

  for (const e of allEdges) {
    if (!passIdSet.has(e.fromId) || !passIdSet.has(e.toId)) continue;
    if (seenEdgeIds.has(e.id)) continue;
    seenEdgeIds.add(e.id);

    const fromEntry = passNodes.find(ep => ep.node.id === e.fromId);
    const toEntry = passNodes.find(ep => ep.node.id === e.toId);
    const fromTier = fromEntry?.tier ?? "filtered";
    const toTier = toEntry?.tier ?? "filtered";

    // 至少一端为 L1/L2
    const hasL1L2 = (fromTier === "L1" || fromTier === "L2") || (toTier === "L1" || toTier === "L2");
    if (!hasL1L2) continue;

    const fromName = idToName.get(e.fromId) ?? e.fromId;
    const toName = idToName.get(e.toId) ?? e.toId;
    const hasDescription = fromTier === "L1" || toTier === "L1";
    edgesXmlParts.push(formatEdge(e, fromName, toName, hasDescription));
  }

  const edgesXml = edgesXmlParts.length
    ? `\n  <edges>\n${edgesXmlParts.join("\n")}\n  </edges>`
    : "";

  if (!xmlParts.length) return "";
  return `<knowledge_graph>\n${xmlParts.join("\n")}${edgesXml}\n</knowledge_graph>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
