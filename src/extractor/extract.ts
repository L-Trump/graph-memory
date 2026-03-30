/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import type { GmConfig, ExtractionResult, FinalizeResult } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";

// ─── 节点合法类型 ──────────────────────────────────────────────

const VALID_NODE_TYPES = new Set(["TASK", "SKILL", "EVENT", "KNOWLEDGE"]);

// ─── 提取 System Prompt ─────────────────────────────────────────

const EXTRACT_SYS = `你是 graph-memory 知识图谱提取引擎，从 AI Agent 对话中提取可复用的结构化知识（节点 + 关系）。
提取的知识将在未来对话中被召回，帮助 Agent 避免重复犯错、复用已验证方案。
输出严格 JSON：{"nodes":[...],"edges":[...]}，不包含任何额外文字。

1. 节点提取：
   1.1 从对话中识别四类知识节点：
       - TASK：用户要求 Agent 完成的具体任务，或对话中讨论，分析、对比的主题
       - SKILL：可复用的操作技能，有具体工具/命令/API，有明确触发条件，步骤可直接执行
       - EVENT：一次性的报错或异常，记录现象、原因和解决方法
       - KNOWLEDGE：专业领域知识，有明确适用范围和条件，排除 LLM 本身已知的常识（如太阳东升西落、基本物理定律、常见数学结论等）
   1.2 每个节点必须包含 4 个字段，缺一不可：
       - type：节点类型，只允许 TASK / SKILL / EVENT / KNOWLEDGE
       - name：全小写连字符命名，确保整个提取过程命名一致
       - description：一句话说明什么场景触发
       - content：纯文本格式的知识内容（见 1.3 的模板）
   1.3 name 命名规范：
       - TASK：动词-对象格式，如 deploy-bilibili-mcp、extract-pdf-tables
       - SKILL：工具-操作格式，如 conda-env-create、docker-port-expose
       - EVENT：现象-工具格式，如 importerror-libgl1、timeout-paddleocr
       - KNOWLEDGE：领域-主题格式，如 analog-cs-amplifier-noise-analysis、analog-cs-bandgap-reference-design
       - 已有节点列表会提供，相同事物必须复用已有 name，不得创建重复节点
   1.4 content 模板（纯文本，按 type 选用）：
       TASK → "[name]\n目标: ...\n执行步骤:\n1. ...\n2. ...\n结果: ..."
       SKILL → "[name]\n触发条件: ...\n执行步骤:\n1. ...\n2. ...\n常见错误:\n- ... -> ..."
       EVENT → "[name]\n现象: ...\n原因: ...\n解决方法: ..."
       KNOWLEDGE → "[name]\n适用条件: ...\n核心内容:\n1. ...\n2. ...\n注意事项:\n- ..."

2. 关系提取（边）：
   2.1 识别节点之间直接、明确的关系（参考知识图谱中已有的边作为上下文）。
   2.2 每条边必须包含 from、to、name、description 四个字段，缺一不可。
   2.3 name（边类型名）由你根据语义自由生成短字符串（如"使用"、"依赖"、"扩展"、"解决"等）。
   2.4 description 写一句话描述这段关系，要具体。
   2.5 约束：每条边必须有一端是新节点（本次对话新提取的节点），两个已有节点之间不要建边。

3. 知识图谱 XML 结构说明（仅供参考，不要在输出中重复这些标签）：
   知识图谱以 XML 格式呈现，节点和边分别用不同标签表示：

   节点标签（4 种，对应 4 种节点类型）：
     <task name="节点名" desc="描述" tier="l1|l2|l3">内容</task>
     <skill name="节点名" desc="描述" tier="l1|l2|l3">内容</skill>
     <event name="节点名" desc="描述" tier="l1|l2|l3">内容</event>
     <knowledge name="节点名" desc="描述" tier="l1|l2|l3">内容</knowledge>
     - tier 表示节点重要度：l1 最高（有完整 content）、l2（仅 description）、l3（仅 name）
     - 自闭合标签（如 <task .../>）表示该节点仅含 description，无完整 content

   边标签（位于 <edges> 父标签内）：
     <e name="边类型名" from="起点节点名" to="终点节点名">描述</e>
     有 description 的边有闭合标签，无 description 的边自闭合

4. 提取策略（宁多勿漏）：
   4.1 所有对话内容都应尝试提取，包括讨论，分析、对比、方案选型等
   4.2 用户纠正 AI 的错误时，旧做法和新做法都要提取，用"扩展"或"替代"边关联
   4.3 讨论和对比类对话提取为 TASK，记录讨论的结论和要点
   4.4 只有纯粹的寒暄问候（如"你好""谢谢"）才不提取

5. 输出规范：
   5.1 只返回 JSON，格式为 {"nodes":[...],"edges":[...]}
   5.2 禁止 markdown 代码块包裹，禁止解释文字，禁止额外字段
   5.3 没有知识产出时返回 {"nodes":[],"edges":[]}
   5.4 每条 edge 的 description 必须写具体内容，不能为空或"见上文"`;

// ─── 提取 User Prompt ───────────────────────────────────────────
// knowledgeGraph: 合并后的知识图谱 XML（session 节点 + recalled 节点 merged）
const EXTRACT_USER = (msgs: string, knowledgeGraph: string) =>
`<知识图谱（跨会话关联参考）>
${knowledgeGraph || "（无）"}

<当前对话>
${msgs}`;

// ─── 整理 System Prompt ─────────────────────────────────────────

const FINALIZE_SYS = `你是图谱节点整理引擎，对本次对话产生的节点做 session 结束前的最终审查。
审查本次对话所有节点，执行以下三项操作，输出严格 JSON。

1. EVENT 升级为 SKILL：
   如果某个 EVENT 节点具有通用复用价值（不限于特定场景），将其升级为 SKILL。
   升级时需要：改名为 SKILL 命名规范、完善 content 为 SKILL 纯文本模板格式。
   写入 promotedSkills 数组。

2. 补充遗漏关系：
   整体回顾所有节点，发现单次提取时难以察觉的跨节点关系。
   边类型 name 由你根据语义自由生成。
   写入 newEdges 数组。

3. 标记失效节点：
   因本次对话中的新发现而失效的旧节点，将其 node_id 写入 invalidations 数组。

没有需要处理的项返回空数组。只返回 JSON，禁止额外文字。
格式：{"promotedSkills":[{"type":"SKILL","name":"...","description":"...","content":"..."}],"newEdges":[{"from":"...","to":"...","name":"...","description":"..."}],"invalidations":["node-id"]}`;

// ─── 整理 User Prompt ───────────────────────────────────────────

const FINALIZE_USER = (nodes: any[], summary: string) =>
`<Session Nodes>
${JSON.stringify(nodes.map(n => ({
  id: n.id, type: n.type, name: n.name,
  description: n.description, v: n.validatedCount
})), null, 2)}

<Graph Summary>
${summary}`;

// ─── 名称标准化（与 store.ts 一致）────────────────────────────

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── Extractor ───────────────────────────────────────────────

export class Extractor {
  constructor(private _cfg: GmConfig, private llm: CompleteFn) {}

  async extract(params: {
    messages: any[];
    /** 合并后的知识图谱 XML（session 节点 + recalled 节点 merged）*/
    knowledgeGraph?: string;
  }): Promise<ExtractionResult> {
    const msgs = params.messages
      .map(m => `[${(m.role ?? "?").toUpperCase()} t=${m.turn_index ?? 0}]\n${
        String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 800)
      }`).join("\n\n---\n\n");

    const raw = await this.llm(
      EXTRACT_SYS,
      EXTRACT_USER(msgs, params.knowledgeGraph ?? ""),
    );

    if (process.env.GM_DEBUG) {
      console.log("\n  [DEBUG] LLM raw response (first 2000 chars):");
      console.log("  " + raw.slice(0, 2000).replace(/\n/g, "\n  "));
    }

    return this.parseExtract(raw);
  }

  async finalize(params: { sessionNodes: any[]; graphSummary: string }): Promise<FinalizeResult> {
    const raw = await this.llm(FINALIZE_SYS, FINALIZE_USER(params.sessionNodes, params.graphSummary));
    return this.parseFinalize(raw, params.sessionNodes);
  }

  private parseExtract(raw: string): ExtractionResult {
    try {
      const json = extractJson(raw);
      const p = JSON.parse(json);

      const nodes = (p.nodes ?? []).filter((n: any) => {
        if (!n.name || !n.type || !n.content) return false;
        if (!VALID_NODE_TYPES.has(n.type)) {
          if (process.env.GM_DEBUG) console.log(`  [DEBUG] node dropped: invalid type "${n.type}"`);
          return false;
        }
        if (!n.description) n.description = "";
        n.name = normalizeName(n.name);
        return true;
      });

      const nameToType = new Map<string, string>();
      for (const n of nodes) nameToType.set(n.name, n.type);

      const edges = (p.edges ?? [])
        .filter((e: any) => e.from && e.to && e.name && e.description)
        .map((e: any) => {
          e.from = normalizeName(e.from);
          e.to = normalizeName(e.to);
          return { from: e.from, to: e.to, name: e.name, description: e.description };
        })
        .filter((e: any) => e !== null);

      return { nodes, edges };
    } catch (err) {
      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] JSON parse failed: ${err}`);
        console.log(`  [DEBUG] raw content: ${raw.slice(0, 500)}`);
      }
      return { nodes: [], edges: [] };
    }
  }

  private parseFinalize(raw: string, sessionNodes?: any[]): FinalizeResult {
    try {
      const json = extractJson(raw);
      const p = JSON.parse(json);

      const nameToType = new Map<string, string>();
      if (sessionNodes) {
        for (const n of sessionNodes) {
          if (n.name && n.type) nameToType.set(normalizeName(n.name), n.type);
        }
      }
      const promotedSkills = (p.promotedSkills ?? []).filter((n: any) => n.name && n.content);
      for (const n of promotedSkills) {
        nameToType.set(normalizeName(n.name), n.type ?? "SKILL");
      }

      const newEdges = (p.newEdges ?? [])
        .filter((e: any) => e.from && e.to && e.name && e.description)
        .map((e: any) => {
          e.from = normalizeName(e.from);
          e.to = normalizeName(e.to);
          return { from: e.from, to: e.to, name: e.name, description: e.description };
        })
        .filter((e: any) => e !== null);

      return {
        promotedSkills,
        newEdges,
        invalidations: p.invalidations ?? [],
      };
    } catch { return { promotedSkills: [], newEdges: [], invalidations: [] }; }
  }
}

// ─── JSON 提取 ───────────────────────────────────────────────

function extractJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<think>[\s\S]*/gi, "");
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
  s = s.trim();
  if (s.startsWith("{") && s.endsWith("}")) return s;
  if (s.startsWith("[") && s.endsWith("]")) return s;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}
