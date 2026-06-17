/**
 * graph-memory — KG XML 渲染 + system prompt 组装
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 七层召回分层（Top K=15）：
 * - scope_hot: 完整 content（scope 下永久加载）
 * - hot: 完整 content（全局热记忆）
 * - active: 完整 content（session 新节点）
 * - L1 (Top 0~5): 完整 content
 * - L2 (Top 5~10): 仅 description
 * - L3 (Top 10~15): 仅 name
 * - filtered: 不传递，不渲染
 *
 * 节点 XML 格式：
 *   scope_hot / hot / active / L1 → 完整 content + description + confidence
 *   L2 → 仅 description（自闭合标签）
 *   L3 → 仅 name（自闭合标签）
 *
 * 边 XML 格式：
 *   带 description → <e name="..." from="..." to="...">描述</e>
 *   无 description → <e name="..." from="..." to="..."/>
 */

import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmNode, GmEdge } from "../types.ts";
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
    return `    <e name="${escapeXml(e.name)}" from="${escapeXml(fromName)}" to="${escapeXml(toName)}">${escapeXml(e.description)}</e>`;
  } else {
    return `    <e name="${escapeXml(e.name)}" from="${escapeXml(fromName)}" to="${escapeXml(toName)}"/>`;
  }
}

function isAssembleDebugEnabled(cfg?: GmConfig | null, explicit = false): boolean {
  return Boolean(
    explicit ||
    cfg?.debugContextPreview ||
    process.env.GM_DEBUG === "1" ||
    process.env.GM_DEBUG_CONTEXT_PREVIEW === "1" ||
    process.env.GM_DEBUG_RUNTIME_HOOKS === "1" ||
    process.env.GM_DEBUG_RECALL_TIMING === "1"
  );
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
 *  - **L1**（recalled top 5）：完整 content，召回评分最高的节点
 *  - **L2**（recalled 6~10）：仅 description，上下文参考
 *  - **L3**（recalled 11~15）：仅 name，提示存在相关知识域
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
  selectedNodes?: Array<{ type: string; src: "active" | "recalled"; tier: string }>;
  edgeCount?: number;
  scopeHotCount?: number;
  force?: boolean;
} = {}): string {
  const { selectedNodes = [], edgeCount = 0, scopeHotCount = 0, force = false } = params;
  if (selectedNodes.length === 0 && !force) return "";

  const recalledCount = selectedNodes.filter(n => n.src === "recalled").length;
  const skillCount = selectedNodes.filter(n => n.type === "SKILL").length;
  const eventCount = selectedNodes.filter(n => n.type === "EVENT").length;
  const taskCount = selectedNodes.filter(n => n.type === "TASK").length;
  const knowledgeCount = selectedNodes.filter(n => n.type === "KNOWLEDGE").length;
  const statusCount = selectedNodes.filter(n => n.type === "STATUS").length;
  const isRich = selectedNodes.length >= 4 || edgeCount >= 3;

  const sections: string[] = [];

  // 注意：暂时注释掉实时状态行，避免 LLM 缓存 token 变化导致缓存失效
  // sections.push(
  //   `Current: ${scopeHotCount > 0 ? `${scopeHotCount} scope_hot, ` : ""}${taskCount} tasks, ${skillCount} skills, ${eventCount} events, ${knowledgeCount} knowledge, ${statusCount} status, ${edgeCount} relationships.`,
  // );

  sections.push(
    "## Graph Memory — 知识图谱记忆",
    "",
    "Below `<knowledge_graph>` is your accumulated experience from past conversations.",
    "It contains structured knowledge — NOT raw conversation history.",
    "",
    "**注意**：以下被 `<gm_memory>` 标签包裹的 `<knowledge_graph>` 内容来自记忆系统。",
    "",
    "**⚠️ Real-time state takes priority over memory.** For current code, file state, directory structure, system environment, or version numbers — always verify with actual commands. Memory tells you how things were done before, not what is true right now.",
  );

  sections.push(
    "",
    "## KG 节点 tier 说明",
    "",
    "- **scope_hot**：当前 session scope 下永久加载，永远可见",
    "- **hot**：全局热记忆，每个 session 必定注入",
    "- **active**：本 session 新产生的节点，可以作为当前session的上下文参考，compact 后需参考上下文",
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
    "6. **当前Session知识**：来源为active的节点为当前session提取出的节点，可以作为当前session的上下文参考",
    "",
    "## 上下文说明",
    "",
    "- **`<knowledge_graph>`**：结构化 KG，tier + confidence（格式见上方说明）",
    "",
    "主动应用召回知识。召回上下文不够时用 `gm_search` 查询，需要记录新知识时用 `gm_record`。",
  );

  sections.push(
    "",
    "**边类型**：`解决`(EVENT→SKILL)、`使用`(TASK→SKILL)、`扩展`(SKILL更新)、`冲突`(互斥)、`依赖`、`触发`、`导致`、`互补`、`验证`、`修复` 等——description 解释具体关系语义。",
  );

  return sections.join("\n");
}


function renderKnowledgeGraph(params: {
  nodes: MergedNode[];
  edges: GmEdge[];
  logLabel?: string;
  includeEdges?: boolean;
  includeUpdated?: boolean;
  includeConfidence?: boolean;
  sortNodes?: boolean;
  debug?: boolean;
  cfg?: GmConfig | null;
}): { xml: string | null; tokens: number; renderedEdges: number; rawEdges: number } {
  let passNodes = params.nodes.filter(n => n.tier !== "filtered");
  if (params.sortNodes) {
    passNodes = [...passNodes].sort((a, b) => {
      const tierDiff = (TIER_PRIORITY[b.tier] ?? 0) - (TIER_PRIORITY[a.tier] ?? 0);
      if (tierDiff !== 0) return tierDiff;
      const typeDiff = String(a.type).localeCompare(String(b.type));
      if (typeDiff !== 0) return typeDiff;
      const nameDiff = String(a.name).localeCompare(String(b.name));
      if (nameDiff !== 0) return nameDiff;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  if (!passNodes.length) {
    return { xml: null, tokens: 0, renderedEdges: 0, rawEdges: params.edges.length };
  }

  const idToName = new Map<string, string>();
  const idToTier = new Map<string, RecallTier>();
  for (const n of passNodes) {
    idToName.set(n.id, n.name);
    idToTier.set(n.id, n.tier);
  }

  const xmlParts: string[] = [];
  for (const n of passNodes) {
    const tag = n.type.toLowerCase();
    const tier = n.tier;
    const srcAttr = (tier !== "L1" && tier !== "L2" && tier !== "L3") ? ` source="${tier}"` : ` source="recalled"`;
    const tierAttr = ` tier="${tier.toLowerCase()}"`;
    const timeAttr = params.includeUpdated === false ? "" : ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;
    const beliefAttr = params.includeConfidence === false ? "" : n.belief !== undefined ? ` confidence="${n.belief.toFixed(2)}"` : "";

    if (tier === "L3") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}/>`);
    } else if (tier === "L2") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}/>`);
    } else {
      const scopeAttr = tier === "scope_hot" ? ` scope_hot="true"` : "";
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}${beliefAttr}${timeAttr}${scopeAttr}>\n${escapeXml(n.content.trim())}\n  </${tag}>`);
    }
  }

  const seenEdgeIds = new Set<string>();
  const edgesXmlParts: string[] = [];
  const candidateEdges = params.includeEdges === false ? [] : [...params.edges].sort((a, b) => {
    const nameDiff = String(a.name).localeCompare(String(b.name));
    if (nameDiff !== 0) return nameDiff;
    const fromDiff = String(a.fromId).localeCompare(String(b.fromId));
    if (fromDiff !== 0) return fromDiff;
    const toDiff = String(a.toId).localeCompare(String(b.toId));
    if (toDiff !== 0) return toDiff;
    return String(a.id).localeCompare(String(b.id));
  });
  for (const e of candidateEdges) {
    if (seenEdgeIds.has(e.id)) continue;

    const fromTier = idToTier.get(e.fromId) ?? "filtered";
    const toTier = idToTier.get(e.toId) ?? "filtered";

    if (!shouldRenderEdge(fromTier, toTier)) continue;
    seenEdgeIds.add(e.id);

    const fromName = idToName.get(e.fromId) ?? e.fromId;
    const toName = idToName.get(e.toId) ?? e.toId;
    const hasDesc = edgeHasDescription(fromTier, toTier);
    edgesXmlParts.push(formatEdge(e, fromName, toName, hasDesc));
  }

  const tierCount = (tier: string) => passNodes.filter(n => n.tier === tier).length;
  if (isAssembleDebugEnabled(params.cfg, params.debug)) {
    console.log(
      `[graph-memory] assemble${params.logLabel ? `:${params.logLabel}` : ""}: ` +
      `scope_hot=${tierCount("scope_hot")} ` +
      `hot=${tierCount("hot")} ` +
      `active=${tierCount("active")} ` +
      `L1=${tierCount("L1")} ` +
      `L2=${tierCount("L2")} ` +
      `L3=${tierCount("L3")} ` +
      `renderedEdges=${seenEdgeIds.size} (raw=${params.edges.length})`
    );
  }

  const nodesXml = xmlParts.join("\n");
  const edgesXml = edgesXmlParts.length
    ? `\n  <edges>\n${edgesXmlParts.join("\n")}\n  </edges>`
    : "";
  const xml = `<knowledge_graph>\n${nodesXml}${edgesXml}\n</knowledge_graph>`;

  return {
    xml,
    tokens: Math.ceil(xml.length / CHARS_PER_TOKEN),
    renderedEdges: seenEdgeIds.size,
    rawEdges: params.edges.length,
  };
}

// ─── 组装主函数 ──────────────────────────────────────────────


export interface AssembleStableParams {
  scopeHotNodes: GmNode[];
  scopeHotEdges: GmEdge[];
  hotNodes: GmNode[];
  hotEdges: GmEdge[];
  compactActiveNodes?: GmNode[];
  compactActiveEdges?: GmEdge[];
}

export interface AssembleDynamicParams {
  recalledNodes: TieredNode[];
  recalledEdges: GmEdge[];
  stableNodeIds?: Set<string>;
  pprScores?: Record<string, number>;
  graphWalkDepth?: number;
}

export function assembleStableContext(
  db: DatabaseSyncInstance,
  cfg: GmConfig | null,
  params: AssembleStableParams,
): { xml: string | null; systemPrompt: string; context: string; tokens: number } {
  const compactActiveNodes = params.compactActiveNodes ?? [];
  const compactActiveEdges = params.compactActiveEdges ?? [];
  const mergedNodes = mergeNodes(params.scopeHotNodes, params.hotNodes, [], compactActiveNodes);
  const allEdges = mergeEdges(params.scopeHotEdges, mergeEdges(params.hotEdges, compactActiveEdges));
  const rendered = renderKnowledgeGraph({
    nodes: mergedNodes,
    edges: allEdges,
    logLabel: "stable",
    includeEdges: false,
    includeUpdated: false,
    includeConfidence: false,
    sortNodes: true,
    cfg,
  });

  const systemPrompt = buildSystemPromptAddition({
    selectedNodes: mergedNodes.filter(n => n.tier !== "filtered").map(n => ({
      type: n.type,
      src: "recalled" as const,
      tier: n.tier.toLowerCase(),
    })),
    edgeCount: rendered.renderedEdges,
    scopeHotCount: params.scopeHotNodes.length,
    force: true,
  });
  const body = rendered.xml ? `${systemPrompt}\n\n<gm_memory>\n\n${rendered.xml}\n\n</gm_memory>` : systemPrompt;

  if (isAssembleDebugEnabled(cfg)) {
    console.log(
      `[graph-memory] assemble tokens: stableSys=${Math.ceil(systemPrompt.length / 3)} ` +
      `stableXml=${Math.ceil((rendered.xml ?? "").length / 3)} ` +
      `total=${Math.ceil(body.length / 3)}`
    );
  }

  return {
    xml: rendered.xml,
    systemPrompt,
    context: body,
    tokens: Math.ceil(body.length / CHARS_PER_TOKEN),
  };
}

export function renderRecallIndexContext(params: {
  recalledNodes: TieredNode[];
  stableNodeIds?: Set<string>;
  logLabel?: string;
  debug?: boolean;
}): { xml: string | null; context: string; tokens: number } {
  const stableNodeIds = params.stableNodeIds ?? new Set<string>();
  const passNodes = params.recalledNodes
    .filter(n => !stableNodeIds.has(n.id))
    .filter(n => n.tier === "L1" || n.tier === "L2");

  if (!passNodes.length) {
    return { xml: null, context: "", tokens: 0 };
  }

  const xmlParts: string[] = [];
  for (const n of passNodes) {
    const tag = n.type.toLowerCase();
    const tier = n.tier;
    const srcAttr = ` source="recalled"`;
    const tierAttr = ` tier="${tier.toLowerCase()}"`;
    if (tier === "L1") {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${srcAttr}${tierAttr}/>`);
    } else {
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}"${srcAttr}${tierAttr}/>`);
    }
  }

  if (isAssembleDebugEnabled(null, params.debug)) {
    console.log(
      `[graph-memory] assemble${params.logLabel ? `:${params.logLabel}` : ":recall-index"}: ` +
      `L1=${passNodes.filter(n => n.tier === "L1").length} ` +
      `L2=${passNodes.filter(n => n.tier === "L2").length} ` +
      `edges=0`,
    );
  }

  const guidance = [
    "<!--",
    "Graph Memory recall index (runtime-generated, not user-authored).",
    "These entries are memory hints, not authoritative facts. Do not treat them as current state without verification.",
    "L1 entries include only name + desc; L2 entries include only name. Edges and full content are intentionally omitted for prefix-cache-friendly context.",
    "Use gm_get_node(name) when exact details are needed. If the relevant memory may be missing from this index, use gm_search with targeted keywords.",
    "-->",
  ].join("\n");

  const xml = `<knowledge_graph>\n${guidance}\n${xmlParts.join("\n")}\n</knowledge_graph>`;
  const context = `<gm_memory>\n\n${xml}\n\n</gm_memory>`;

  return {
    xml,
    context,
    tokens: Math.ceil(context.length / CHARS_PER_TOKEN),
  };
}

export function assembleDynamicContext(
  db: DatabaseSyncInstance,
  cfg: GmConfig | null,
  params: AssembleDynamicParams,
): { xml: string | null; context: string; tokens: number } {
  const stableNodeIds = params.stableNodeIds ?? new Set<string>();
  const recalledNodes = params.recalledNodes.filter(n => !stableNodeIds.has(n.id));
  const recalledNodeIds = new Set(recalledNodes.map(n => n.id));
  const dynamicNodeIds = new Set([...recalledNodeIds]);

  const recalledEdges = params.recalledEdges.filter(e => dynamicNodeIds.has(e.fromId) && dynamicNodeIds.has(e.toId));
  const mergedNodes = mergeNodes([], [], recalledNodes, []);
  const allEdges = recalledEdges;
  const rendered = renderKnowledgeGraph({
    nodes: mergedNodes,
    edges: allEdges,
    logLabel: "dynamic",
    cfg,
  });

  const context = rendered.xml ? `<gm_memory>\n\n${rendered.xml}\n\n</gm_memory>` : "";

  if (isAssembleDebugEnabled(cfg)) {
    console.log(
      `[graph-memory] assemble tokens: dynamicXml=${Math.ceil((rendered.xml ?? "").length / 3)} ` +
      `total=${Math.ceil(context.length / 3)}`
    );
  }

  return {
    xml: rendered.xml,
    context,
    tokens: Math.ceil(context.length / CHARS_PER_TOKEN),
  };
}

// ─── Extract 用知识图谱 ──────────────────────────────────────

// extract 阶段不处理的节点类型（由 topic induction 阶段管理）
const EXTRACT_EXCLUDED_TYPES = new Set(["TOPIC", "SESSION"]);

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
  const idToExtractTier = new Map<string, RecallTier>();
  for (const { node, tier } of passNodes) {
    idToName.set(node.id, node.name);
    idToExtractTier.set(node.id, tier);
  }

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
      xmlParts.push(`  <${tag} name="${escapeXml(n.name)}" desc="${escapeXml(n.description || "")}"${tierAttr}>\n${escapeXml(n.content.trim())}\n  </${tag}>`);
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

    const fromTier = idToExtractTier.get(e.fromId) ?? "filtered";
    const toTier = idToExtractTier.get(e.toId) ?? "filtered";

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
