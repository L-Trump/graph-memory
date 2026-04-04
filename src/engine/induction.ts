/**
 * graph-memory — Topic Induction Engine
 *
 * 从 semantic nodes（KNOWLEDGE/SKILL/TASK/EVENT/STATUS）归纳主题节点（TOPIC），
 * 建立 semantic ↔ topic 和 topic ↔ topic 边。
 *
 * 所有数据库写入在函数内部完成，返回操作清单供调用方记录日志。
 */

import type { GmNode, GmEdge, NodeType } from "../types.ts";
import type { CompleteFn } from "./llm.ts";
import type { Recaller, TieredNode } from "../recaller/recall.ts";
import {
  getTopicNodes,
  getTopicToTopicEdges,
  getSemanticToTopicEdges,
  getEdgesForNodes,
  upsertNode,
  upsertEdge,
  findByName,
} from "../store/store.ts";
import type { DatabaseSyncInstance } from "../store/db.ts";

// ─── Topic Induction System Prompt ───────────────────────────────

const INDUCTION_SYS = `你是图谱主题归纳引擎（Topic Induction）。
给定一组知识节点（KNOWLEDGE/SKILL/TASK/EVENT/STATUS）及其关系，
分析其中的共现模式、语义聚类，归纳出若干主题（TOPIC）节点，
并建立 semantic ↔ topic 和 topic ↔ topic 两类边。
输出严格 JSON，不包含任何额外文字。

1. 节点提取：
   主题（TOPIC）是知识节点的语义聚合。只有当多个节点（通常 3 个以上）共享明显的共同主题时，才归纳为 topic。
   主题名格式为 topic-xxx，全小写连字符，简洁（4-10字），反映核心语义域，如：
       topic-nixos-sysmgmt（系统管理）、topic-feishu-integration（飞书集成）、
       topic-mail-system（邮件系统）、topic-graph-memory（知识图谱架构）
   优先将节点关联到已有 topic；只有在节点明显形成新的主题时才创建新 topic。
   节点少时（少于 3-5 个）倾向于不建新 topic，让长尾游离；节点多时宁可少而精，避免为每个节点单独建 topic。
   topic node content 模板：
       "[name]\n该主题聚合的知识节点：\n1. ...\n2. ...\n3. ...\n覆盖范围：...\n核心关联：..."

2. 关系提取（边，仅允许以下三种类型）：
   2.1 【主题包含】topic ↔ topic 层级包含关系：A 包含 B（如 "系统管理" 包含 "NixOS 配置"）
       - 起点 A 是较宽泛的父主题，终点 B 是较具体的子主题
       - 若两个 topic 之间无明确层级关系，则不建边
   2.2 【主题父级】topic ↔ topic 父子关系：A 是 B 的父主题（与"主题包含"方向相同，仅名称不同）
   2.3 【主题属于】semantic → topic 归属关系：知识节点归属于某主题，建边无需特别理由
   2.4 【禁止】induction 阶段禁止在 semantic 节点之间建边

   每条边必须包含 from、to、name、description 四个字段

3. 知识图谱 XML 结构（仅供参考，不要在输出中重复这些标签）：
   知识图谱以 XML 格式呈现，节点和边分别用不同标签表示：

   节点标签（2 种）：
     <topic name="节点名" desc="一句话概述">完整内容（description + content）</topic>
     <semantic type="类型" name="节点名" desc="一句话说明触发场景"/>
     - topic 节点：description + content 全量传入
     - semantic 节点：只传 description，不传 content

   边标签（位于 <edges> 父标签内）：
     <e name="边类型名" from="起点节点名" to="终点节点名">描述</e>

4. 新知识与已有节点的关系处理：
   4.1 【同名即更新】若归纳出的 topic name 与图谱中已有 topic 相同，系统自动执行 upsert
   4.2 【新建】确实无法归入任何已有主题 → 创建新 TOPIC 节点
   4.3 topic ↔ topic：无明确层级关系则不建边

5. 输出格式：
   {
     "nodes": [
       {
         "name": "topic-xxx",
         "description": "一句话概述（20字以内）",
         "content": "完整内容（60字以内）"
       }
     ],
     "edges": [
       {
         "from": "起点节点名",
         "to": "终点节点名",
         "name": "边类型（主题属于 / 主题包含 / 主题父级）",
         "description": "一句话描述这段关系"
       }
     ]
   }

   - nodes 中 name 与图谱已有 topic 同名 → 系统自动 upsert，无需特殊标记
   - edges 中 name="主题属于" 的边建立从 semantic 节点到 topic 节点的归属关系
   - edges 中 name="主题包含" 或 "主题父级" 的边建立 topic 之间的层级关系
   - edges 自动去重（相同 from-to-name 三元组只保留一条）
   - induction 阶段禁止创建 semantic ↔ semantic 边

6. 输出约束：
   6.1 只返回 JSON，格式为 {"nodes":[...],"edges":[...]}，禁止 markdown 代码块包裹
   6.2 禁止解释文字，禁止额外字段
   6.3 没有知识节点时不创建 topic，返回 {"nodes":[],"edges":[]}
   6.4 节点很少时（少于 3 个）不创建新 topic
   6.5 边类型只允许：主题属于（semantic→topic）、主题包含（topic↔topic）、主题父级（topic↔topic），其余类型一律不创建`;

// ─── 辅助函数 ─────────────────────────────────────────────────

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeName(name: string): string {
  return String(name).trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

const SEMANTIC_TYPES = new Set(["TASK", "SKILL", "EVENT", "KNOWLEDGE", "STATUS"]);

// ─── 构建 Topic Induction 输入 ─────────────────────────────────

function buildInductionInput(params: {
  mergedNodes: GmNode[];        // 合并后的 semantic 节点（session + recalled，无 TOPIC）
  mergedEdges: GmEdge[];       // mergedNodes 之间的边（getEdgesForNodes）
  existingTopics: GmNode[];
  existingTopicEdges: GmEdge[]; // topic↔topic 边（已过滤到 relevant）
  semanticToTopicEdges: GmEdge[]; // semantic→topic 边（已过滤到 relevant）
}): string {
  const { mergedNodes, mergedEdges, existingTopics,
          existingTopicEdges, semanticToTopicEdges } = params;

  const lines: string[] = [];

  // 建立 id → name 映射（用于解析边中的 fromId/toId）
  const allNodes: GmNode[] = [...mergedNodes, ...existingTopics];
  const nodeNameById = new Map<string, string>();
  for (const n of allNodes) nodeNameById.set(n.id, n.name);

  // ── Knowledge Graph XML ──────────────────────────────────────
  lines.push("<knowledge_graph>");

  // topic nodes：description + content 全量传入
  for (const t of existingTopics) {
    const desc = escapeXml((t.description || "").slice(0, 200));
    const content = escapeXml((t.content || "").slice(0, 300));
    lines.push(`  <topic name="${t.name}" desc="${desc}">${content}</topic>`);
  }

  // semantic nodes（mergedNodes）：只传 description，不传 content
  for (const n of mergedNodes) {
    const desc = escapeXml((n.description || "").slice(0, 150));
    lines.push(`  <semantic type="${n.type}" name="${n.name}" desc="${desc}"/>`);
  }

  // edges：只传 from/to/name，不传 description
  lines.push("  <edges>");
  for (const e of mergedEdges) {
    const fromName = nodeNameById.get(e.fromId) ?? e.fromId;
    const toName = nodeNameById.get(e.toId) ?? e.toId;
    lines.push(`    <e name="${escapeXml(e.name)}" from="${fromName}" to="${toName}"/>`);
  }
  lines.push("  </edges>");

  lines.push("</knowledge_graph>");

  // ── Existing Topic Edges ────────────────────────────────────
  if (existingTopicEdges.length > 0) {
    lines.push("\n【已有 Topic ↔ Topic 边（层级关系）】");
    for (const e of existingTopicEdges) {
      const fromName = nodeNameById.get(e.fromId) ?? e.fromId;
      const toName = nodeNameById.get(e.toId) ?? e.toId;
      lines.push(`  ${fromName} --[${e.name}]--> ${toName}`);
    }
  }

  // ── Existing Semantic → Topic Edges ───────────────────────
  if (semanticToTopicEdges.length > 0) {
    lines.push("\n【已有 Semantic → Topic 边（归属关系）】");
    for (const e of semanticToTopicEdges) {
      const fromName = nodeNameById.get(e.fromId) ?? e.fromId;
      const toName = nodeNameById.get(e.toId) ?? e.toId;
      lines.push(`  ${fromName} --[${e.name}]--> ${toName}`);
    }
  }

  return lines.join("\n");
}

// ─── 解析 LLM 输出 ─────────────────────────────────────────────

interface InductionResult {
  nodes: Array<{
    name: string;
    description: string;
    content: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    name: string;
    description: string;
  }>;
}

function parseInduction(raw: string): InductionResult {
  try {
    const s = raw.trim()
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?\s*```\s*$/i, "")
      .trim();

    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    const json = first !== -1 && last > first ? s.slice(first, last + 1) : s;
    const p = JSON.parse(json);

    const seenNodes = new Set<string>();
    const nodes = (p.nodes ?? [])
      .filter((n: any) => n.name && (n.description || n.content))
      .map((n: any) => {
        const name = normalizeName(n.name);
        if (seenNodes.has(name)) return null;
        seenNodes.add(name);
        return {
          name,
          description: String(n.description || "").trim().slice(0, 200),
          content: String(n.content || n.description || "").trim().slice(0, 300),
        };
      })
      .filter(Boolean);

    const seenEdges = new Set<string>();
    const edges = (p.edges ?? [])
      .filter((e: any) => e.from && e.to && e.name && e.description)
      .map((e: any) => {
        const from = normalizeName(e.from);
        const to = normalizeName(e.to);
        const name = String(e.name).trim();
        const key = `${from}|${to}|${name}`;
        if (seenEdges.has(key)) return null;
        seenEdges.add(key);
        return { from, to, name, description: String(e.description).trim().slice(0, 200) };
      })
      .filter(Boolean);

    return { nodes, edges };
  } catch (err) {
    console.error("[topic induction] parseInduction failed:", err);
    return { nodes: [], edges: [] };
  }
}

// ─── 主体函数 ─────────────────────────────────────────────────

export interface TopicInductionResult {
  createdTopics: GmNode[];          // 新建的 topic 节点
  updatedTopics: GmNode[];         // 更新的已有 topic 节点
  semanticToTopicEdges: GmEdge[];  // semantic → topic 归属边
  topicToTopicEdges: GmEdge[];    // topic ↔ topic 层级边
}

/**
 * 执行主题归纳。
 *
 * 内部流程：
 * 1. 查询数据库已有 topic 节点和边
 * 2. [可选] 跨会话 recall 获取上下文
 * 3. 调用 LLM 决定 topic 创建/更新和边建立
 * 4. 约束检查：只允许 semantic→topic 和 topic↔topic 边
 * 5. 数据库写入：upsertNode + upsertEdge
 * 6. 返回操作清单
 *
 * @param params.sessionNodes  当前会话的 semantic 节点（允许为空，为空时跳过）
 */
export async function induceTopics(params: {
  db: DatabaseSyncInstance;
  sessionNodes: GmNode[];
  llm: CompleteFn;
  recaller?: Recaller;
  /** 限制传入 LLM 的已有主题数量（按 updatedAt 倒序），默认 50 */
  limitExistingTopics?: number;
}): Promise<TopicInductionResult> {
  const { db, sessionNodes, llm, recaller,
          limitExistingTopics = 50 } = params;

  // 没有任何节点传入时跳过
  if (sessionNodes.length === 0 && !recaller) {
    return { createdTopics: [], updatedTopics: [], semanticToTopicEdges: [], topicToTopicEdges: [] };
  }

  // ── 内部查询已有主题节点 ──────────────────────────────
  const allExistingTopics = getTopicNodes(db);
  const existingTopics = [...allExistingTopics]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, limitExistingTopics);

  // ── Cross-session recall ───────────────────────────────────
  let recalledTieredNodes: TieredNode[] = [];

  if (recaller) {
    try {
      const mergedContent = sessionNodes.length > 0
        ? sessionNodes.map(n => `${n.name} ${n.description || ""} ${n.content || ""}`).join(" ")
        : "";
      const recalled = await recaller.recallV2(mergedContent);
      recalledTieredNodes = recalled.nodes.filter(
        n => (n.tier === "L1" || n.tier === "L2") && n.type !== "TOPIC"
      );
    } catch (err) {
      console.warn("[topic induction] recall failed, proceeding without cross-session context:", err);
    }
  }

  // ── 合并 session + recalled，过滤 deprecated ─────────────────
  // recalled.nodes 来自数据库查询，status='active' 的已在 db 层保证
  const recalledActive = recalledTieredNodes.filter(n => n.status !== "deprecated") as TieredNode[];
  const mergedNodes: GmNode[] = [
    ...sessionNodes.filter(n => n.status !== "deprecated"),
    ...recalledActive,
  ];

  // ── 统一查询三类边 ───────────────────────────────────
  const mergedIds = new Set(mergedNodes.map(n => n.id));
  const topicIds = new Set(existingTopics.map(t => t.id));

  // 1. mergedNodes 之间的边
  const mergedEdges = getEdgesForNodes(db, [...mergedIds]);

  // 2. existing semantic→topic 边（过滤到 mergedNodes 中的节点）
  const allSemanticToTopicEdges = getSemanticToTopicEdges(db);
  const filteredSemanticToTopicEdges = allSemanticToTopicEdges.filter(
    e => mergedIds.has(e.fromId)
  );

  // 3. existing topic↔topic 边（过滤到 relevant 范围：两端至少有一端在 merged 或 topicIds 中）
  const allTopicToTopicEdges = getTopicToTopicEdges(db);
  const filteredTopicToTopicEdges = allTopicToTopicEdges.filter(
    e => mergedIds.has(e.fromId) || mergedIds.has(e.toId) ||
         topicIds.has(e.fromId) || topicIds.has(e.toId)
  );

  // ── 构建 LLM 输入 ──────────────────────────────────────────
  const input = buildInductionInput({
    mergedNodes,
    mergedEdges,
    existingTopics,
    existingTopicEdges: filteredTopicToTopicEdges,
    semanticToTopicEdges: filteredSemanticToTopicEdges,
  });

  const raw = await llm(INDUCTION_SYS, `<知识图谱现状>\n${input}`);

  const result = parseInduction(raw);

  // ── 建立 name → type 映射（用于约束检查）────────────────
  // 包括：mergedNodes、existingTopics
  const nodeNameToType = new Map<string, string>();
  for (const n of mergedNodes) nodeNameToType.set(n.name, n.type);
  for (const n of existingTopics) nodeNameToType.set(n.name, "TOPIC");

  // ── 第一阶段：把所有 LLM 返回的 topic name 预注册 ──────────
  // 这样同一次 LLM 响应中可以建 topic ↔ topic 边和 semantic → 新topic 边
  const llmTopicNames = new Set<string>();
  for (const n of result.nodes) {
    llmTopicNames.add(n.name);
    nodeNameToType.set(n.name, "TOPIC");
  }

  // ── 约束检查 + 分离边类型 ───────────────────────────────
  const semToTopicEdges: Array<{ fromName: string; toName: string; name: string; description: string }> = [];
  const rawTopicToTopicEdges: Array<{ fromName: string; toName: string; name: string; description: string }> = [];

  for (const edge of result.edges) {
    // 归一化 from/to 名称（用于查找节点类型和 ID）
    const fromNorm = normalizeName(edge.from);
    const toNorm = normalizeName(edge.to);

    if (edge.name === "主题属于") {
      // 约束：from 必须是 semantic 节点，to 必须是 TOPIC 节点
      const fromType = nodeNameToType.get(fromNorm);
      const toType = nodeNameToType.get(toNorm);
      if (fromType && SEMANTIC_TYPES.has(fromType) && toType === "TOPIC") {
        semToTopicEdges.push({
          fromName: fromNorm,
          toName: toNorm,
          name: "属于",
          description: edge.description,
        });
      }
    } else if (edge.name === "主题包含" || edge.name === "主题父级") {
      // 约束：from 和 to 都必须是 TOPIC 节点
      const fromType = nodeNameToType.get(fromNorm);
      const toType = nodeNameToType.get(toNorm);
      if (fromType === "TOPIC" && toType === "TOPIC") {
        rawTopicToTopicEdges.push({
          fromName: fromNorm,
          toName: toNorm,
          name: edge.name,
          description: edge.description,
        });
      }
    }
    // 其他边名直接丢弃（induction 阶段不建 semantic↔semantic 边）
  }

  // ── 建立已有 topic name → id 映射 ──────────────────────
  const topicNameToId = new Map<string, string>();
  for (const t of existingTopics) topicNameToId.set(t.name, t.id);

  // ── 数据库写入：topic 节点（第二阶段）────────────────────
  const createdTopics: GmNode[] = [];
  const updatedTopics: GmNode[] = [];
  const allWrittenEdges: GmEdge[] = [];

  for (const n of result.nodes) {
    const { node, isNew } = upsertNode(db, {
      type: "TOPIC",
      name: n.name,
      description: n.description,
      content: n.content,
    }, "topic-induction");
    if (isNew) {
      createdTopics.push(node);
    } else {
      updatedTopics.push(node);
    }
    // 同步更新 topicNameToId（新建的节点需要加入）
    topicNameToId.set(node.name, node.id);
    // 同步 embedding
    if (recaller) recaller.syncEmbed(node).catch(() => {});
  }

  // 处理 semantic → topic 边
  for (const e of semToTopicEdges) {
    // from 是 semantic 节点，需要通过 findByName 查找（可能来自 sessionNodes 或 recalledNodes）
    const fromNode = findByName(db, e.fromName);
    const toId = topicNameToId.get(e.toName);
    if (fromNode && toId) {
      upsertEdge(db, {
        fromId: fromNode.id,
        toId,
        name: e.name,
        description: e.description,
        sessionId: "topic-induction",
      });
      // 记录边信息（用于返回）
      allWrittenEdges.push({
        id: `${fromNode.id}|${toId}|${e.name}`,
        fromId: fromNode.id,
        toId,
        name: e.name,
        description: e.description,
        status: "active",
        sessionId: "topic-induction",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as GmEdge);
    }
  }

  // 处理 topic ↔ topic 边
  for (const e of rawTopicToTopicEdges) {
    const fromId = topicNameToId.get(e.fromName);
    const toId = topicNameToId.get(e.toName);
    if (fromId && toId) {
      upsertEdge(db, {
        fromId,
        toId,
        name: e.name,
        description: e.description,
        sessionId: "topic-induction",
      });
      allWrittenEdges.push({
        id: `${fromId}|${toId}|${e.name}`,
        fromId,
        toId,
        name: e.name,
        description: e.description,
        status: "active",
        sessionId: "topic-induction",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as unknown as GmEdge);
    }
  }

  const resultSemanticToTopicEdges = allWrittenEdges.filter(e => e.name === "属于");
  const resultTopicToTopicEdges = allWrittenEdges.filter(e => e.name !== "属于");

  return {
    createdTopics,
    updatedTopics,
    semanticToTopicEdges: resultSemanticToTopicEdges,
    topicToTopicEdges: resultTopicToTopicEdges,
  };
}
