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

// ─── 统一节点合并去重（tier 优先级：scope_hot > hot > active > L1 > L2 > L3 > filtered）────────────
const TIER_PRIORITY: Record<RecallTier, number> = { scope_hot: 6, hot: 5, active: 4, L1: 3, L2: 2, L3: 1, filtered: 0 };

/** mergeNodes 的输出类型：GmNode + tier，不含 TieredNode 的 score 字段 */
type MergedNode = GmNode & { tier: RecallTier };

// scopeHotNodes: GmNode → tier强制为"scope_hot"（优先级最高 above hot）
// hotNodes: GmNode → tier强制为"hot"（优先级次高）
// recalledNodes: TieredNode（有tier）→ 保留原有tier
// activeNodes: GmNode（无tier）→ tier强制为"active"
function mergeNodes(
  scopeHotNodes: GmNode[],
  hotNodes: GmNode[],
  recalledNodes: TieredNode[],
  activeNodes: GmNode[],
): MergedNode[] {
  type Entry = { node: GmNode; tier: RecallTier; _priority: number };
  const map = new Map<string, Entry>();

  // scope_hot tier（最高优先）
  for (const n of scopeHotNodes) {
    map.set(n.id, { node: n, tier: "scope_hot", _priority: TIER_PRIORITY.scope_hot });
  }

  // hot tier
  for (const n of hotNodes) {
    if (!map.has(n.id) || TIER_PRIORITY.hot > (map.get(n.id)?._priority ?? 0)) {
      map.set(n.id, { node: n, tier: "hot", _priority: TIER_PRIORITY.hot });
    }
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

/**
 * KG XML Schema（精确描述实际渲染格式）
 *
 * 节点格式（5种 type）：
 *   <task name="..." desc="..." source="active|recalled" tier="scope_hot|hot|active|l1|l2|l3" confidence="0.00~1.00" updated="YYYY-MM-DD" [scope_hot="true"]>
 *     content（完整知识内容）
 *   </task>
 *   <skill ...> 同上 </skill>
 *   <event ...> 同上 </event>
 *   <knowledge ...> 同上 </knowledge>
 *   <status ...> 同上 </status>
 *   自闭合标签（如 <task name="..." tier="l3" source="recalled"/>）表示仅含 name
 *
 * 节点 tier（重要度，从高到低）：
 *  - **scope_hot**（scope 热记忆）：当前 session 所属 scope 下永久加载的记忆，永远可见
 *  - **hot**（全局热记忆）：全局永久加载的记忆，每个 session 必定注入
 *  - **active**（本 session 节点）：本轮对话中新产生的节点，compact 后需参考其上下文
 *  - **L1**（recalled top 15）：完整 content，召回评分最高的节点
 *  - **L2**（recalled 16~30）：仅 description，上下文参考
 *  - **L3**（recalled 31~45）：仅 name，提示存在相关知识域
 *  - **filtered**：不传递，不渲染
 *
 * 节点 confidence（置信度）：0.00~1.00
 *  - 1.00：完全可信（多次验证）
 *  - 0.7~0.99：可信，直接应用
 *  - 0.4~0.69：参考，谨慎验证
 *  - 0.00~0.39：低可信，使用前必须验证
 *
 * 边格式（位于 <edges> 父标签内）：
 *   <e name="边类型名" from="起点name" to="终点name">描述</e>  （有描述）
 *   <e name="边类型名" from="起点name" to="终点name"/>                     （仅边类型）
 *
 * 边类型名（部分示例）：解决、使用、依赖、扩展、冲突、触发、导致、互补、验证、修复
 *   描述说明两端节点之间的关系语义
 */

export function buildSystemPromptAddition(params: {
  selectedNodes: Array<{ type: string; src: "active" | "recalled"; tier: string }>;
  edgeCount: number;
  scopeHotCount?: number;
}): string {
  const { selectedNodes, edgeCount, scopeHotCount = 0 } = params;
  if (selectedNodes.length === 0) return "";

  const recalledCount = selectedNodes.filter(n => n.src === "recalled").length;
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
    "**⚠️ Real-time state takes priority over memory.** For current code, file state, directory structure, system environment, or version numbers — always verify with actual commands. Memory tells you how things were done before, not what is true right now.",
    "",
    `Current: ${scopeHotCount > 0 ? `${scopeHotCount} scope_hot, ` : ""}${taskCount} tasks, ${skillCount} skills, ${eventCount} events, ${knowledgeCount} knowledge, ${statusCount} status, ${edgeCount} relationships.`,
  );

  if (recalledCount > 0) {
    sections.push(
      "",
      `**${recalledCount} recalled nodes from other conversations** — proven solutions that worked before. Apply them directly when the current situation matches their trigger conditions.`,
    );
  }

  sections.push(
    "",
    "## KG 节点 tier 说明",
    "",
    "- **scope_hot**：当前 session scope 下永久加载，永远可见",
    "- **hot**：全局热记忆，每个 session 必定注入",
    "- **active**：本 session 新产生的节点，compact 后需参考上下文",
    "- **L1**：recalled top 级，完整 content，召回评分最高的节点",
    "- **L2**：recalled 中级，仅 description，上下文参考",
    "- **L3**：recalled 基础级，仅 name，提示存在相关知识域",
    "- **filtered**：不传递，不渲染",
    "",
    "## KG XML 节点格式",
    "",
    '节点格式（5种 type）：',
    '  <task name="..." desc="..." source="active|recalled" tier="scope_hot|hot|active|l1|l2|l3" confidence="0.00~1.00" updated="YYYY-MM-DD" [scope_hot="true"]>',
    '    content（完整知识内容）',
    '  </task>',
    '  <skill ...> 同上 </skill>',
    '  <event ...> 同上 </event>',
    '  <knowledge ...> 同上 </knowledge>',
    '  <status ...> 同上 </status>',
    '  自闭合标签（如 <task name="..." tier="l3" source="recalled"/>）表示仅含 name',
    "- **scope_hot / hot / active / L1**：完整 `content` + `description` + `confidence`（有完整闭合标签）",
    "- **L2**：仅 `description`，无 content（自闭合标签）",
    "- **L3**：仅 `name`（自闭合标签）",
    "",
    "## KG 置信度（confidence）说明",
    "",
    "- 1.00：完全可信，多次验证确认",
    "- 0.7~0.99：可信，相信其中知识",
    "- 0.4~0.69：参考，谨慎验证",
    "- 0.00~0.39：低可信，使用前必须验证",
    "",
    "## 如何应用召回知识",
    "",
    "1. **匹配触发条件**：当前场景与节点 `description` 一致时，直接应用其 `content`",
    "2. **检查置信度**：高置信度节点直接用，低置信度先验证",
    "3. **边导航**：沿边找关联知识（如 `解决` 边：EVENT→SKILL，`使用` 边：TASK→SKILL）",
    "4. **冲突处理**：两个 SKILL 有 `冲突` 边时，根据 description 中的互斥条件判断选哪个",
    "5. **优先新近**：STATUS 节点含 `updated` 日期，优先用更新的快照",
    "",
    "## 上下文说明",
    "",
    "- **`<episodic_context>`**：召回节点的来源 session 片段，按时间排列",
    "- **`<knowledge_graph>`**：结构化 KG，tier + confidence（格式见上方说明）",
    "",
    "主动应用召回知识。召回上下文不够时用 `gm_search` 查询，需要记录新知识时用 `gm_record`。",
  );

  if (isRich) {
    sections.push(
      "",
      "**边类型**：`解决`(EVENT→SKILL)、`使用`(TASK→SKILL)、`扩展`(SKILL更新)、`冲突`(互斥)、`依赖`、`触发`、`导致`、`互补`、`验证`、`修复` 等——description 解释具体关系语义。",
    );
  }

  return sections.join("\n");
}

// ─── 组装主函数 ──────────────────────────────────────────────

export interface AssembleParams {
  tokenBudget: number;
  scopeHotNodes: GmNode[];   // scope_hot tier nodes (from current session's scopes)
  scopeHotEdges: GmEdge[];   // edges for scope_hot nodes
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
  const { recalledNodes, hotNodes, hotEdges, scopeHotNodes, scopeHotEdges } = params;

  // ── 节点合并去重（scope_hot → hot → recalled → active）─────────────────
  const mergedNodes = mergeNodes(scopeHotNodes, hotNodes, recalledNodes, params.activeNodes);

  // 过滤 filtered
  const passNodes = mergedNodes.filter(n => n.tier !== "filtered");

  // 无节点时返回 null
  if (!passNodes.length) {
    return { xml: null, systemPrompt: "", tokens: 0, episodicXml: "", episodicTokens: 0 };
  }

  // ── 边合并去重（scope_hot → hot → active → recalled）────────────────────
  const allEdges = mergeEdges(scopeHotEdges, mergeEdges(hotEdges, mergeEdges(params.activeEdges, params.recalledEdges)));

  // ── 构建节点 id → name 映射 ───────────────────────────────
  const idToName = new Map<string, string>();
  for (const n of passNodes) idToName.set(n.id, n.name);

  // ── 构建节点 XML（统一渲染，不分社区）──────────────────────
  const xmlParts: string[] = [];

  for (const n of passNodes) {
    const tag = n.type.toLowerCase();
    const tier = n.tier;
    const srcAttr = (tier !== "L1" && tier !== "L2" && tier !== "L3") ? ` source="${tier}"` : ` source="recalled"`;  // scope_hot/hot/recalled all use "recalled"
    const tierAttr = ` tier="${tier.toLowerCase()}"`;
    const timeAttr = ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;
    const beliefAttr = n.belief !== undefined ? ` confidence="${n.belief.toFixed(2)}"` : "";

    if (tier === "L3") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}/>`);
    } else if (tier === "L2") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}/>`);
    } else {
      // scope_hot / hot / active / L1 → full content
      const scopeAttr = tier === "scope_hot" ? ` scope_hot="true"` : "";
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}${scopeAttr}>\n${n.content.trim()}\n  </${tag}>`);
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

  // ── 节点/边统计日志 ─────────────────────────────────────
  const tierCount = (tier: string) => passNodes.filter(n => n.tier === tier).length;
  const edgeCount = allEdges.length;
  console.log(
    `[graph-memory] assemble: ` +
    `scope_hot=${tierCount("scope_hot")} ` +
    `hot=${tierCount("hot")} ` +
    `active=${tierCount("active")} ` +
    `L1=${tierCount("L1")} ` +
    `L2=${tierCount("L2")} ` +
    `L3=${tierCount("L3")} ` +
    `renderedEdges=${seenEdgeIds.size} (raw=${edgeCount})`
  );

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

  const scopeHotCount = passNodes.filter(n => n.tier === "scope_hot").length;

  const systemPrompt = buildSystemPromptAddition({
    selectedNodes: passNodes.map(n => ({
      type: n.type,
      src: (n.tier === "active" ? "active" : "recalled") as "active" | "recalled",
      tier: n.tier.toLowerCase(),
    })),
    edgeCount: relevantEdges.length,
    scopeHotCount,
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
  console.log(
    `[graph-memory] assemble tokens: ` +
    `sysPrompt=${Math.ceil(systemPrompt.length / 3)} ` +
    `xml=${Math.ceil(xml.length / 3)} ` +
    `episodic=${Math.ceil(episodicXml.length / 3)} ` +
    `total=${Math.ceil(fullContent.length / 3)}`
  );
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
