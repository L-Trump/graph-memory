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
import { getCommunitySummary, getEpisodicMessages, graphWalk } from "../store/store.ts";
import type { GmConfig } from "../types.ts";
import type { TieredNode, RecallTier } from "../recaller/recall.ts";

const CHARS_PER_TOKEN = 3;

// ─── 节点输出（按 tier）────────────────────────────────────
// L1: 完整 content；L2: description；L3: name；filtered: 不渲染
function formatNode(n: TieredNode): string {
  if (n.tier === "filtered") return "";

  const tag = n.type.toLowerCase();
  const srcAttr = ` source="recalled"`;
  const tierAttr = ` tier="${n.tier.toLowerCase()}"`;
  const timeAttr = ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;

  if (n.tier === "L3") {
    return `    <${tag} name="${escapeXml(n.name)}"${srcAttr}${tierAttr}${timeAttr}/>`;
  } else if (n.tier === "L2") {
    return `    <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${timeAttr}/>`;
  } else {
    // L1
    return `    <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${timeAttr}>\n${n.content.trim()}\n    </${tag}>`;
  }
}

// ─── 邻居输出 ────────────────────────────────────────────────

function formatNeighbor(neighbor: GmNode, tier: RecallTier): string {
  if (tier === "L1") {
    return `      <neighbor name="${neighbor.name}" desc="${escapeXml(neighbor.description)}">\n${neighbor.content.trim()}\n      </neighbor>`;
  } else {
    // L2: 邻居只有 description
    return `      <neighbor name="${neighbor.name}" desc="${escapeXml(neighbor.description)}"/>`;
  }
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
  const isRich = selectedNodes.length >= 4 || edgeCount >= 3;

  const sections: string[] = [];

  sections.push(
    "## Graph Memory — 知识图谱记忆",
    "",
    "Below `<knowledge_graph>` is your accumulated experience from past conversations.",
    "It contains structured knowledge — NOT raw conversation history.",
    "",
    `Current graph: ${taskCount} tasks, ${skillCount} skills, ${eventCount} events, ${knowledgeCount} knowledge, ${edgeCount} relationships.`,
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
    "- **`<knowledge_graph>`** — Relevant triples (TASK/SKILL/EVENT) and edges, grouped by community.",
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

// ─── 邻居扩展 ─────────────────────────────────────────────────

/**
 * 为 L1/L2 节点扩展邻居
 * L1: 邻居完整 content；L2: 邻居 description
 */
function expandNeighbors(
  db: DatabaseSyncInstance,
  nodes: TieredNode[],
  depth = 1,
): Map<string, { node: GmNode; edges: GmEdge[] }> {
  const result = new Map<string, { node: GmNode; edges: GmEdge[] }>();

  // L1/L2 需要邻居扩展
  const needExpand = nodes.filter(n => n.tier === "L1" || n.tier === "L2");
  if (!needExpand.length) return result;

  const seedIds = needExpand.map(n => n.id);
  const { nodes: neighborNodes, edges: neighborEdges } = graphWalk(db, seedIds, depth);

  // 构建邻居映射
  for (const nn of neighborNodes) {
    if (!result.has(nn.id)) {
      result.set(nn.id, { node: nn, edges: [] });
    }
  }
  for (const e of neighborEdges) {
    const fromEntry = result.get(e.fromId);
    const toEntry = result.get(e.toId);
    if (fromEntry) fromEntry.edges.push(e);
    if (toEntry) toEntry.edges.push(e);
  }

  return result;
}

// ─── 组装主函数 ──────────────────────────────────────────────

export interface AssembleParams {
  tokenBudget: number;
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
 * L1 (Top 15): 完整 content
 * L2 (Top 15-30): description
 * L3 (Top 30-45): name
 * filtered: 不传递
 *
 * 边渲染：两端都在渲染节点中且至少一端为 L1/L2
 *
 * 组装后 PPR 重排
 */
export function assembleContext(
  db: DatabaseSyncInstance,
  cfg: GmConfig | null,
  params: AssembleParams,
): { xml: string | null; systemPrompt: string; tokens: number; episodicXml: string; episodicTokens: number } {
  const { recalledNodes, pprScores } = params;

  // ── 过滤 filtered 节点 ──────────────────────────────────
  const passNodes = recalledNodes.filter(n => n.tier !== "filtered");
  const passNodeIds = new Set(passNodes.map(n => n.id));

  // ── 按社区分组 ──────────────────────────────────────────
  const byCommunity = new Map<string, TieredNode[]>();
  const noCommunity: TieredNode[] = [];

  for (const n of passNodes) {
    if (n.communityId) {
      if (!byCommunity.has(n.communityId)) byCommunity.set(n.communityId, []);
      byCommunity.get(n.communityId)!.push(n);
    } else {
      noCommunity.push(n);
    }
  }

  // ── 构建节点 XML ─────────────────────────────────────────
  // L1: 完整 content；L2: description；L3: name
  const idToName = new Map<string, string>();
  for (const n of passNodes) idToName.set(n.id, n.name);

  const xmlParts: string[] = [];

  for (const [cid, members] of byCommunity) {
    const summary = getCommunitySummary(db, cid);
    const label = summary ? escapeXml(summary.summary) : cid;
    xmlParts.push(`  <community id="${cid}" desc="${label}">`);

    for (const n of members) {
      xmlParts.push(formatNode(n));
    }

    xmlParts.push(`  </community>`);
  }

  for (const n of noCommunity) {
    xmlParts.push(formatNode(n));
  }

  // ── 构建边 XML ──────────────────────────────────────────
  // 仅渲染：两端都在 passNodes 里 且 至少一端为 L1/L2 的边
  const edgeIdSet = new Set<string>();
  const edgesXmlParts: string[] = [];

  for (const e of params.recalledEdges) {
    if (!passNodeIds.has(e.fromId) || !passNodeIds.has(e.toId)) continue;
    const fromNode = passNodes.find(n => n.id === e.fromId);
    const toNode = passNodes.find(n => n.id === e.toId);
    const fromTier = fromNode?.tier ?? "filtered";
    const toTier = toNode?.tier ?? "filtered";
    if (fromTier === "filtered" && toTier === "filtered") continue;
    // 至少一端为 L1 或 L2
    const hasL1L2 = (fromTier === "L1" || fromTier === "L2") || (toTier === "L1" || toTier === "L2");
    if (!hasL1L2) continue;

    const fromName = idToName.get(e.fromId) ?? e.fromId;
    const toName = idToName.get(e.toId) ?? e.toId;
    // 有一端为 L1 则带 description
    const hasDescription = fromTier === "L1" || toTier === "L1";
    if (!edgeIdSet.has(e.id)) {
      edgeIdSet.add(e.id);
      edgesXmlParts.push(formatEdge(e, fromName, toName, hasDescription));
    }
  }

  const nodesXml = xmlParts.join("\n");
  const edgesXml = edgesXmlParts.length
    ? `\n  <edges>\n${edgesXmlParts.join("\n")}\n  </edges>`
    : "";

  const xml = `<knowledge_graph>\n${nodesXml}${edgesXml}\n</knowledge_graph>`;

  // ── activeNodes（当前 session）合并入主 xmlParts ─────────
  const allActiveNodes = [...params.activeNodes];
  const allActiveEdges = [...params.activeEdges];
  const activeIds = new Set(allActiveNodes.map(n => n.id));

  const activeSorted = allActiveNodes
    .sort((a, b) => b.validatedCount - a.validatedCount);

  // 无节点时返回 null（与原始行为一致）
  if (!activeSorted.length && !passNodes.length) {
    return { xml: null, systemPrompt: "", tokens: 0, episodicXml: "", episodicTokens: 0 };
  }

  const activeIdToName = new Map<string, string>();
  for (const n of activeSorted) activeIdToName.set(n.id, n.name);

  // active nodes 加入社区分组
  for (const n of activeSorted) {
    if (n.communityId) {
      if (!byCommunity.has(n.communityId)) byCommunity.set(n.communityId, []);
      byCommunity.get(n.communityId)!.push({ ...n, tier: "active" } as unknown as TieredNode);
    } else {
      noCommunity.push({ ...n, tier: "active" } as unknown as TieredNode);
    }
  }

  // 重建 byCommunity/noCommunity 的 XML（包含 active + recalled）
  const communityXmlParts: string[] = [];
  const idToNameActive = new Map<string, string>();
  for (const n of activeSorted) idToNameActive.set(n.id, n.name);

  // 有社区的节点
  for (const [cid, members] of byCommunity) {
    const summary = getCommunitySummary(db, cid);
    const label = summary ? escapeXml(summary.summary) : cid;
    communityXmlParts.push(`  <community id="${cid}" desc="${label}">`);
    for (const n of members) {
      const tag = n.type.toLowerCase();
      const srcAttr = n.tier === "active" ? ` source="active"` : ` source="recalled"`;
      const tierAttr = n.tier !== "active" ? ` tier="${n.tier.toLowerCase()}"` : ` tier="active"`;
      const timeAttr = ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;
      if (n.tier === "active") {
        communityXmlParts.push(`    <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${tierAttr}${timeAttr}>\n${n.content.trim()}\n    </${tag}>`);
      } else if (n.tier === "L3") {
        communityXmlParts.push(`    <${tag} name="${n.name}"${srcAttr}${tierAttr}${timeAttr}/>`);
      } else if (n.tier === "L2") {
        communityXmlParts.push(`    <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${tierAttr}${timeAttr}/>`);
      } else {
        communityXmlParts.push(`    <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${tierAttr}${timeAttr}>\n${n.content.trim()}\n    </${tag}>`);
      }
    }
    communityXmlParts.push(`  </community>`);
  }

  // 无社区的节点
  const renderedIds = new Set<string>();
  for (const members of byCommunity.values()) {
    for (const n of members) renderedIds.add(n.id);
  }
  for (const n of noCommunity) {
    if (renderedIds.has(n.id)) continue;
    renderedIds.add(n.id);
    const tag = n.type.toLowerCase();
    const srcAttr = n.tier === "active" ? ` source="active"` : ` source="recalled"`;
    const tierAttr = n.tier !== "active" ? ` tier="${n.tier.toLowerCase()}"` : ` tier="active"`;
    const timeAttr = ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;
    if (n.tier === "active") {
      xmlParts.push(`  <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${tierAttr}${timeAttr}>\n${n.content.trim()}\n  </${tag}>`);
    } else if (n.tier === "L3") {
      xmlParts.push(`  <${tag} name="${n.name}"${srcAttr}${tierAttr}${timeAttr}/>`);
    } else if (n.tier === "L2") {
      xmlParts.push(`  <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${tierAttr}${timeAttr}/>`);
    } else {
      xmlParts.push(`  <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${tierAttr}${timeAttr}>\n${n.content.trim()}\n  </${tag}>`);
    }
  }

  // 社区节点加入 xmlParts
  xmlParts.push(...communityXmlParts);

  // active edges 加入 edgesXmlParts
  const activeEdges = allActiveEdges.filter(e => activeIds.has(e.fromId) && activeIds.has(e.toId));
  for (const e of activeEdges) {
    const fromName = (idToNameActive.get(e.fromId) ?? idToName.get(e.fromId)) ?? e.fromId;
    const toName = (idToNameActive.get(e.toId) ?? idToName.get(e.toId)) ?? e.toId;
    edgesXmlParts.push(formatEdge(e, fromName, toName, true));
  }

  // 重建 xml（包含 recalled + active）
  const nodesXmlWithActive = xmlParts.join("\n");
  const edgesXmlWithActive = edgesXmlParts.length
    ? `\n  <edges>\n${edgesXmlParts.join("\n")}\n  </edges>`
    : "";
  const xmlWithActive = `<knowledge_graph>\n${nodesXmlWithActive}${edgesXmlWithActive}\n</knowledge_graph>`;

  // 收集相关边（两端都在 passNodeIds 里 且 至少一端为 L1/L2）
  const relevantEdges = params.recalledEdges.filter(e => {
    if (!passNodeIds.has(e.fromId) || !passNodeIds.has(e.toId)) return false;
    const fromTier = passNodes.find(n => n.id === e.fromId)?.tier ?? "filtered";
    const toTier = passNodes.find(n => n.id === e.toId)?.tier ?? "filtered";
    return (fromTier === "L1" || fromTier === "L2" || toTier === "L1" || toTier === "L2");
  });

  const systemPrompt = buildSystemPromptAddition({
    selectedNodes: [
      ...activeSorted.map(n => ({ type: n.type, src: "active" as const, tier: "active" })),
      ...passNodes.map(n => ({ type: n.type, src: "recalled" as const, tier: n.tier })),
    ],
    edgeCount: relevantEdges.length + activeEdges.length,
  });

  // ── 溯源片段：组合评分 top 3 节点 ─────────────────────────
  const topNodes = passNodes.slice(0, 3);
  const episodicParts: string[] = [];

  for (const node of topNodes) {
    if (!node.sourceSessions?.length) continue;
    const recentSessions = node.sourceSessions.slice(-2);
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

  const fullContent = systemPrompt + "\n\n" + xmlWithActive + (episodicXml ? "\n\n" + episodicXml : "");
  return {
    xml: xmlWithActive,
    systemPrompt,
    tokens: Math.ceil(fullContent.length / CHARS_PER_TOKEN),
    episodicXml,
    episodicTokens: Math.ceil(episodicXml.length / CHARS_PER_TOKEN),
  };
}

// ─── Extract 用知识图谱 ──────────────────────────────────────
const TIER_PRIORITY: Record<RecallTier, number> = { active: 4, L1: 3, L2: 2, L3: 1, filtered: 0 };

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
 */
export function buildExtractKnowledgeGraph(
  db: DatabaseSyncInstance,
  sessionNodes: GmNode[],
  recalledNodes: TieredNode[],
  recalledEdges: GmEdge[],
): string {
  // ── 合并去重 ────────────────────────────────────────────
  type Entry = { node: GmNode; tier: RecallTier };
  const merged = new Map<string, Entry>();

  // recalled nodes 入场（保持原有 tier）
  for (const n of recalledNodes) {
    if (n.tier !== "filtered") {
      merged.set(n.id, { node: n, tier: n.tier });
    }
  }

  // session nodes 入场（作为 L2），保留更高 tier
  for (const n of sessionNodes) {
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

  // ── 按社区分组 ─────────────────────────────────────────
  const byCommunity = new Map<string, Entry[]>();
  const noCommunity: Entry[] = [];

  for (const entry of passNodes) {
    const cid = entry.node.communityId;
    if (cid) {
      if (!byCommunity.has(cid)) byCommunity.set(cid, []);
      byCommunity.get(cid)!.push(entry);
    } else {
      noCommunity.push(entry);
    }
  }

  // ── id → name 映射 ──────────────────────────────────────
  const idToName = new Map<string, string>();
  for (const { node } of passNodes) idToName.set(node.id, node.name);

  // ── 构建节点 XML ─────────────────────────────────────────
  // L1: 完整 content；L2: description；L3: name
  const renderNode = (entry: Entry): string => {
    const n = entry.node;
    const tag = n.type.toLowerCase();
    const tierAttr = ` tier="${entry.tier.toLowerCase()}"`;

    if (entry.tier === "L3") {
      return `    <${tag} name="${escapeXml(n.name)}"${tierAttr}/>`;
    } else if (entry.tier === "L2") {
      return `    <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${tierAttr}/>`;
    } else {
      // L1
      return `    <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${tierAttr}>\n${n.content.trim()}\n    </${tag}>`;
    }
  };

  const xmlParts: string[] = [];

  for (const [cid, members] of byCommunity) {
    const summary = getCommunitySummary(db, cid);
    const label = summary ? escapeXml(summary.summary) : cid;
    xmlParts.push(`  <community id="${cid}" desc="${label}">`);
    for (const entry of members) {
      xmlParts.push(renderNode(entry));
    }
    xmlParts.push(`  </community>`);
  }

  for (const entry of noCommunity) {
    xmlParts.push(renderNode(entry));
  }

  // ── 构建边 XML ─────────────────────────────────────────
  // 仅渲染：两端都在 passNodes 里 且 至少一端为 L1/L2
  const passIdSet = new Set(passNodes.map(e => e.node.id));
  const edgesXmlParts: string[] = [];
  const seenEdgeIds = new Set<string>();

  for (const e of recalledEdges) {
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
