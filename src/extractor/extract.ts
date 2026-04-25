/**
 * graph-memory — 知识提取引擎
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 提取流程：renderMsgs → LLM(EXTRACT_SYS, EXTRACT_USER) → parseExtract
 * 输出：nodes + edges + beliefUpdates（置信度更新）
 */

import type { GmConfig, ExtractionResult, FinalizeResult, BeliefUpdate, AdvisorySuggestion } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";

// ─── 节点合法类型 ──────────────────────────────────────────────

// TOPIC 节点由 topic induction 阶段单独管理,extract 阶段不创建
const VALID_NODE_TYPES = new Set(["TASK", "SKILL", "EVENT", "KNOWLEDGE", "STATUS"]);

// ─── 提取 System Prompt ─────────────────────────────────────────

const EXTRACT_SYS = `你是 graph-memory 知识图谱提取引擎,从 AI Agent 对话中提取可复用的结构化知识(节点 + 关系)。
提取的知识将在未来对话中被召回,帮助 Agent 避免重复犯错、复用已验证方案。

## 输出 JSON Schema
{
  "nodes": [{
    "type": "TASK" | "SKILL" | "EVENT" | "KNOWLEDGE" | "STATUS",
    "name": "全小写连字符",
    "description": "一句话说明触发场景",
    "content": "纯文本模板内容"
  }],
  "edges": [{
    "from": "起点节点 name",
    "to": "终点节点 name",
    "name": "边类型名",
    "description": "一句话描述关系"
  }],
  "beliefUpdates": [{
    "nodeName": "知识图谱中已有节点的 name（不得为本轮新建节点）",
    "verdict": "supported" | "contradicted",
    "weight": 0.5 | 0.7 | 1.0 | 1.5 | 2.0,
    "reason": "判断依据（引用具体对话内容）"
  }],
  "advisorySuggestions": [{
    "nodeName": "本轮新建节点的 name",
    "suggestion": "建议动作（如：建议写成文档）",
    "reason": "为什么建议这样做",
    "suggestedDocTitle": "建议的文档标题"
  }]
}
只返回上述 JSON，不包含任何额外文字。

1. 节点提取:
   1.1 从对话中识别五类知识节点:
       - TASK:用户要求 Agent 完成的具体任务,或对话中讨论、分析、对比的主题
       - SKILL:可复用的操作技能,有具体工具/命令/API,有明确触发条件,步骤可直接执行
       - EVENT:一次性的报错或异常,记录现象、原因和解决方法
       - KNOWLEDGE:专业领域知识,有明确适用范围和条件,排除 LLM 本身已知的常识(如太阳东升西落、基本物理定律、常见数学结论等)
       - STATUS:时效性强的快照、状态或新闻类内容,记完即用,不需要纠错,不期待后续迭代(如系统配置、版本号、一次性事件记录)
   1.2 每个节点必须包含 4 个字段,缺一不可:
       - type:节点类型,只允许 TASK / SKILL / EVENT / KNOWLEDGE / STATUS
       - name:全小写连字符命名,确保整个提取过程命名一致
       - description:一句话说明什么场景触发
       - content:纯文本格式的知识内容(见 1.3 的模板)，不应超过500字，超过500字的只在content中记录描述与骨架，完整内容使用记忆顾问整理成文档
   1.3 name 命名规范:
       - TASK:动词 - 对象格式,如 deploy-bilibili-mcp、extract-pdf-tables
       - SKILL:工具 - 操作格式,如 conda-env-create、docker-port-expose
       - EVENT:现象 - 工具格式,如 importerror-libgl1、timeout-paddleocr
       - KNOWLEDGE:领域 - 主题格式,如 analog-cs-amplifier-noise-analysis、analog-cs-bandgap-reference-design
       - STATUS:【场景 - 状态描述-YYYYMMDDHHMM】,如 system-nixos-version-202604021405、feishu-group-purpose-oc123-20260402
       - 已有节点列表会提供,相同事物必须复用已有 name,不得创建重复节点
   1.4 content 模板(纯文本,按 type 选用):
       TASK → "[name]\n目标:...\n执行步骤:\n1. ...\n2. ...\n结果:..."
       SKILL → "[name]\n触发条件:...\n执行步骤:\n1. ...\n2. ...\n常见错误:\n- ... -> ..."
       EVENT → "[name]\n现象:...\n原因:...\n解决方法:..."
       KNOWLEDGE → "[name]\n适用条件:...\n核心内容:\n1. ...\n2. ...\n注意事项:\n- ..."
       STATUS → "[name]\n记录时间:...\n快照内容:\n- ...\n备注:\n- ..."

2. 关系提取(边):
   2.1 识别节点之间直接、明确的关系(参考知识图谱中已有的边作为上下文)。
   2.2 每条边必须包含 from、to、name、description 四个字段,缺一不可。
   2.3 name(边类型名)建议从以下 20 种边类型中选择,若两个节点确实有现有边类型不能概括的语义关系,允许自定义边名:
     关系型:依赖、扩展、冲突、互补
     行为型:使用、执行、替代、触发、导致
     认知型:发现、揭示、引用、分析、理解
     问题型:遇到、解决、修正、验证、修复
     产出型:产出、实现、定义
     参考型:查阅、查看、参考
   2.4 description 写一句话描述这段关系,要具体。
   2.5 优先为新节点建边,同时也鼓励发现已有 L1 层节点和已有节点之间遗漏的关联(L1 层节点之间或 L1 层节点和其他节点间的新建边也可写入 edges)

3. 知识图谱 XML 结构说明(仅供参考,不要在输出中重复这些标签):
   知识图谱以 XML 格式呈现,节点和边分别用不同标签表示:

   节点标签(5 种,对应 5 种知识节点类型):
     <task name="节点名" desc="描述" tier="l1|l2|l3">内容</task>
     <skill name="节点名" desc="描述" tier="l1|l2|l3">内容</skill>
     <event name="节点名" desc="描述" tier="l1|l2|l3">内容</event>
     <knowledge name="节点名" desc="描述" tier="l1|l2|l3">内容</knowledge>
     <status name="节点名" desc="描述" tier="l1|l2|l3">内容</status>
     - tier 表示节点重要度:l1 最高(有完整 content)、l2(仅 description)、l3(仅 name)
     - 自闭合标签(如 <task .../>)表示该节点仅含 description,无完整 content
     - 注意:传入的图谱中可能存在 TOPIC 类型节点,这些节点由 topic induction 阶段管理,请忽略不要为其建边

   边标签(位于 <edges> 父标签内):
     <e name="边类型名" from="起点节点名" to="终点节点名">描述</e>
     有 description 的边有闭合标签,无 description 的边自闭合

4. 新知识与已有节点的关系处理(以下四种场景互斥,请根据语义选择):
   4.1【合并】新知识与已有节点是同一事物的延伸或等价表述
     → 用旧节点的 name 创建新节点,将新旧知识语义合并成一条完整知识(不是文本拼接,由你理解两者含义后综合写作)
   4.2【权威纠正】新知识是用户对已有节点的明确否定,且新知识更权威
     → 判定标准(满足任一即可):
        1 用户直接否定(如"不对"、"不是这样"、"错了")
        2 用户引用了权威来源(文档、官方说明、数据手册等)
        3 用户明确说"之前的说法是错的"
     → 用旧节点的 name 创建新节点,以新知识为基准合并新旧知识,在内容末尾另起段落说明"纠正说明 + 纠正时间(YYYY-MM-DD)"
   4.3【冲突】新知识与已有节点存在矛盾,但不属于权威纠正(无明确否定,只是另有说法)
     → 用新知识自己起一个 name 创建节点,建一条 type="conflict" 的边指向旧节点
   4.4【无关】新知识与已有节点完全无关
     → 正常提取,不做特殊处理
   4.5 所有对话内容都应尝试提取,包括讨论、分析、对比、方案选型等
   4.6 只有纯粹的寒暄问候(如"你好""谢谢")或者是显而易见的常识(比如太阳东升西落、1+1=2)才不提取
   4.7【STATUS 特殊规则】STATUS 节点不合并、不覆盖,永远用新的时间戳创建新节点

5. 历史对话与当前对话的处理原则:
   5.1 对话分为"=== 历史对话 ==="(同 session 内更早的已提取消息)和"=== 当前对话 ==="(待提取的新消息)
   5.2 **优先为当前对话提取知识**,当前对话中的 TASK / SKILL / EVENT / KNOWLEDGE / STATUS 必须完整提取
   5.3 历史对话作为上下文参考,如果发现其中有重要知识被遗漏(当前对话中有关联引用或明确讨论),也可以提取
   5.4 历史对话中的敏感信息(密码、API Key 等)请同样套用脱敏规则

6. 置信度更新（beliefUpdates）：
   **重要**：beliefUpdates 只针对知识图谱 XML 中已存在的节点，不得为本轮新创建的节点输出 beliefUpdates。
   6.1 判断逻辑：逐一扫描知识图谱 XML 中的已有节点，判断本轮对话是否对该节点提供了明确的验证证据（支持或否定），历史对话中的内容已做过置信度更新，不判断历史对话内容对已有节点的支持与否定
   6.2 只在有明确证据时输出，无证据则 beliefUpdates 为空数组 []
   6.3 supported（支持/正例）— 本轮对话证明该节点的内容是正确的：
       - 对话中 Agent 按照该节点的知识/指导执行操作，最终成功（用户确认或工具返回成功）
       - 对话中 Agent 引用了该节点的内容做出判断，用户没有纠正
       - 对话中的实际结果与该节点的预期一致
   6.4 contradicted（反对/反例）— 本轮对话证明该节点的内容有误或过时：
       - 用户明确说该节点内容有误（如"不对"、"错了"、"这个规则太严格"）
       - Agent 按照该节点指导执行但失败，且失败原因是节点信息本身有误（非外部因素）
       - 对话中的实际结果与该节点的预期矛盾
   6.5 每个置信度更新必须包含 4 个字段：
       - nodeName：精确匹配知识图谱 XML 中已有节点的 name（必须是本轮 nodes 数组中不存在的节点）
       - verdict："supported" | "contradicted"
       - weight：0.5-2.0，表示置信度调整力度
       - reason：一句话说明判断依据（引用具体对话内容）
   6.6 权重参考：
       supported: 2.0=用户明确肯定+完整验证 | 1.5=用户口头确认 | 1.0=任务成功 | 0.7=部分验证 | 0.5=间接支持
       contradicted: 2.0=用户明确否定节点内容 | 1.5=用户指出方法有误 | 1.0=因节点信息失败 | 0.7=失败但可能是外部因素 | 0.5=间接矛盾

7. 顾问建议（advisorySuggestions）—— 仅针对本轮新建节点：
   7.1 advisorySuggestions 是可选的。没有符合以下条件的新建节点时返回空数组 []，格式参考JSON Schema。
   7.2 触发条件：
       - 新建节点的内容长度超过 500 字，且为结构化数据（配置、数据库 schema、完整的操作步骤序列、项目结构等）
       - 或者是需要跨 session 精确复现的复杂配置（如完整的 NixOS flake 配置、数据库建表语句、完整的 Docker compose 文件等）
       - 注意：普通知识点（简短说明、概念解释）、简单的单条命令或单点知识，不需要写成文档
   7.3 每条建议必须包含 nodeName（精确匹配本轮新建节点的 name）。

8. 输出规范：
   8.1 只返回 JSON，格式参考JSON Schema，禁止 markdown 代码块包裹，如果节点/边/置信度更新/顾问建议等没有需要反馈的直接在对应项给出空数组即可
   8.2 禁止解释文字，禁止额外字段
   8.3 每条 edge 的 description 必须写具体内容，不能为空或"见上文"
   8.4 beliefUpdates 只针对已有节点，新创建的节点不需要 beliefUpdates
   8.5 允许进行pretty输出，不用非要压缩到一行

9. 敏感信息保护(所有节点类型强制执行):
   9.1 content 和 description 中,禁止写入任何实际敏感值(密码、API Key、Token、Access Token、Secret、Credentials 等)
   9.2 如需记录凭证,只写获取方式,例如:
       · API Key: 从 rbw 获取(rbw get xxx)
       · 密码:用户在对话中提供
       · Token: 环境变量 $OPENAI_API_KEY
       · Credentials: 从飞书 OAuth 获取
   9.3 凭证描述要具体到足以让未来重新获取,但不得包含实际值`;

// ─── 消息渲染(truncation 800 字)───────────────────────────────

const MSG_TRUNCATE = 800;

/**
 * 将消息数组渲染为 LLM 可读的文本,每条消息截断到 MSG_TRUNCATE 字符。
 * 跳过 thinking 块。
 * 以 [ROLE t=TURN] 前缀标注。
 */
export function renderMsgs(msgs: any[]): string {
  return msgs
    .map((m) => {
      const role = (m.role ?? "?").toUpperCase();
      const turn = m.turn_index ?? 0;
      let raw: string;
      if (typeof m.content === "string") {
        raw = m.content;
      } else if (Array.isArray(m.content)) {
        raw = m.content
          .filter((b: any) => b && typeof b === "object" && b.type === "text")
          .map((b: any) => {
            let text = b.text ?? "";
            if (text.length > MSG_TRUNCATE) {
              text = text.slice(0, MSG_TRUNCATE) + `\n...(truncated ${text.length - MSG_TRUNCATE} chars)`;
            }
            return text;
          })
          .join("\n");
      } else {
        raw = JSON.stringify(m.content ?? "");
      }
      if (raw.length > MSG_TRUNCATE) {
        raw = raw.slice(0, MSG_TRUNCATE) + `\n...(truncated ${raw.length - MSG_TRUNCATE} chars)`;
      }
      return `[${role} t=${turn}]\n${raw}`;
    })
    .join("\n\n---\n\n");
}

// ─── 提取 User Prompt ───────────────────────────────────────────
// knowledgeGraph: 合并后的知识图谱 XML(session 节点 + recalled 节点 merged)
const EXTRACT_USER = (recent: string, current: string, knowledgeGraph: string) =>
`<知识图谱(跨会话关联参考,请对其中的节点做信号评估)>
${knowledgeGraph || "(无)"}

=== 历史对话 ===
${recent || "(无)"}

=== 当前对话 ===
${current}`;

// ─── 整理 System Prompt ─────────────────────────────────────────

const FINALIZE_SYS = `你是图谱节点整理引擎,对本次对话产生的节点做 session 结束前的最终审查。
审查本次对话所有节点,执行以下三项操作,输出严格 JSON。

1. EVENT 升级为 SKILL:
   如果某个 EVENT 节点具有通用复用价值(不限于特定场景),将其升级为 SKILL。
   升级时需要:改名为 SKILL 命名规范、完善 content 为 SKILL 纯文本模板格式。
   写入 promotedSkills 数组。

2. 补充遗漏关系:
   整体回顾所有节点,发现单次提取时难以察觉的跨节点关系。
   边类型 name 建议从以下 20 种中选择:关系型(依赖、扩展、冲突、互补)、行为型(使用、执行、替代、触发、导致)、认知型(发现、揭示、引用、分析、理解)、问题型(遇到、解决、修正、验证、修复)、产出型(产出、实现、定义)、参考型(查阅、查看、参考)。若两个节点确实有现有边类型不能概括的语义关系,允许自定义边名。
   写入 newEdges 数组。

3. 标记失效节点:
   因本次对话中的新发现而失效的旧节点,将其 node_id 写入 invalidations 数组。

没有需要处理的项返回空数组。只返回 JSON,禁止额外文字。
格式:{"promotedSkills":[{"type":"SKILL","name":"...","description":"...","content":"..."}],"newEdges":[{"from":"...","to":"...","name":"...","description":"..."}],"invalidations":["node-id"]}`;

// ─── 整理 User Prompt ───────────────────────────────────────────

const FINALIZE_USER = (nodes: any[], summary: string) =>
`<Session Nodes>
${JSON.stringify(nodes.map(n => ({
  id: n.id, type: n.type, name: n.name,
  description: n.description, v: n.validatedCount
})), null, 2)}

<Graph Summary>
${summary}`;

// ─── 名称标准化(与 store.ts 一致)────────────────────────────

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
    /** 合并后的知识图谱 XML(session 节点 + recalled 节点 merged)*/
    knowledgeGraph?: string;
    /** 提取时附加的最近已提取消息(放在 unextracted 前面,作为上下文参考) */
    recentMessages?: any[];
    /** 本轮新建的节点名称列表（用于校验 advisorySuggestions，仅保留新建节点）*/
    newNodeNames?: string[];
  }): Promise<ExtractionResult> {
    const recentRendered = renderMsgs(params.recentMessages ?? []);
    const currentRendered = renderMsgs(params.messages);

    const raw = await this.llm(
      EXTRACT_SYS,
      EXTRACT_USER(recentRendered, currentRendered, params.knowledgeGraph ?? ""),
    );

    if (process.env.GM_DEBUG) {
      console.log("\n  [DEBUG] LLM raw response (first 2000 chars):");
      console.log("  " + raw.slice(0, 2000).replace(/\n/g, "\n  "));
    }

    return this.parseExtract(raw, params.newNodeNames);
  }

  async finalize(params: { sessionNodes: any[]; graphSummary: string }): Promise<FinalizeResult> {
    const raw = await this.llm(FINALIZE_SYS, FINALIZE_USER(params.sessionNodes, params.graphSummary));
    return this.parseFinalize(raw, params.sessionNodes);
  }

  private parseExtract(raw: string, newNodeNames_?: string[]): ExtractionResult {
    try {
      let json = extractJson(raw);

      // ── Fix: 修复 JSON 字符串内部的裸换行符 ──
      // LLM 在 content 等多行文本字段中写入了实际换行符(\n)，而非转义的\\n
      // 导致 JSON.parse 失败: "Bad control character in string literal"
      try {
        JSON.parse(json);
      } catch {
        let fixed = '';
        let inString = false;
        let i = 0;
        while (i < json.length) {
          const c = json[i];
          // 跟踪是否在字符串内部（忽略转义引号）
          if (c === '"' && (i === 0 || json[i - 1] !== '\\' || (json[i - 1] === '\\' && i > 1 && json[i - 2] === '\\'))) {
            inString = !inString;
          }
          if (c === '\n' && inString) {
            fixed += '\\n'; // 裸换行符 → 转义形式
          } else {
            fixed += c;
          }
          i++;
        }
        json = fixed;
      }
      // ────────────────────────────────────────────────

      const p = JSON.parse(json);

      const nodes = (p.nodes ?? []).filter((n: any) => {
        if (!n || typeof n !== 'object') return false; // 过滤 null/undefined
        if (!n.name || !n.type || !n.content) return false;
        // 容错：LLM 可能输出小写 type，自动转大写
        n.type = (n.type as string).toUpperCase();
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
        .filter((e: any) => e && e.from && e.to && e.name && e.description)
        .map((e: any) => {
          if (typeof e.from !== 'string' || typeof e.to !== 'string' ||
              typeof e.name !== 'string' || typeof e.description !== 'string') return null;
          return {
            from: normalizeName(e.from),
            to: normalizeName(e.to),
            name: e.name,
            description: e.description,
          };
        })
        .filter((e: any) => e !== null);

      // 解析 beliefUpdates(可选字段)
      const beliefUpdates: BeliefUpdate[] = (p.beliefUpdates ?? [])
        .filter((u: any) => u.nodeName && u.verdict && u.weight && u.reason)
        .map((u: any) => ({
          nodeName: normalizeName(u.nodeName),
          verdict: u.verdict as "supported" | "contradicted",
          weight: Math.max(0.5, Math.min(2.0, Number(u.weight))),
          reason: String(u.reason).slice(0, 200),
        }));

      // 解析 advisorySuggestions(可选字段)，仅保留本轮新建节点的建议
      const newNodeNames = new Set(newNodeNames_ ?? []);
      const advisorySuggestions: AdvisorySuggestion[] = (p.advisorySuggestions ?? [])
        .filter((a: any) => a && a.nodeName && a.suggestion && a.reason)
        .filter((a: any) => newNodeNames.size === 0 || newNodeNames.has(normalizeName(a.nodeName)))
        .map((a: any) => ({
          nodeName: normalizeName(a.nodeName),
          suggestion: String(a.suggestion).slice(0, 200),
          reason: String(a.reason).slice(0, 300),
          suggestedDocTitle: a.suggestedDocTitle ? String(a.suggestedDocTitle).slice(0, 100) : undefined,
        }));

      return { nodes, edges, beliefUpdates, advisorySuggestions };
    } catch (err) {
      throw new Error(
        `[graph-memory] extraction parse failed: ${err}\nraw: ${raw}`,
      );
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
  s = s.replace(/^\`\`\`(?:json)?\s*\n?/i, "").replace(/\n?\s*\`\`\`\s*$/i, "");
  s = s.trim();
  if (s.startsWith("{") && s.endsWith("}")) return s;
  if (s.startsWith("[") && s.endsWith("]")) return s;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}
