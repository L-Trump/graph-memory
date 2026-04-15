/**
 * graph-memory — Knowledge Graph Memory plugin for OpenClaw
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 实现：
 *   - ContextEngine 接口：bootstrap / ingest / assemble / compact / afterTurn
 *   - Hooks：before_prompt_build（召回+渲染）/ session_end（finalize+维护）
 *   - 置信度系统：beliefUpdates（LLM 提取）+ session_end task_completed 信号
 *   - 17 个 gm_* 工具
 *   - 双层噪声过滤：input-layer（noise-filter.ts）+ output-layer（extract.ts）
 *   - 关键词混合召回：向量相似度 × (1 + keywordScore × 0.4)
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { getDb } from "./src/store/db.ts";
import {
  saveMessage, getUnextracted, getRecentExtractedMessages,
  markExtracted,
  upsertNode, upsertEdge, findByName,
  getBySession, edgesFrom, edgesTo,
  deprecate, getStats, getHotNodes, getEdgesForNodes, setNodeFlags,
  getTopicNodes, getTopicToTopicEdges, getSemanticToTopicEdges,
  updateNodeBelief, recordBeliefSignal,
  setScopesForSession, getScopesForSession, getScopeHotNodes, listScopes,
  getNodeFullInfo, updateNodeFields,
  saveRecalledNodes, recordNodeAccessBatch,
  getRecentlyRecalledNodes, getRecentlyCreatedNodes,
} from "./src/store/store.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { Recaller, type TieredNode } from "./src/recaller/recall.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { assembleContext, buildExtractKnowledgeGraph } from "./src/format/assemble.ts";
import { sanitizeToolUseResultPairing } from "./src/format/transcript-repair.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { filterNoiseMessages } from "./src/extractor/noise-filter.ts";
import { invalidateGraphCache, computeGlobalPageRank } from "./src/graph/pagerank.ts";
import { detectCommunities } from "./src/graph/community.ts";
import { induceTopics } from "./src/engine/induction.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";

// ─── 从 OpenClaw config 读 provider/model ────────────────────

function readProviderModel(apiConfig: unknown): { provider: string; model: string } {
  let raw = "";

  if (apiConfig && typeof apiConfig === "object") {
    const m = (apiConfig as any).agents?.defaults?.model;
    if (typeof m === "string" && m.trim()) {
      raw = m.trim();
    } else if (m && typeof m === "object" && typeof m.primary === "string" && m.primary.trim()) {
      raw = m.primary.trim();
    }
  }

  if (!raw) {
    raw = (process.env.OPENCLAW_PROVIDER ?? "anthropic") + "/claude-haiku-4-5-20251001";
  }

  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const model = rest.join("/").trim();
    if (provider?.trim() && model) {
      return { provider: provider.trim(), model };
    }
  }

  const provider = (process.env.OPENCLAW_PROVIDER ?? "anthropic").trim();
  return { provider, model: raw };
}

// ─── 清洗 OpenClaw metadata 包装 ─────────────────────────────

function cleanPrompt(raw: string): string {
  let prompt = raw.trim();

  if (prompt.includes("Sender (untrusted metadata)")) {
    const jsonStart = prompt.indexOf("```json");
    if (jsonStart >= 0) {
      const jsonEnd = prompt.indexOf("```", jsonStart + 7);
      if (jsonEnd >= 0) {
        prompt = prompt.slice(jsonEnd + 3).trim();
      }
    }
    if (prompt.includes("Sender (untrusted metadata)")) {
      const lines = prompt.split("\n").filter(l => l.trim() && !l.includes("Sender") && !l.startsWith("```") && !l.startsWith("{"));
      prompt = lines.join("\n").trim();
    }
  }

  prompt = prompt.replace(/^\/\w+\s+/, "").trim();
  prompt = prompt.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();

  return prompt;
}

// ─── 去掉消息开头的 <gm_memory>...</gm_memory> 标签（防止每轮累积）───

function stripGmMemoryFromText(text: string): string {
  // 只去掉字符串开头的 <gm_memory>...</gm_memory> 块
  return text.trim().replace(/^<gm_memory>[\s\S]*?<\/gm_memory>/i, "").trim();
}

// ─── 规范化消息 content，确保 OpenClaw 对 content.filter() 不崩 ──

function normalizeMessageContent(messages: any[]): any[] {
  return messages.map((msg: any) => {
    if (!msg || typeof msg !== "object") return msg;
    const c = msg.content;
    // 已经是数组 → 修复畸形 block（如 { type: "text" } 缺 text 属性）
    if (Array.isArray(c)) {
      const fixed = c.map((block: any) => {
        if (block && typeof block === "object" && block.type === "text") {
          const stripped = stripGmMemoryFromText(block.text ?? "");
          return { ...block, text: stripped };
        }
        return block;
      });
      if (fixed !== c) return { ...msg, content: fixed };
      return msg;
    }
    // string → 包装成标准 content block 数组，先去掉 gm_memory
    if (typeof c === "string") {
      const stripped = stripGmMemoryFromText(c);
      return { ...msg, content: [{ type: "text", text: stripped }] };
    }
    // undefined/null → 空 text block
    if (c == null) {
      return { ...msg, content: [{ type: "text", text: "" }] };
    }
    return msg;
  });
}

// ─── 全局初始化守卫 ─────────────────────────────────────────
// 防止多个 session 并发调用 register() 时重复初始化核心模块
let _gmInitialized = false;
let _gmDb: ReturnType<typeof getDb> | null = null;
let _gmRecaller: Recaller | null = null;
let _gmExtractor: Extractor | null = null;
type LlmCompleteFn = (system: string, user: string) => Promise<string>;
let _gmLlm: LlmCompleteFn | null = null;

// ─── 插件对象 ─────────────────────────────────────────────────

const graphMemoryPlugin = {
  id: "graph-memory",
  name: "Graph Memory",
  description:
    "知识图谱记忆引擎：从对话提取三元组，FTS5+图遍历+PageRank 跨对话召回，社区聚类+向量去重自动维护",

  register(api: OpenClawPluginApi) {
    // ── 读配置 ──────────────────────────────────────────────
    const raw =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as any)
        : {};
    const cfg: GmConfig = { ...DEFAULT_CONFIG, ...raw };
    const { provider, model } = readProviderModel(api.config);

    // ── 初始化核心模块（幂等，仅首次执行）──────────────────────
    const isFirstInit = !_gmInitialized;
    let recaller: Recaller;
    let llm: LlmCompleteFn;
    let extractor: Extractor;
    let db: ReturnType<typeof getDb>;
    if (isFirstInit) {
      db = getDb(cfg.dbPath);
      _gmDb = db;
      const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      llm = createCompleteFn(provider, model, cfg.llm, anthropicApiKey);
      _gmLlm = llm;
      _gmRecaller = new Recaller(db, cfg);
      extractor = new Extractor(cfg, llm);
      _gmExtractor = extractor;

      // 异步初始化 embedding（仅首次执行）
      createEmbedFn(cfg.embedding)
        .then((fn) => {
          if (fn) {
            _gmRecaller!.setEmbedFn(fn);
            api.logger.info("[graph-memory] vector search ready");
          } else {
            api.logger.info("[graph-memory] FTS5 search mode (配置 embedding 可启用语义搜索)");
          }
        })
        .catch(() => {
          api.logger.info("[graph-memory] FTS5 search mode");
        });

      api.logger.info(
        `[graph-memory] ready | db=${cfg.dbPath} | provider=${provider} | model=${model}`,
      );

      _gmInitialized = true;
    } else {
      // 复用首次初始化的模块（均为无状态或已内部缓存）
      db = _gmDb!;
      llm = _gmLlm!;
      extractor = _gmExtractor!;
      recaller = _gmRecaller!;
    }

    // ── Session 运行时状态 ──────────────────────────────────
    const msgSeq = new Map<string, number>();
    const recalled = new Map<string, { nodes: TieredNode[]; edges: any[]; pprScores: Record<string, number> }>();
    const turnCounter = new Map<string, number>(); // 社区维护计数器

    // ── Belief 追踪状态 ────────────────────────────────────────
    // 追踪每个 session 中本轮 recall 的节点


    // ── 提取串行化（同 session Promise chain，不同 session 并行）────
    const extractChain = new Map<string, Promise<void>>();

    /** 存一条消息到 gm_messages（同步，零 LLM） */
    function ingestMessage(sessionId: string, message: any): void {
      let seq = msgSeq.get(sessionId);
      if (seq === undefined) {
        // 首次入库：从数据库读取当前最大 turn_index，避免重启后 turn_index 重叠
        const row = db.prepare(
          "SELECT MAX(turn_index) as maxTurn FROM gm_messages WHERE session_id=?"
        ).get(sessionId) as any;
        seq = Number(row?.maxTurn) || 0;
      }
      seq += 1;
      msgSeq.set(sessionId, seq);
      saveMessage(db, sessionId, seq, message.role ?? "unknown", message);
    }

    /** 每轮结束后直接提取当前轮的消息（同 session 串行，不丢消息） */
    async function runTurnExtract(sessionId: string, sessionKey: string, newMessages: any[]): Promise<void> {
      if (!newMessages.length) return;

      // Promise chain：上一次提取完了才跑下一次，不会跳过
      const prev = extractChain.get(sessionId) ?? Promise.resolve();
      const next = prev.then(async () => {
        try {
          const msgs = getUnextracted(db, sessionId, 50);

          // ── Input-layer noise filter ───────────────────────
          const filteredMsgs = filterNoiseMessages(msgs, extractUserText);
          if (!filteredMsgs.length) return;

          // 获取最近 N 轮已提取消息作为上下文参考
          const recentTurns = cfg.extractionRecentTurns ?? 3;
          const recentMsgs = getRecentExtractedMessages(db, sessionId, recentTurns);

          const sessionNodes = getBySession(db, sessionId);
          const sessionNodeIds = new Set(sessionNodes.map(n => n.id));
          const sessionEdges: any[] = [];
          for (const node of sessionNodes) {
            for (const edge of edgesFrom(db, node.id)) {
              if (sessionNodeIds.has(edge.toId)) sessionEdges.push(edge);
            }
          }
          const recalledData = recalled.get(sessionId) as any;
          const recalledNodes = recalledData?.nodes ?? [];
          const recalledEdges = recalledData?.edges ?? [];
          const knowledgeGraph = buildExtractKnowledgeGraph(db, sessionNodes, recalledNodes, sessionEdges, recalledEdges);

          const result = await extractor.extract({
            messages: filteredMsgs,
            recentMessages: recentMsgs,
            knowledgeGraph,
          });

          // ── 存储结果 ───────────────────────────────────────
          const nameToId = new Map<string, string>();
          const newNodeNames = new Set<string>();
          for (const nc of result.nodes) {
            const { node, isNew } = upsertNode(db, {
              type: nc.type, name: nc.name,
              description: nc.description, content: nc.content,
            }, sessionId);
            nameToId.set(node.name, node.id);
            if (isNew) newNodeNames.add(node.name);
            recaller.syncEmbed(node).catch(() => {});
          }

          for (const ec of result.edges) {
            const fromId = nameToId.get(ec.from) ?? findByName(db, ec.from)?.id;
            const toId = nameToId.get(ec.to) ?? findByName(db, ec.to)?.id;
            if (fromId && toId) {
              upsertEdge(db, {
                fromId, toId,
                name: ec.name,
                description: ec.description,
                sessionId,
              });
            }
          }

          const maxTurn = Math.max(...msgs.map((m: any) => m.turn_index));
          markExtracted(db, sessionId, maxTurn);

          // ── 处理置信度更新（beliefUpdates）────────────────────────
          if (result.beliefUpdates && result.beliefUpdates.length > 0) {
            for (const update of result.beliefUpdates) {
              const node = findByName(db, update.nodeName);
              if (!node) continue;

              try {
                // verdict 直接存储：supported=正例，contradicted=反例
                recordBeliefSignal(db, node.id, node.name, update.verdict, sessionId, update.weight, {
                  source: "extract_llm",
                  reason: update.reason,
                });

                // updateNodeBelief 直接用 verdict 判断正负，用 LLM 给出的 weight 累加
                const updateResult = updateNodeBelief(db, node.id, update.verdict, update.weight);
                if (updateResult && Math.abs(updateResult.delta) > 0.001) {
                  api.logger.info(
                    `[graph-memory] belief ${node.name}: ${updateResult.beliefBefore.toFixed(3)} → ${updateResult.beliefAfter.toFixed(3)} (Δ=${updateResult.delta >= 0 ? "+" : ""}${updateResult.delta.toFixed(3)}) [${update.verdict} weight=${update.weight.toFixed(1)}]`,
                  );
                  invalidateGraphCache();
                }
              } catch (err) {
                api.logger.warn(`[graph-memory] record belief for ${node.name} failed: ${err}`);
              }
            }
          }

          if (result.nodes.length || result.edges.length) {
            invalidateGraphCache();
            const nodeDetails = result.nodes.map((n: any) => `${n.type}:${n.name}`).join(", ");
            const edgeDetails = result.edges.map((e: any) => `${e.from}→[${e.name}]→${e.to}`).join(", ");
            const signalDetails = result.beliefUpdates?.length
              ? `, ${result.beliefUpdates.length} belief updates [${result.beliefUpdates.map(u => `${u.nodeName}:${u.verdict}`).join(", ")}]`
              : "";
            api.logger.info(
              `[graph-memory] extracted ${result.nodes.length} nodes [${nodeDetails}], ${result.edges.length} edges [${edgeDetails}]${signalDetails}`,
            );
          }

          // ── 记忆顾问：处理 advisorySuggestions（仅本轮新建节点）─────────────
          if (result.advisorySuggestions && result.advisorySuggestions.length > 0 && sessionKey) {
            // 只保留本轮新建节点的建议
            const validSuggestions = result.advisorySuggestions.filter(s => newNodeNames.has(s.nodeName));
            if (validSuggestions.length === 0) return;

            // 获取相关新建节点的内容
            const nodeContents = new Map<string, string>();
            for (const s of validSuggestions) {
              const node = findByName(db, s.nodeName);
              if (node) nodeContents.set(s.nodeName, node.content ?? "");
            }

            // 获取最近对话上下文
            const recentMsgs = getRecentExtractedMessages(db, sessionId, 5);
            const contextText = recentMsgs.map((m: any) => {
              const text = typeof m.content === "string" ? m.content :
                (Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n") : JSON.stringify(m.content ?? ""));
              return `[${m.role ?? "?"}] ${text.slice(0, 500)}`;
            }).join("\n\n");

            const suggestionsText = validSuggestions.map((s, i) =>
              `[建议 ${i + 1}]
节点名: ${s.nodeName}
建议: ${s.suggestion}
原因: ${s.reason}
建议文档标题: ${s.suggestedDocTitle ?? "（未指定）"}
节点内容摘要: ${nodeContents.get(s.nodeName)?.slice(0, 300) ?? "（未找到）"}`
            ).join("\n\n");

            const advisorTask = `【GM 记忆顾问任务】

当前对话上下文（最近几轮）：
${contextText || "（无）"}

记忆顾问建议（共 ${validSuggestions.length} 条）：
${suggestionsText}

你的任务：
1. 评估每条建议是否仍然有价值（对话已结束，部分内容可能已过时）
2. 对于仍有价值的"建议写成文档"类建议：
   - 将节点内容写成文档，写入 ~/.openclaw/workspace/memory/ 目录下
   - 文件名使用建议的文档标题（如有），或自动生成合适的标题
   - 完成后用 gm_edit_node 工具更新对应节点，在 content 或 description 中补充文档路径信息
3. 如果建议已过时或无价值，输出 NO_REPLY 静默即可

重要：你有完整的文件写入和 gm_edit_node 工具权限。

输出规则：
- 需要通知用户（如建议不合理、需要用户确认、文档已写成）→ 直接用自然语言描述，无需 JSON
- 无需通知用户（建议已过时、自动处理完毕）→ 输出精确字符串 NO_REPLY（不要加任何其他文字或格式）`;

            const advisorSystemPrompt = `你是 GM 记忆顾问。静默评估记忆顾问建议，无需通知用户，始终输出 NO_REPLY。`;

            // Fire-and-forget
            (async () => {
              try {
                if (!(api.runtime as any)?.subagent) {
                  api.logger.warn("[graph-memory] advisor: api.runtime.subagent not available");
                  return;
                }

                const { runId } = await (api.runtime as any).subagent.run({
                  idempotencyKey: sessionKey,
                  sessionKey,
                  message: advisorTask,
                  extraSystemPrompt: advisorSystemPrompt,
                  deliver: false,
                });

                api.logger.info(
                  `[graph-memory] advisor launched: runId=${runId}, suggestions=${validSuggestions.length} [${validSuggestions.map(s => s.nodeName).join(", ")}]`,
                );
              } catch (err) {
                api.logger.warn(`[graph-memory] advisor launch failed: ${err}`);
              }
            })();
          }
        } catch (err) {
          api.logger.error(`[graph-memory] turn extract failed: ${err}`);
          // 不 throw — 失败不阻塞 chain 中下一次提取
        }
      });
      extractChain.set(sessionId, next);
      return next;
    }

        // ── before_prompt_build：召回 + 渲染 KG（注入 appendSystemContext）───

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      try {
        const rawPrompt = typeof event?.prompt === "string" ? event.prompt : "";
        const prompt = cleanPrompt(rawPrompt);
        if (!prompt) return;
        if (prompt.includes("/new or /reset") || prompt.includes("new session was started")) return;

        const sid = ctx?.sessionId ?? ctx?.sessionKey;

        // ── 只取最近 3 轮 user+assistant 消息作为 recall query ────────
        const recallSlice = sliceLastTurn(event.messages ?? [], RECALL_KEEP_TURNS);
        const recallQuery = [...(recallSlice.messages
          .map((m: any) => {
            const text = typeof m.content === "string" ? m.content :
              (Array.isArray(m.content)
                ? m.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n")
                : String(m.content ?? ""));
            // 去掉 OpenClaw metadata wrapper
            const fenceEnd = text.lastIndexOf("```");
            const cleaned = fenceEnd >= 0 && text.includes("Sender") ? text.slice(fenceEnd + 3).trim() : text;
            return `[${m.role}] ${cleaned}`;
          })), `[user] ${prompt}`]
          .join("\n")
          .replace(/^\[[\w\s\-:]*\]\s*/, "")
          .trim();

        const query = recallQuery || prompt;
        api.logger.info(`[graph-memory] recall query (${RECALL_KEEP_TURNS} turns): "${query.slice(0, 80)}"`);

        // ── 召回 ────────────────────────────────────────────────
        const res = await recaller.recallV2(query);
        if (res.nodes.length) {
          const stored = { nodes: res.nodes, edges: res.edges, pprScores: res.pprScores };
          if (ctx?.sessionId) recalled.set(ctx.sessionId, stored);
          if (ctx?.sessionKey && ctx.sessionKey !== ctx?.sessionId) {
            recalled.set(ctx.sessionKey, stored);
          }

          const tierCounts: Record<string, number> = {};
          for (const n of res.nodes) {
            tierCounts[n.tier ?? "?"] = (tierCounts[n.tier ?? "?"] ?? 0) + 1;
          }
          const tierStr = ["L1", "L2", "L3"].map(t => `${t}=${tierCounts[t] ?? 0}`).join(" ");
          api.logger.info(
            `[graph-memory] recalled ${res.nodes.length} nodes [${tierStr}], ${res.edges.length} edges`,
          );

          // ── 记录召回节点到 gm_recalled 表 ────────────────────────
          const currentTurn = msgSeq.get(sid) ?? 1;
          saveRecalledNodes(db, sid, currentTurn, res.nodes.map((n: any) => ({
            id: n.id,
            name: n.name,
            type: n.type,
            tier: n.tier,
            semanticScore: n.semanticScore ?? undefined,
            pprScore: n.pprScore ?? undefined,
            combinedScore: n.combinedScore ?? undefined,
          })));
        }

        // ── 组装 KG 并注入 appendSystemContext（优先级低于 Claw 核心设定）──
        const rec = recalled.get(sid) ?? { nodes: [], edges: [], pprScores: {} };
        const activeNodes = getBySession(db, sid);
        const activeEdges = activeNodes.flatMap((n) => [
          ...edgesFrom(db, n.id),
          ...edgesTo(db, n.id),
        ]);
        const hotNodes = getHotNodes(db);
        const hotEdges = hotNodes.length > 0 ? getEdgesForNodes(db, hotNodes.map(n => n.id)) : [];
        const sessionScopes = getScopesForSession(db, ctx?.sessionKey ?? ctx?.sessionId);
        const scopeHotNodes = sessionScopes.length > 0 ? getScopeHotNodes(db, sessionScopes) : [];
        const scopeHotEdges = scopeHotNodes.length > 0 ? getEdgesForNodes(db, scopeHotNodes.map(n => n.id)) : [];

        if (activeNodes.length === 0 && rec.nodes.length === 0 && hotNodes.length === 0 && scopeHotNodes.length === 0) {
          return;
        }

        const { xml, systemPrompt, tokens: gmTokens, episodicXml, episodicTokens } = assembleContext(db, cfg, {
          tokenBudget: 0,
          scopeHotNodes,
          scopeHotEdges,
          hotNodes,
          hotEdges,
          activeNodes,
          activeEdges,
          recalledNodes: rec.nodes,
          recalledEdges: rec.edges,
          pprScores: rec.pprScores,
          graphWalkDepth: cfg.recallMaxDepth,
        });

        if (gmTokens > 0 || episodicTokens > 0) {
          api.logger.info(
            `[graph-memory] bpb inject: graph ~${gmTokens} tok` +
            (scopeHotNodes.length > 0 ? `, scope_hot=${scopeHotNodes.length}` : "") +
            (episodicTokens > 0 ? `, episodic ~${episodicTokens} tok` : ""),
          );
        }

        // 记录已组装节点的访问（用于衰减引擎）- 仅 L1 节点
        const l1NodeIds = rec.nodes.filter(n => n.tier === "L1").map(n => n.id);
        if (l1NodeIds.length > 0) {
          recordNodeAccessBatch(db, l1NodeIds);
        }

        // systemPrompt → appendSystemContext（追加在 prompt 末尾）
        // xml + episodicXml → <gm_memory> 包裹后作为 prependContext（前置）
        const gmBody = [xml, episodicXml].filter(Boolean).join("\n\n");
        const prepend = gmBody ? `<gm_memory>\n\n${gmBody}\n\n</gm_memory>` : "";
        const append = systemPrompt;

        if (prepend || append) {
          return {
            ...(prepend ? { prependContext: prepend } : {}),
            ...(append ? { appendSystemContext: append } : {}),
          };
        }
      } catch (err) {
        api.logger.warn(`[graph-memory] before_prompt_build failed: ${err}`);
      }
    });

    // ── ContextEngine ────────────────────────────────────────

    const engine = {
      info: {
        id: "graph-memory",
        name: "Graph Memory",
        ownsCompaction: false,
      },

      async bootstrap({ sessionId }: { sessionId: string }) {
        return { bootstrapped: true };
      },

      async ingest({
        sessionId,
        message,
        isHeartbeat,
      }: {
        sessionId: string;
        message: any;
        isHeartbeat?: boolean;
      }) {
        if (isHeartbeat) return { ingested: false };
        ingestMessage(sessionId, message);
        return { ingested: true };
      },

      async assemble({
        sessionId,
        messages,
        tokenBudget,
      }: {
        sessionId: string;
        messages: any[];
        tokenBudget?: number;
      }) {
        // KG 渲染已移至 before_prompt_build（appendSystemContext）
        // assemble 只截断消息 (省token，按次数收费模型中可以考虑禁用，已禁用)
        // const activeNodes = getBySession(db, sessionId);
        // if (activeNodes.length === 0) {
        //   return { messages: normalizeMessageContent(messages), estimatedTokens: 0 };
        // }
        // const lastTurn = sliceLastTurn(messages);
        // const repaired = sanitizeToolUseResultPairing(lastTurn.messages);
        const repaired = messages;

        return {
          messages: normalizeMessageContent(repaired),
          estimatedTokens: 0,
        };
      },

      async compact(params: {
        sessionId: string;
        sessionFile: string;
        tokenBudget?: number;
        force?: boolean;
        currentTokenCount?: number;
        customInstructions?: string;
        compactionTarget?: "budget" | "threshold";
        runtimeContext?: Record<string, unknown>;
      }) {
        // compact 仍然保留作为兜底，但主要提取在 afterTurn 完成
        // 知识提取使用 fire-and-forget，不阻塞 compaction 返回
        const { sessionId, sessionFile, force, currentTokenCount } = params;
        const msgs = getUnextracted(db, sessionId, 50);

        // ── Input-layer noise filter ───────────────────────
        const filteredMsgs = filterNoiseMessages(msgs, extractUserText);
        if (!filteredMsgs.length) {
          return await delegateCompactionToRuntime(params);
          // return {
          //   ok: true, compacted: false,
          //   result: {
          //     summary: `no messages after noise filter`,
          //     tokensBefore: currentTokenCount ?? 0,
          //   },
          // };
        }

        // fire-and-forget：提取异步进行，不阻塞 compaction 返回
        runTurnExtract(sessionId, sessionId, filteredMsgs).catch((err) => {
          api.logger.error(`[graph-memory] compact extract failed: ${err}`);
        });

        return await delegateCompactionToRuntime(params);
        // return {
        //   ok: true, compacted: false,
        //   result: {
        //     summary: `extraction queued (fire-and-forget)`,
        //     tokensBefore: currentTokenCount ?? 0,
        //   },
        // };
      },

      async afterTurn({
        sessionId,
        messages,
        prePromptMessageCount,
        isHeartbeat,
      }: {
        sessionId: string;
        sessionFile: string;
        messages: any[];
        prePromptMessageCount: number;
        autoCompactionSummary?: string;
        isHeartbeat?: boolean;
        tokenBudget?: number;
      }) {
        if (isHeartbeat) return;

        // 消息入库（同步，零 LLM）
        const newMessages = messages.slice(prePromptMessageCount ?? 0);
        for (const message of newMessages) {
          ingestMessage(sessionId, message);
        }

        const totalMsgs = msgSeq.get(sessionId) ?? 0;
        api.logger.info(
          `[graph-memory] afterTurn sid=${sessionId.slice(0, 8)} newMsgs=${newMessages.length} totalMsgs=${totalMsgs}`,
        );

        // ★ 每轮直接提取
        runTurnExtract(sessionId, sessionId, newMessages).catch((err) => {
          api.logger.error(`[graph-memory] turn extract failed: ${err}`);
        });

        // ★ 社区维护：每 N 轮触发一次（纯计算，<5ms）
        const turns = (turnCounter.get(sessionId) ?? 0) + 1;
        turnCounter.set(sessionId, turns);
        const maintainInterval = cfg.compactTurnCount ?? 7;

        if (turns % maintainInterval === 0) {
          try {
            // ★ 主题归纳：先对当前 session 的语义节点归纳主题
            const sessionNodes = getBySession(db, sessionId);
            const sessionSemanticNodes = sessionNodes.filter(n =>
              ["TASK", "SKILL", "EVENT", "KNOWLEDGE", "STATUS"].includes(n.type)
            );
            if (sessionSemanticNodes.length > 0) {
              // ★ 主题归纳：fire-and-forget，不阻塞 afterTurn
              induceTopics({
                db,
                sessionNodes: sessionSemanticNodes,
                llm,
                recaller,
              }).then((induction) => {
                const total =
                  induction.createdTopics.length +
                  induction.updatedTopics.length +
                  induction.semanticToTopicEdges.length +
                  induction.topicToTopicEdges.length;
                if (total > 0) {
                  invalidateGraphCache();
                }
                api.logger.info(
                  `[graph-memory] periodic topic induction (turn ${turns}): ` +
                  `created=${induction.createdTopics.length}, updated=${induction.updatedTopics.length}, ` +
                  `sem→topic=${induction.semanticToTopicEdges.length}, topic↔topic=${induction.topicToTopicEdges.length}`,
                );
              }).catch((err) => {
                const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
                api.logger.error(`[graph-memory] periodic topic induction failed: ${msg}`);
              });
            }

            // ★ 社区维护
            invalidateGraphCache();
            const pr = computeGlobalPageRank(db, cfg);
            const comm = detectCommunities(db);
            api.logger.info(
              `[graph-memory] periodic maintenance (turn ${turns}): ` +
              `pagerank top=${pr.topK.slice(0, 3).map(n => n.name).join(",")}, ` +
              `communities=${comm.count}`,
            );

            // 社区摘要：fire-and-forget（后台异步，不阻塞 afterTurn 返回）
            if (comm.communities.size > 0) {
              (async () => {
                try {
                  const { summarizeCommunities } = await import("./src/graph/community.ts");
                  const embedFn = (recaller as any).embed ?? undefined;
                  const summaries = await summarizeCommunities(db, comm.communities, llm, embedFn);
                  api.logger.info(
                    `[graph-memory] community summaries refreshed: ${summaries} summaries`,
                  );
                } catch (e) {
                  api.logger.error(`[graph-memory] community summary failed: ${e}`);
                }
              })();
            }
          } catch (err) {
            api.logger.error(`[graph-memory] periodic maintenance failed: ${err}`);
          }
        }
      },

      async prepareSubagentSpawn({
        parentSessionKey,
        childSessionKey,
      }: {
        parentSessionKey: string;
        childSessionKey: string;
      }) {
        const rec = recalled.get(parentSessionKey);
        if (rec) recalled.set(childSessionKey, rec);
        return { rollback: () => { recalled.delete(childSessionKey); } };
      },

      async onSubagentEnded({ childSessionKey }: { childSessionKey: string }) {
        recalled.delete(childSessionKey);
        msgSeq.delete(childSessionKey);
      },

      async dispose() {
        extractChain.clear();
        msgSeq.clear();
        recalled.clear();
      },
    };

    api.registerContextEngine("graph-memory", () => engine);

    // ── session_end：finalize + 图维护 ──────────────────────

    api.on("session_end", async (event: any, ctx: any) => {
      const sid =
        ctx?.sessionId ??
        ctx?.sessionKey ??
        event?.sessionId ??
        event?.sessionKey;
      if (!sid) return;

      try {
        const nodes = getBySession(db, sid);
        if (nodes.length) {
          const summary = (
            db.prepare(
              "SELECT name, type, validated_count, pagerank FROM gm_nodes WHERE status='active' ORDER BY pagerank DESC LIMIT 20",
            ).all() as any[]
          )
            .map((n) => `${n.type}:${n.name}(v${n.validated_count},pr${n.pagerank.toFixed(3)})`)
            .join(", ");

          const fin = await extractor.finalize({
            sessionNodes: nodes,
            graphSummary: summary,
          });

          for (const nc of fin.promotedSkills) {
            if (nc.name && nc.content) {
              const { node } = upsertNode(db, {
                type: "SKILL", name: nc.name,
                description: nc.description ?? "", content: nc.content,
              }, sid);
              recaller.syncEmbed(node).catch(() => {});
            }
          }
          for (const ec of fin.newEdges) {
            const fromId = findByName(db, ec.from)?.id;
            const toId = findByName(db, ec.to)?.id;
            if (fromId && toId) {
              upsertEdge(db, {
                fromId, toId,
                name: ec.name,
                description: ec.description,
                sessionId: sid,
              });
            }
          }
          for (const id of fin.invalidations) deprecate(db, id);
        }

        // ★ Topic Induction：基于 session 语义节点归纳主题（fire-and-forget）
        {
          const sessionNodes = getBySession(db, sid);
          const sessionSemanticNodes = sessionNodes.filter(n =>
            ["TASK", "SKILL", "EVENT", "KNOWLEDGE", "STATUS"].includes(n.type)
          );

          if (sessionSemanticNodes.length > 0) {
            induceTopics({
              db,
              sessionNodes: sessionSemanticNodes,
              llm,
              recaller,
            }).then((induction) => {
              const total =
                induction.createdTopics.length +
                induction.updatedTopics.length +
                induction.semanticToTopicEdges.length +
                induction.topicToTopicEdges.length;
              if (total > 0) {
                invalidateGraphCache();
              }
              api.logger.info(
                `[graph-memory] session_end topic induction: ` +
                `created=${induction.createdTopics.length}, updated=${induction.updatedTopics.length}, ` +
                `sem→topic=${induction.semanticToTopicEdges.length}, topic↔topic=${induction.topicToTopicEdges.length}`,
              );
            }).catch((err) => {
              const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
              api.logger.error(`[graph-memory] session_end topic induction failed: ${msg}`);
            });
          }
        }

        const embedFn = (recaller as any).embed ?? undefined;
        const result = await runMaintenance(db, cfg, llm, embedFn);
        api.logger.info(
          `[graph-memory] maintenance: ${result.durationMs}ms, ` +
          `dedup=${result.dedup.merged}, ` +
          `communities=${result.community.count}, ` +
          `summaries=${result.communitySummaries}, ` +
          `top_pr=${result.pagerank.topK.slice(0, 3).map((n: any) => `${n.name}(${n.score.toFixed(3)})`).join(",")}`,
        );

        // ── Belief: Session 完成信号 ──────────────────────────
        // 对本 session 的所有节点记录 task_completed 信号（如果 session_nodes 存在）
        try {
          const sessionBeliefNodes = getBySession(db, sid);
          for (const node of sessionBeliefNodes) {
            try {
              recordBeliefSignal(db, node.id, node.name, "supported", sid, 0.3, {
                source: "session_end",
                nodeCount: sessionBeliefNodes.length,
              });
              updateNodeBelief(db, node.id, "supported");
            } catch { /* belief may not be migrated */ }
          }
          if (sessionBeliefNodes.length > 0) {
            api.logger.info(
              `[graph-memory] session_end belief: emitted task_completed for ${sessionBeliefNodes.length} session nodes`,
            );
          }
        } catch (err) {
          api.logger.warn(`[graph-memory] session_end belief update failed: ${err}`);
        }
      } catch (err) {
        api.logger.error(`[graph-memory] session_end error: ${err}`);
      } finally {
        extractChain.delete(sid);
        msgSeq.delete(sid);
        recalled.delete(sid);
        turnCounter.delete(sid);
      }
    });

    // ── Agent Tools（改名 gm_*）──────────────────────────────

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_search",
        label: "Search Graph Memory",
        description: "搜索知识图谱中的相关经验、技能和解决方案。遇到可能之前解决过的问题时调用。",
        parameters: Type.Object({
          query: Type.String({ description: "搜索关键词或问题描述" }),
        }),
        async execute(_toolCallId: string, params: { query: string }) {
          const { query } = params;
          const res = await recaller.recallV2(query);
          if (!res.nodes.length) {
            return {
              content: [{ type: "text", text: "图谱中未找到相关记录。" }],
              details: { count: 0, query },
            };
          }

          // 记录 L1 节点的访问（用于衰减引擎）
          const l1NodeIds = res.nodes.filter((n: any) => n.tier === "L1").map((n: any) => n.id);
          if (l1NodeIds.length > 0) {
            recordNodeAccessBatch(db, l1NodeIds);
          }

          // 过滤掉 filtered 节点
          const displayNodes = res.nodes.filter((n: any) => n.tier !== "filtered");
          const nodeMap = new Map(displayNodes.map((n: any) => [n.id, n]));

          const lines = displayNodes.map((n: any) => {
            const tierLabel = n.tier === "hot" ? "【🔥HOT】" : n.tier === "L1" ? "【L1-完整】" : n.tier === "L2" ? "【L2-描述】" : "【L3-名称】";
            const hotFlag = n.flags?.includes("hot") ? " 🔥" : "";
            const scores = [];
            if (n.semanticScore != null) scores.push(`语义=${n.semanticScore.toFixed(3)}`);
            if (n.pprScore != null) scores.push(`PPR=${n.pprScore.toFixed(3)}`);
            if (n.pagerankScore != null) scores.push(`PR=${n.pagerankScore.toFixed(3)}`);
            if (n.combinedScore != null) scores.push(`综合=${n.combinedScore.toFixed(3)}`);
            if (n.belief != null) scores.push(`置信度=${n.belief.toFixed(3)}`);
            const scoreStr = scores.length ? ` (${scores.join(", ")})` : "";
            // L1: 完整内容，L2: description，L3/hot: 仅名字
            let contentPart = "";
            if (n.tier === "L1") {
              contentPart = `\n${n.description || ""}\n${(n.content || "").slice(0, 300)}`;
            } else if (n.tier === "L2") {
              contentPart = n.description ? `\n描述: ${n.description}` : "";
            }
            return `${tierLabel} [${n.type}] ${n.name}${hotFlag}${scoreStr}${contentPart}`;
          });

          const filteredEdges = res.edges.filter(
            (e: any) => nodeMap.has(e.fromId) && nodeMap.has(e.toId),
          );
          const edgeLines = filteredEdges.map((e: any) => {
            const from = nodeMap.get(e.fromId)?.name ?? e.fromId;
            const to = nodeMap.get(e.toId)?.name ?? e.toId;
            return `  ${from} --[${e.name}]--> ${to}: ${e.description}`;
          });

          const text = [
            `找到 ${displayNodes.length} 个节点：\n`,
            ...lines,
            ...(edgeLines.length ? ["\n关系：", ...edgeLines] : []),
          ].join("\n\n");

          // 返回完整 TieredNode 信息（已过滤 filtered）
          const tieredInfo = displayNodes.map((n: any) => {
            // Get belief info if available
            let belief: number | null = null;
            let successCount: number | null = null;
            let failureCount: number | null = null;
            try {
              const bRow = db.prepare("SELECT belief, success_count, failure_count FROM gm_nodes WHERE id=?").get(n.id) as any;
              if (bRow) {
                belief = bRow.belief ?? null;
                successCount = bRow.success_count ?? null;
                failureCount = bRow.failure_count ?? null;
              }
            } catch { /* belief not available */ }

            return {
              id: n.id,
              type: n.type,
              name: n.name,
              description: n.description,
              content: n.content,
              status: n.status,
              flags: n.flags ?? [],
              validatedCount: n.validatedCount,
              pagerank: n.pagerank,
              communityId: n.communityId,
              createdAt: n.createdAt,
              updatedAt: n.updatedAt,
              tier: n.tier,
              semanticScore: n.semanticScore ?? null,
              pprScore: n.pprScore ?? null,
              pagerankScore: n.pagerankScore ?? null,
              combinedScore: n.combinedScore ?? null,
              belief,
              successCount,
              failureCount,
            };
          });

          return {
            content: [{ type: "text", text }],
            details: { count: displayNodes.length, query, tieredInfo },
          };
        },
      }),
      { name: "gm_search" },
    );

    api.registerTool(
      (ctx: any) => ({
        name: "gm_record",
        label: "Record to Graph Memory",
        description: "手动记录经验到知识图谱。发现重要解法、踩坑经验或工作流程时调用。",
        parameters: Type.Object({
          content: Type.String({ description: "用自然语言描述需要记忆的内容（会被当作待提取对话）" }),
          flags: Type.Optional(Type.Array(Type.String(), { description: "节点标记数组。默认不传或者传空数组[]，可用的标记有\"hot\"和\"scope_hot:<scope_name>\"" })),
        }),
        async execute(
          _toolCallId: string,
          p: { content: string; flags?: string[] },
        ) {
          const sid = ctx?.sessionId ?? ctx?.sessionKey ?? "manual";

          // ── 1. 获取本 session 已有的节点 ─────────────────────
          const sessionNodes = getBySession(db, sid);
          const sessionNodeIds = new Set(sessionNodes.map(n => n.id));
          const sessionEdges: any[] = [];
          for (const node of sessionNodes) {
            for (const edge of edgesFrom(db, node.id)) {
              if (sessionNodeIds.has(edge.toId)) sessionEdges.push(edge);
            }
          }

          // ── 2. recallV2 召回相关节点 ────────────────────────
          const recalledResult = await recaller.recallV2(p.content);
          const recalledNodes = recalledResult.nodes;
          const recalledEdges = recalledResult.edges;

          // ── 3. 构建知识图谱（组合评分三级格式）───────────────
          const knowledgeGraph = buildExtractKnowledgeGraph(db, sessionNodes, recalledNodes, sessionEdges, recalledEdges);

          // ── 4. 构造带系统指令的消息序列，触发提取 ───────────
          // system: 明确 gm_record 的提取规则，覆盖默认的会话提取行为
          // user:   原始记录内容
          const recordSysPrompt = `【记忆记录指令 — 仅在执行 gm_record 时使用】

当你收到用户通过 gm_record 工具主动提交的记忆内容时，严格按以下规则处理：

1. 创建新记忆：仔细分析用户提供的记忆内容，创建能够准确反映原始语义的记忆节点。每个记忆节点必须包含完整的 name、type、description 和 content。

2. 去重与合并：如果待创建的记忆与已有记忆在语义上重叠或重复，请将该记忆的内容与已有记忆的内容进行语义合并，然后通过同名节点的方式更新（对应程序中的 upsert 语义，相同 name 的节点会被覆盖而非重复创建）。

3. 允许多节点：允许对复杂内容进行语义切分，创建多个独立的记忆节点，只要它们各自有独立的语义即可。不要强行把不相关的内容合并到一个节点。

4. 语义覆盖完整性：创建的节点内容必须能够完整覆盖用户传入的原始语义，不得遗漏关键信息。

5. 提取范围：仅从下方【待记录内容】中提取知识，不要自行补充或扩展无关内容。`;

          const simulatedMsgs = [
            { role: "system", turn_index: 0, content: recordSysPrompt },
            { role: "user",   turn_index: 1, content: `【待记录内容】\n${p.content}` },
          ];
          const result = await extractor.extract({
            messages: simulatedMsgs,
            knowledgeGraph,
          });

          // ── 5. 存储提取结果 ────────────────────────────────
          const nameToId = new Map<string, string>();
          for (const nc of result.nodes) {
            const { node } = upsertNode(db, {
              type: nc.type, name: nc.name,
              description: nc.description, content: nc.content,
              flags: p.flags,
            }, sid);
            nameToId.set(node.name, node.id);
            recaller.syncEmbed(node).catch(() => {});
          }

          for (const ec of result.edges) {
            const fromId = nameToId.get(ec.from) ?? findByName(db, ec.from)?.id;
            const toId = nameToId.get(ec.to) ?? findByName(db, ec.to)?.id;
            if (fromId && toId) {
              upsertEdge(db, {
                fromId, toId,
                name: ec.name,
                description: ec.description,
                sessionId: sid,
              });
            }
          }

          if (result.nodes.length || result.edges.length) {
            invalidateGraphCache();
          }

          const nodeNames = result.nodes.map((n: any) => `${n.type}:${n.name}`).join(", ");
          const edgeNames = result.edges.map((e: any) => `${e.from}→[${e.name}]→${e.to}`).join(", ");

          return {
            content: [{
              type: "text",
              text: `提取完成：${result.nodes.length} 个节点 [${nodeNames}]，${result.edges.length} 条边 [${edgeNames}]${p.flags?.includes("hot") ? "（已标记为 hot）" : ""}`,
            }],
            details: { nodes: result.nodes.length, edges: result.edges.length },
          };
        },
      }),
      { name: "gm_record" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_stats",
        label: "Graph Memory Stats",
        description: "查看知识图谱的统计信息：节点数、边数、社区数、Hot 节点数、PageRank Top 节点、Embedding 开启状态。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const stats = getStats(db);
          const topPr = (db.prepare(
            "SELECT name, type, pagerank FROM gm_nodes WHERE status='active' ORDER BY pagerank DESC LIMIT 5"
          ).all() as any[]);
          const embedEnabled = recaller.isEmbedReady();
          const pendingCount = (recaller as any).pendingEmbedNodes?.length ?? 0;
          const topicCount = (db.prepare(
            "SELECT COUNT(*) as c FROM gm_nodes WHERE type='TOPIC' AND status='active'"
          ).get() as any)?.c ?? 0;

          // Belief 统计
          let beliefText = "";
          try {
            const beliefRows = db.prepare(
              "SELECT belief FROM gm_nodes WHERE status='active'"
            ).all() as any[];
            const beliefs = beliefRows.map((r: any) => r.belief ?? 0.5);
            if (beliefs.length > 0) {
              const avgBelief = beliefs.reduce((s: number, b: number) => s + b, 0) / beliefs.length;
              const highBelief = beliefs.filter((b: number) => b > 0.7).length;
              const lowBelief = beliefs.filter((b: number) => b < 0.3).length;
              const signalCount = (db.prepare("SELECT COUNT(*) as c FROM gm_belief_signals").get() as any)?.c ?? 0;
              beliefText = `\n置信度：平均 ${avgBelief.toFixed(3)} | 高置信度(>0.7): ${highBelief} | 低置信度(<0.3): ${lowBelief} | 信号总数: ${signalCount}`;
            }
          } catch { /* belief columns may not exist */ }

          const text = [
            `知识图谱统计`,
            `节点：${stats.totalNodes} 个 (${["TASK","SKILL","EVENT","KNOWLEDGE","STATUS","TOPIC"].map(t => `${t}: ${t === "TOPIC" ? topicCount : (stats.byType[t] ?? 0)}`).join(", ")})`,
            `边：${stats.totalEdges} 条 (${Object.entries(stats.byEdgeType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `社区：${stats.communities} 个`,
            `Hot 节点：${stats.hotNodes} 个`,
            `Embedding：${embedEnabled ? "✅ 已开启" : "❌ 未开启"}${pendingCount > 0 ? ` (待处理: ${pendingCount})` : ""}`,
            `PageRank Top 5：`,
            ...topPr.map((n, i) => `  ${i + 1}. ${n.name} (${n.type}, pr=${n.pagerank.toFixed(4)})`),
            beliefText,
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: { ...stats, embedEnabled, pendingEmbedCount: pendingCount },
          };
        },
      }),
      { name: "gm_stats" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_maintain",
        label: "Graph Memory Maintenance",
        description: "手动触发图维护：运行去重、PageRank 重算、社区检测。通常 session_end 时自动运行，这个工具用于手动触发。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const embedFn = (recaller as any).embed ?? undefined;
          const result = await runMaintenance(db, cfg, llm, embedFn);
          const text = [
            `图维护完成（${result.durationMs}ms）`,
            `去重：发现 ${result.dedup.pairs.length} 对相似节点，合并 ${result.dedup.merged} 对`,
            ...(result.dedup.pairs.length > 0
              ? result.dedup.pairs.slice(0, 5).map(p =>
                  `  "${p.nameA}" ≈ "${p.nameB}" (${(p.similarity * 100).toFixed(1)}%)`)
              : []),
            `社区：${result.community.count} 个`,
            `PageRank Top 5：`,
            ...result.pagerank.topK.slice(0, 5).map((n, i) =>
              `  ${i + 1}. ${n.name} (${n.score.toFixed(4)})`),
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: {
              durationMs: result.durationMs,
              dedupMerged: result.dedup.merged,
              communities: result.community.count,
            },
          };
        },
      }),
      { name: "gm_maintain" },
    );

    // ── gm_get_hots ───────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_get_hots",
        label: "Get Hot Nodes from Graph Memory",
        description: "获取当前所有 hot 节点。hot 节点在每次 assemble 时必定渲染，拥有最高优先级。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const hotNodes = getHotNodes(db);
          if (!hotNodes.length) {
            return {
              content: [{ type: "text", text: "当前没有 hot 节点。" }],
              details: { count: 0 },
            };
          }
          const lines = hotNodes.map((n: any) => {
            const flagsStr = n.flags?.length ? ` [${n.flags.map((f: string) => `"${f}"`).join(", ")}]` : "";
            return `[${n.type}] ${n.name}${flagsStr}\n  ${n.description || "(无描述)"}\n  ${(n.content || "").slice(0, 500)}${(n.content || "").length > 500 ? "..." : ""}`;
          });
          const text = [
            `当前共有 ${hotNodes.length} 个 hot 节点：`,
            "",
            ...lines,
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: { count: hotNodes.length, nodes: hotNodes },
          };
        },
      }),
      { name: "gm_get_hots" },
    );

    // ── gm_set_flags ───────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_set_flags",
        label: "Set Flags on Graph Memory Node",
        description: "为已有节点设置 flags（覆盖而非追加）。可用于将节点标记为 hot（flags=[\"hot\"]）以在每次 assemble 时必定渲染，也可传入空数组清除所有 flags。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称，精确匹配" }),
          flags: Type.Array(Type.String(), { description: "flags 数组，例如 [\"hot\"] 或 []（空数组清除所有 flags）" }),
        }),
        async execute(_toolCallId: string, params: { name: string; flags: string[] }) {
          const { name, flags } = params;
          const node = findByName(db, name);
          if (!node) {
            return {
              content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }],
              details: { success: false, name },
            };
          }
          const ok = setNodeFlags(db, node.id, flags);
          if (!ok) {
            return {
              content: [{ type: "text", text: `更新节点 "${name}" 的 flags 失败。` }],
              details: { success: false, name },
            };
          }
          invalidateGraphCache();
          return {
            content: [{
              type: "text",
              text: `节点 "${name}" 的 flags 已更新为 [${flags.map(f => `"${f}"`).join(", ")}]${flags.includes("hot") ? "（hot 节点，每次 assemble 时必定渲染）" : ""}`,
            }],
            details: { success: true, name, flags },
          };
        },
      }),
      { name: "gm_set_flags" },
    );

    // ── gm_get_node ───────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_get_node",
        label: "Get Full Node Info from Graph Memory",
        description: "获取指定节点的完整信息，包括名称、类型、描述、内容、置信度、flags，以及该节点所有出边和入边。适用于查看节点详情。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称，精确匹配" }),
        }),
        async execute(_toolCallId: string, params: { name: string }) {
          const { name } = params;
          const { node, edgesFrom, edgesTo, beliefHistory } = getNodeFullInfo(db, name);
          if (!node) {
            return { content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }], details: { success: false } };
          }
          const flagsStr = node.flags?.length ? `[${node.flags.map((f: string) => `"${f}"`).join(", ")}]` : "[]";
          const lines = [
            `[${node.type}] ${node.name}`,
            `  描述: ${node.description || "(无)"}`,
            `  内容: ${(node.content || "(无)").slice(0, 800)}${(node.content || "").length > 800 ? "..." : ""}`,
            `  状态: ${node.status} | 验证次数: ${node.validatedCount} | PageRank: ${node.pagerank?.toFixed(4) ?? "N/A"}`,
            `  flags: ${flagsStr}`,
            `  置信度: ${node.belief?.toFixed(3) ?? "N/A"} (成功: ${node.successCount ?? 0}, 失败: ${node.failureCount ?? 0})`,
            `  创建: ${new Date(node.createdAt).toLocaleString("zh-CN")} | 更新: ${new Date(node.updatedAt).toLocaleString("zh-CN")}`,
            `  出边 (${edgesFrom.length}):`,
            ...edgesFrom.slice(0, 20).map((e: any) =>
              `    → [${e.type}] ${e.name} → ${e.toId}`
            ),
            `  入边 (${edgesTo.length}):`,
            ...edgesTo.slice(0, 20).map((e: any) =>
              `    ← [${e.type}] ${e.name} ← ${e.fromId}`
            ),
            `  Belief 历史信号 (${beliefHistory.length} 条):`,
            ...beliefHistory.slice(0, 10).map((s: any) =>
              `    ${s.verdict === "supported" ? "✅" : "❌"} weight=${s.weight.toFixed(2)} at ${new Date(s.createdAt).toLocaleString("zh-CN")}`
            ),
          ];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { success: true, node, edgesFrom, edgesTo, beliefHistory },
          };
        },
      }),
      { name: "gm_get_node" },
    );

    // ── gm_edit_node ──────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_edit_node",
        label: "Edit Node Content and Description",
        description: "编辑指定节点的描述和内容（覆盖式更新，不做合并）。编辑完成后自动重新计算语义嵌入向量。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称，精确匹配" }),
          description: Type.Optional(Type.String({ description: "新的描述文本（可选）" })),
          content: Type.Optional(Type.String({ description: "新的内容文本（可选）" })),
        }),
        async execute(_toolCallId: string, params: { name: string; description?: string; content?: string }) {
          const { name, description, content } = params;
          if (!description && !content) {
            return { content: [{ type: "text", text: "至少需要提供 description 或 content 之一。" }], details: { success: false } };
          }
          const updated = updateNodeFields(db, name, { description, content });
          if (!updated) {
            return { content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }], details: { success: false } };
          }
          // Re-embed
          let embedMsg = "";
          if (recaller.isEmbedReady()) {
            await recaller.syncEmbed(updated, true);
            embedMsg = "，嵌入向量已重新计算";
          } else {
            embedMsg = "（embedding 未配置，跳过重新嵌入）";
          }
          invalidateGraphCache();
          return {
            content: [{ type: "text", text: `节点 "${name}" 已更新${embedMsg}。` }],
            details: { success: true, node: updated },
          };
        },
      }),
      { name: "gm_edit_node" },
    );

    // ── gm_set_hot ───────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_set_hot",
        label: "Set Node as Hot",
        description: "将指定节点设置为 hot 节点。hot 节点在每次 assemble 时必定渲染，拥有最高优先级。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称，精确匹配" }),
        }),
        async execute(_toolCallId: string, params: { name: string }) {
          const { name } = params;
          const node = findByName(db, name);
          if (!node) {
            return { content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }], details: { success: false } };
          }
          // 追加 "hot"，不去除已有 flags
          if ((node.flags || []).includes("hot")) {
            return { content: [{ type: "text", text: `节点 "${name}" 已经是 hot 节点（flags: [${(node.flags || []).map((f: string) => `"${f}"`).join(", ")}]）。` }], details: { success: true, name, already: true } };
          }
          setNodeFlags(db, node.id, [...(node.flags || []), "hot"]);
          invalidateGraphCache();
          return {
            content: [{ type: "text", text: `节点 "${name}" 已追加 hot flag（原 flags: [${(node.flags || []).map((f: string) => `"${f}"`).join(", ")}]）。` }],
            details: { success: true, name },
          };
        },
      }),
      { name: "gm_set_hot" },
    );

    // ── gm_set_scope_hot ──────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_set_scope_hot",
        label: "Set Node as Scope Hot",
        description: "将指定节点设置为指定 scope 的 scope hot 节点。在对应 scope 的 session 中 assemble 时会优先渲染。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称，精确匹配" }),
          scope: Type.String({ description: "scope 名称，如 \"gm开发\" 或 \"飞书群oc_xxx\"" }),
        }),
        async execute(_toolCallId: string, params: { name: string; scope: string }) {
          const { name, scope } = params;
          const node = findByName(db, name);
          if (!node) {
            return { content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }], details: { success: false } };
          }
          const flag = `scope_hot:${scope}`;
          // 只对自己去重，保留其他 scope_hot 和 hot
          if ((node.flags || []).includes(flag)) {
            return { content: [{ type: "text", text: `节点 "${name}" 已经是 ${flag}（flags: [${(node.flags || []).map((f: string) => `"${f}"`).join(", ")}]）。` }], details: { success: true, name, already: true } };
          }
          setNodeFlags(db, node.id, [...(node.flags || []), flag]);
          invalidateGraphCache();
          return {
            content: [{ type: "text", text: `节点 "${name}" 已追加 ${flag}（原 flags: [${(node.flags || []).map((f: string) => `"${f}"`).join(", ")}]）。` }],
            details: { success: true, name, flag },
          };
        },
      }),
      { name: "gm_set_scope_hot" },
    );

    // ── gm_get_flags ──────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_get_flags",
        label: "Get Node Flags",
        description: "获取指定节点的所有 flags。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称，精确匹配" }),
        }),
        async execute(_toolCallId: string, params: { name: string }) {
          const { name } = params;
          const node = findByName(db, name);
          if (!node) {
            return { content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }], details: { success: false } };
          }
          const flags = node.flags || [];
          return {
            content: [{ type: "text", text: `节点 "${name}" 的 flags: ${flags.length ? flags.map((f: string) => `"${f}"`).join(", ") : "（无）"}` }],
            details: { success: true, name, flags },
          };
        },
      }),
      { name: "gm_get_flags" },
    );

    // ── gm_set_scope ──────────────────────────────────────────
    api.registerTool(
      (ctx: any) => ({
        name: "gm_set_scope",
        label: "Set Scope for Current Session",
        description: "为当前 session 绑定一个或多个 scope（覆盖式替换）。传入空数组 [] 可清除该 session 的所有 scope 绑定。设置后，当前 session 在 assemble 时会加载匹配这些 scope 的 scope_hot 节点。",
        parameters: Type.Object({
          scopes: Type.Array(Type.String(), { description: "scope 名称列表，如 [\"gm开发\", \"飞书群oc_xxx\"]。空数组 [] 表示清除所有 scope 绑定（覆盖式）。" }),
        }),
        async execute(_toolCallId: string, params: { scopes: string[] }) {
          const sid = ctx?.sessionKey ?? ctx?.sessionId ?? "manual";
          setScopesForSession(db, sid, params.scopes);
          const current = getScopesForSession(db, sid);
          const scopeText = current.length
            ? `当前 session 绑定的 scope：[${current.map(s => `"${s}"`).join(", ")}]`
            : "当前 session 没有任何 scope 绑定。";
          return {
            content: [{
              type: "text",
              text: `scope 绑定已更新。${scopeText}`,
            }],
            details: { sessionId: sid, scopes: current },
          };
        },
      }),
      { name: "gm_set_scope" },
    );

    // ── gm_get_scope ──────────────────────────────────────────
    api.registerTool(
      (ctx: any) => ({
        name: "gm_get_scope",
        label: "Get Scopes for Current Session",
        description: "获取当前 session 绑定的所有 scope。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const sid = ctx?.sessionKey ?? ctx?.sessionId ?? "manual";
          const scopes = getScopesForSession(db, sid);
          if (!scopes.length) {
            return {
              content: [{ type: "text", text: "当前 session 没有绑定任何 scope。" }],
              details: { sessionId: sid, scopes: [] },
            };
          }
          return {
            content: [{
              type: "text",
              text: `当前 session 绑定的 scope：[${scopes.map(s => `"${s}"`).join(", ")}]`,
            }],
            details: { sessionId: sid, scopes },
          };
        },
      }),
      { name: "gm_get_scope" },
    );

    // ── gm_list_scopes ────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_list_scopes",
        label: "List All Scopes",
        description: "列出当前所有 scope 及其绑定的 session 数量。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const scopes = listScopes(db);
          if (!scopes.length) {
            return {
              content: [{ type: "text", text: "当前没有任何 scope。" }],
              details: { scopes: [] },
            };
          }
          const lines = scopes.map(s => `  - "${s.scopeName}": ${s.sessionCount} 个 session`);
          return {
            content: [{
              type: "text",
              text: `当前共有 ${scopes.length} 个 scope：\n${lines.join("\n")}`,
            }],
            details: { scopes },
          };
        },
      }),
      { name: "gm_list_scopes" },
    );

    // ── gm_remove ─────────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_remove",
        label: "Remove Node from Graph Memory",
        description: "从知识图谱中删除指定节点（软删除，标记为 deprecated）。必须通过节点唯一名称（name）指定，一次只删一条。",
        parameters: Type.Object({
          name: Type.String({ description: "节点的唯一名称（name 字段），精确匹配" }),
          reason: Type.Optional(Type.String({ description: "删除原因（可选）" })),
        }),
        async execute(_toolCallId: string, params: { name: string; reason?: string }) {
          const { name, reason } = params;
          const node = findByName(db, name);
          if (!node) {
            return {
              content: [{ type: "text", text: `未找到名为 "${name}" 的节点，删除失败。` }],
              details: { success: false, name },
            };
          }
          if (node.status === "deprecated") {
            return {
              content: [{ type: "text", text: `节点 "${name}" 已经是 deprecated 状态，无需重复删除。` }],
              details: { success: false, name, alreadyDeprecated: true },
            };
          }
          // 软删除：标记 deprecated
          deprecate(db, node.id);
          // 顺手清理该节点的出边和入边（避免孤立边残留）
          db.prepare("DELETE FROM gm_edges WHERE from_id = ? OR to_id = ?").run(node.id, node.id);
          api.logger.info(`[graph-memory] removed node "${name}" (id=${node.id})${reason ? ` reason: ${reason}` : ""}`);
          return {
            content: [{
              type: "text",
              text: `已删除节点 "${name}"（类型: ${node.type}，原 status: ${node.status}）${
                reason ? `\n删除原因：${reason}` : ""
              }\n关联边也已清理。`,
            }],
            details: { success: true, nodeId: node.id, name, type: node.type },
          };
        },
      }),
      { name: "gm_remove" },
    );

    // ── gm_embedding ──────────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_embedding",
        label: "Re-embed Node in Graph Memory",
        description: "对指定节点重新计算语义嵌入向量并更新到数据库。force=true 时跳过 Hash 比对强制重新计算。通常用于节点内容更新后同步向量。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称，精确匹配" }),
          force: Type.Optional(Type.Boolean({ description: "强制重新计算向量，跳过 Hash 比对（默认 false）" })),
        }),
        async execute(_toolCallId: string, params: { name: string; force?: boolean }) {
          const { name, force = false } = params;
          const node = findByName(db, name);
          if (!node) {
            return {
              content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }],
              details: { success: false, name },
            };
          }
          if (!recaller.isEmbedReady()) {
            return {
              content: [{ type: "text", text: `Embedding 功能未就绪（未配置 embedding），无法重新嵌入节点 "${name}"。` }],
              details: { success: false, reason: "embed_not_ready" },
            };
          }
          await recaller.syncEmbed(node, force);
          return {
            content: [{
              type: "text",
              text: `节点 "${name}" 的嵌入向量已重新计算并更新（force=${force}）。`,
            }],
            details: { success: true, nodeId: node.id, name, force },
          };
        },
      }),
      { name: "gm_embedding" },
    );

    // ── gm_reembedding_all ─────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_reembedding_all",
        label: "Re-embed All Nodes in Graph Memory",
        description: "对所有 active 节点重新计算嵌入向量并更新到数据库。force=true 时跳过 Hash 比对强制重新计算所有节点。注意：节点数量多时耗时较长，需要二次确认。",
        parameters: Type.Object({
          confirm: Type.Boolean({ description: "必须传 true 才真正执行，传 false 或不传则只返回待处理数量" }),
          force: Type.Optional(Type.Boolean({ description: "强制重新计算所有节点向量，跳过 Hash 比对（默认 false）" })),
        }),
        async execute(_toolCallId: string, params: { confirm?: boolean; force?: boolean }) {
          const { confirm, force = false } = params;
          const allNodes = db.prepare(
            "SELECT id, name, type, content FROM gm_nodes WHERE status = 'active'"
          ).all() as any[];
          if (!allNodes.length) {
            return {
              content: [{ type: "text", text: "图谱中没有任何 active 节点。" }],
              details: { count: 0 },
            };
          }
          if (!confirm) {
            return {
              content: [{
                type: "text",
                text: `图谱中共有 ${allNodes.length} 个 active 节点待重新嵌入。\n传入 confirm: true 确认执行。`,
              }],
              details: { count: allNodes.length, confirmRequired: true },
            };
          }
          if (!recaller.isEmbedReady()) {
            return {
              content: [{ type: "text", text: `Embedding 功能未就绪，无法执行全量重新嵌入。` }],
              details: { success: false, reason: "embed_not_ready" },
            };
          }
          let updated = 0;
          let failed = 0;
          for (const row of allNodes) {
            try {
              await recaller.syncEmbed(row, force);
              updated++;
            } catch {
              failed++;
            }
          }
          const text = `全量重新嵌入完成：成功 ${updated} 个，失败 ${failed} 个（共 ${allNodes.length} 个节点，force=${force}）。`;
          api.logger.info(`[graph-memory] reembedding_all: ${updated} ok, ${failed} failed`);
          return {
            content: [{ type: "text", text }],
            details: { success: true, total: allNodes.length, updated, failed },
          };
        },
      }),
      { name: "gm_reembedding_all" },
    );

    // ── gm_induce_topics ──────────────────────────────────────
    api.registerTool(
      (_ctx: any) => ({
        name: "gm_induce_topics",
        label: "Induce Topics for a Node",
        description: "对指定节点执行主题归纳。以该节点为 sessionNode 传入 induceTopics，函数内部会跨会话 recall 相关节点，形成以该节点为核心的局部子图，然后 LLM 归纳出主题。适用于：以某个节点为中心探索关联主题、整理某个领域的知识结构。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称（精确匹配）" }),
        }),
        async execute(_toolCallId: string, params: { name: string }) {
          const { name } = params;

          // 根据节点名查找节点
          const node = findByName(db, name);
          if (!node) {
            return {
              content: [{ type: "text", text: `未找到名为 "${name}" 的节点。` }],
              details: { success: false, name },
            };
          }
          if (node.type === "TOPIC") {
            return {
              content: [{ type: "text", text: `"${name}" 已经是 TOPIC 类型节点，主题归纳只需对 semantic 节点执行。` }],
              details: { success: false, reason: "already_topic" },
            };
          }

          // 以该节点作为唯一的 sessionNode，induceTopics 内部会做 recall 召回相关节点
          try {
            const result = await induceTopics({
              db,
              sessionNodes: [node],
              llm,
              recaller,
            });

            if (result.createdTopics.length === 0 && result.updatedTopics.length === 0
                && result.semanticToTopicEdges.length === 0 && result.topicToTopicEdges.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: `节点 "${name}" 没有归纳出新的主题关系（可能现有主题已足够覆盖，或该节点语义较孤立）。`,
                }],
                details: {
                  success: true,
                  name,
                  nodeId: node.id,
                  ...result,
                },
              };
            }

            invalidateGraphCache();

            const lines = [
              `主题归纳完成（以 "${name}" 为核心）：`,
              result.createdTopics.length > 0
                ? `新建主题：${result.createdTopics.map(t => t.name).join(", ")}`
                : null,
              result.updatedTopics.length > 0
                ? `更新主题：${result.updatedTopics.map(t => t.name).join(", ")}`
                : null,
              result.semanticToTopicEdges.length > 0
                ? `新建归属边：${result.semanticToTopicEdges.length} 条`
                : null,
              result.topicToTopicEdges.length > 0
                ? `新建层级边：${result.topicToTopicEdges.length} 条`
                : null,
            ].filter(Boolean);

            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: {
                success: true,
                name,
                nodeId: node.id,
                ...result,
              },
            };
          } catch (err) {
            api.logger.error(`[graph-memory] gm_induce_topics failed: ${err}`);
            return {
              content: [{ type: "text", text: `主题归纳失败: ${String(err)}` }],
              details: { success: false, error: String(err) },
            };
          }
        },
      }),
      { name: "gm_induce_topics" },
    );

    // ── gm_explore ──────────────────────────────────────────
    // 把子图格式化成对 LLM 友好的文字描述
    function formatSubgraphForLLM(seeds: any[], subgraphs: any[]): string {
      const lines: string[] = [];

      for (const sg of subgraphs) {
        lines.push(`== 关联记忆 ==`);

        // 种子节点（锚点）
        const seed = seeds.find((s: any) => s.name === sg.seed);
        const lastAccessed = seed?.lastAccessedAt
          ? new Date(seed.lastAccessedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
          : "从未";
        lines.push(`【种子】${seed?.name || sg.seed}`);
        lines.push(`  类型: ${seed?.type || "?"} | 置信度: ${(seed?.belief ?? 0.5).toFixed(3)} | 访问: ${lastAccessed}`);
        if (seed?.description) lines.push(`  简介: ${seed.description}`);
        lines.push(`  内容: ${seed?.content || "(无)"}`);
        lines.push("");

        // 关联节点（排除种子自身）
        const relatedNodes = sg.nodes.filter((n: any) => n.id !== seed?.id && n.tier === "L1");

        for (const n of relatedNodes) {
          const lastAccessed = n.lastAccessedAt
            ? new Date(n.lastAccessedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
            : "从未";
          lines.push(`【关联】${n.name}`);
          lines.push(`  类型: ${n.type} | 置信度: ${(n.belief ?? 0.5).toFixed(3)} | 访问: ${lastAccessed}`);
          if (n.description) lines.push(`  简介: ${n.description}`);
          lines.push(`  内容: ${n.content || "(无)"}`);
          lines.push("");
        }

        if (sg.edges.length > 0) {
          lines.push(`--- 关联 (${sg.edges.length} 条) ---`);
          for (const e of sg.edges) {
            const fromName = e.fromName || e.fromId;
            const toName = e.toName || e.toId;
            const desc = e.description ? ` — ${e.description}` : "";
            lines.push(`  ${fromName} --[${e.name}]--> ${toName}${desc}`);
          }
          lines.push("");
        }
      }

      return lines.join("\n").trim();
    }

    function buildSubgraphResult(
      roots: any[],
      nodes: any[],
      edges: any[],
    ): { seeds: any[]; subgraphs: any[] } {
      // 只保留 L1 节点，排除 L2/L3/filtered
      const tieredNodes = nodes.filter((n: any) => n.tier === "L1");
      // 过滤出两端都在 tieredNodes 中的边
      const nodeIds = new Set(tieredNodes.map((n: any) => n.id));
      const filteredEdges = edges.filter(
        (e: any) => nodeIds.has(e.fromId) && nodeIds.has(e.toId),
      );

      // 返回所有 L1/L2/L3 节点（图孤立但语义相关的节点也需要被梦到）
      const allNodes = tieredNodes;
      const allNodeIds = new Set(allNodes.map((n: any) => n.id));
      // 边：只保留两端都在 allNodes 中的
      const subgraphEdges = filteredEdges.filter(
        (e: any) => allNodeIds.has(e.fromId) && allNodeIds.has(e.toId),
      );

      const subgraphs = roots.map((root: any) => {
        return { seed: root.name, nodes: allNodes, edges: subgraphEdges };
      });

      return {
        seeds: roots.map((r: any) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          description: r.description ?? "",
          content: r.content ?? "",
          lastAccessedAt: r.lastAccessedAt ?? 0,
          accessCount: r.accessCount ?? 0,
          combinedScore: r.combinedScore ?? 1.0, // 种子节点固定为1.0
        })),
        subgraphs,
      };
    }

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_explore",
        label: "Explore Subgraph from a Node",
        description:
          "从指定节点出发，召回其子图（语义邻居 + 关联节点）。与 gm_search 的区别是：gm_search 按关键词检索全局节点，gm_explore 从指定节点出发探索子图结构。适用于查看某个节点的关联知识网络。",
        parameters: Type.Object({
          nodeName: Type.String({ description: "节点名称，精确匹配（区分大小写）" }),
          maxNodes: Type.Optional(
            Type.Number({ description: "最大返回节点数（默认 45）" }),
          ),
        }),
        async execute(_toolCallId: string, params: { nodeName: string; maxNodes?: number }) {
          const { nodeName, maxNodes } = params;
          try {
            const result = await recaller.exploreSubgraph(nodeName, maxNodes);
            if (!result.roots.length) {
              return {
                content: [{ type: "text", text: `未找到名为 "${nodeName}" 的节点。` }],
                details: { success: false },
              };
            }
            if (!result.nodes.length) {
              return {
                content: [
                  {
                    type: "text",
                    text: `节点 "${nodeName}" 是孤立节点，没有关联子图。`,
                  },
                ],
                details: { success: true, isolated: true, seed: result.roots[0] },
              };
            }

            const { seeds, subgraphs } = buildSubgraphResult(
              result.roots,
              result.nodes,
              result.edges,
            );

            // 记录 L1 节点的访问（用于衰减引擎）
            const l1NodeIds = result.nodes
              .filter((n: any) => n.tier === "L1")
              .map((n: any) => n.id);
            if (l1NodeIds.length > 0) {
              recordNodeAccessBatch(db, l1NodeIds);
            }

            return {
              content: [
                {
                  type: "text",
                  text: formatSubgraphForLLM(seeds, subgraphs),
                },
              ],
              details: {
                success: true,
                seed: seeds[0],
                subgraphs,
              },
            };

          } catch (err) {
            api.logger.error(`[graph-memory] gm_explore failed: ${err}`);
            return {
              content: [{ type: "text", text: `gm_explore 失败: ${String(err)}` }],
              details: { success: false, error: String(err) },
            };
          }
        },
      }),
      { name: "gm_explore" },
    );

    // ── gm_dream ──────────────────────────────────────────────
    function exponentialDecayPick<T extends Record<string, unknown>>(
      candidates: T[],
      timeField: keyof T,
      lambda = 0.33,
    ): T | null {
      if (!candidates.length) return null;
      const now = Date.now();
      const MS_PER_DAY = 86_400_000;
      const withWeights = candidates.map(c => {
        const t = Number(c[timeField]) ?? 0;
        const days = Math.max(0, (now - t) / MS_PER_DAY);
        return { item: c, weight: Math.exp(-lambda * days) };
      });
      const totalWeight = withWeights.reduce((s, w) => s + w.weight, 0);
      if (totalWeight <= 0) return candidates[0];
      let r = Math.random() * totalWeight;
      for (const { item, weight } of withWeights) {
        r -= weight;
        if (r <= 0) return item;
      }
      return withWeights[withWeights.length - 1].item;
    }

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_dream",
        label: "Dream — Random Memory Exploration",
        description:
          "随机漫游记忆图谱。从最近召回的记忆池和最近新建的记忆池中按指数衰减概率各选取一个锚点（种子），从每个种子出发探索其子图，返回给 agent 进一步处理（合并、发现遗漏关系、处理冲突等）。无输入参数。日有所思夜有所梦，即随机又偏向近期记忆。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          try {
            const POOL_HOURS = 168; // 7 天
            const POOL_SIZE = 50;

            // 池A：最近召回的记忆（按 recall 时间衰减）
            const recalledPool = getRecentlyRecalledNodes(db, POOL_HOURS, POOL_SIZE);
            const recalledDedup = new Map<string, (typeof recalledPool)[0]>();
            for (const r of recalledPool) {
              if (!recalledDedup.has(r.nodeId)) recalledDedup.set(r.nodeId, r);
            }
            const recalledCandidates = Array.from(recalledDedup.values());

            // 池B：最近新建的记忆（按创建时间衰减）
            const createdPool = getRecentlyCreatedNodes(db, POOL_HOURS, POOL_SIZE);

            // 指数衰减选取锚点（lambda=0.33，半衰期约 2.1 天，倾向于最近 3 天的记忆）
            const seedFromRecalled = exponentialDecayPick(
              recalledCandidates,
              "recalledAt" as keyof (typeof recalledCandidates)[0],
              0.33,
            );
            const seedFromCreated = exponentialDecayPick(
              createdPool,
              "createdAt" as keyof (typeof createdPool)[0],
              0.33,
            );

            if (!seedFromRecalled && !seedFromCreated) {
              return {
                content: [
                  { type: "text", text: "记忆池为空（7 天内没有召回或创建的节点），无法做梦。" },
                ],
                details: { success: false, reason: "empty_pools" },
              };
            }

            const subgraphs: Array<{ seed: string; nodes: any[]; edges: any[] }> = [];
            const allSeeds: any[] = [];

            if (seedFromRecalled) {
              const result = await recaller.exploreSubgraph(seedFromRecalled.nodeId);
              if (result.roots.length && result.nodes.length) {
                const { seeds, subgraphs: sg } = buildSubgraphResult(
                  result.roots,
                  result.nodes,
                  result.edges,
                );
                allSeeds.push(...seeds);
                subgraphs.push(...sg);
              }
            }

            if (seedFromCreated) {
              const alreadySeedNames = new Set(allSeeds.map((r: any) => r.name));
              if (!alreadySeedNames.has(seedFromCreated.name)) {
                const result = await recaller.exploreSubgraph(seedFromCreated.id);
                if (result.roots.length && result.nodes.length) {
                  const { seeds, subgraphs: sg } = buildSubgraphResult(
                    result.roots,
                    result.nodes,
                    result.edges,
                  );
                  allSeeds.push(...seeds);
                  subgraphs.push(...sg);
                }
              }
            }

            if (!subgraphs.length) {
              return {
                content: [
                  { type: "text", text: "做梦完成，但没有找到可用的子图（锚点可能是孤立节点）。" },
                ],
                details: { success: true, seeds: allSeeds, subgraphs: [] },
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: formatSubgraphForLLM(allSeeds, subgraphs),
                },
              ],
              details: { success: true, seeds: allSeeds, subgraphs },
            };
          } catch (err) {
            api.logger.error(`[graph-memory] gm_dream failed: ${err}`);
            return {
              content: [{ type: "text", text: `gm_dream 失败: ${String(err)}` }],
              details: { success: false, error: String(err) },
            };
          }
        },
      }),
      { name: "gm_dream" },
    );
  },
};

// ─── 取最近 N 轮用户交互（保留多步任务上下文） ──────────────

function estimateMsgTokens(msg: any): number {
  const text = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content ?? "");
  return Math.ceil(text.length / 3);
}

const DEFAULT_KEEP_TURNS = 5;  // assemble 阶段保留最近 5 轮
const RECALL_KEEP_TURNS = 2;   // recall 阶段只取最近 2 轮

/**
 * 提取 assistant 消息中的纯文本内容，去掉 tool_use/thinking 等 schema
 */
function extractAssistantText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

/**
 * 提取 user 消息的纯文本内容
 * 去掉 OpenClaw 包装的 metadata（Sender JSON block、命令前缀、时间戳等）
 */
function extractUserText(msg: any): string {
  let raw: string;
  if (typeof msg.content === "string") {
    raw = msg.content;
  } else if (!Array.isArray(msg.content)) {
    raw = String(msg.content ?? "");
  } else {
    raw = msg.content
      .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }

  // 去掉 OpenClaw metadata: "Sender (untrusted metadata):\n```json\n{...}\n```\n实际内容"
  // 策略：找最后一个 ``` 闭合后的内容，如果没有 ``` 就用 cleanPrompt 兜底
  const fenceEnd = raw.lastIndexOf("```");
  if (fenceEnd >= 0 && raw.includes("Sender")) {
    raw = raw.slice(fenceEnd + 3).trim();
  }

  // 兜底：去掉命令前缀、时间戳标记等
  raw = raw.replace(/^\/\w+\s+/, "").trim();
  raw = raw.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();

  return raw;
}

/**
 * 截取最近 N 轮对话。
 * - lastTurnUserIdx 之前的所有轮次：只保留 user 纯文本 + assistant 纯文本
 * - lastTurnUserIdx 起始的最后一轮：完整保留（含 toolResult）
 *
 * @param messages  完整消息数组
 * @param keepTurns 保留最近几轮（默认 5，供 assemble 使用）
 */
function sliceLastTurn(
  messages: any[],
  keepTurns: number = DEFAULT_KEEP_TURNS,
): { messages: any[]; tokens: number; dropped: number } {
  if (!messages.length) {
    return { messages: [], tokens: 0, dropped: 0 };
  }

  // ── 找到最近 N 个 user 消息的位置 ────────────────────
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length >= keepTurns) break;
    }
  }
  if (!userIndices.length) {
    return { messages: [], tokens: 0, dropped: messages.length };
  }

  // userIndices 是倒序的：[最新user, ..., 最早user]
  // 最后一轮的 user 位置
  const lastTurnUserIdx = userIndices[0];

  // ── 最后 1 轮：完整保留（含 toolResult，Agent 需要最新执行结果）──
  let lastTurnMsgs = messages.slice(lastTurnUserIdx);
  const lastTurnTotal = lastTurnMsgs.length;

  // 截断超长 tool_result
  const TOOL_MAX = 6000;
  lastTurnMsgs = lastTurnMsgs.map((msg: any) => {
    if (msg.role !== "tool" && msg.role !== "toolResult") return msg;
    if (typeof msg.content !== "string") return msg;
    if (msg.content.length <= TOOL_MAX) return msg;
    const head = Math.floor(TOOL_MAX * 0.6);
    const tail = Math.floor(TOOL_MAX * 0.3);
    return { ...msg, content: msg.content.slice(0, head) + `\n...[truncated ${msg.content.length - head - tail} chars]...\n` + msg.content.slice(-tail) };
  });

  // ── 前 N-1 轮：只保留 user 输入 + assistant 文本（去掉 tool schema）──
  const prevTurnMsgs: any[] = [];
  let prevOriginalCount = 0;

  if (userIndices.length > 1) {
    // 从最早的 user 到最后一轮 user 之前
    const earliestIdx = userIndices[userIndices.length - 1];
    prevOriginalCount = lastTurnUserIdx - earliestIdx;

    for (let i = earliestIdx; i < lastTurnUserIdx; i++) {
      const msg = messages[i];
      if (!msg) continue;

      if (msg.role === "user") {
        const text = extractUserText(msg);
        if (text) {
          prevTurnMsgs.push({ role: "user", content: text });
        }
      } else if (msg.role === "assistant") {
        const text = extractAssistantText(msg);
        if (text) {
          prevTurnMsgs.push({ role: "assistant", content: text });
        }
      }
      // toolResult / tool_use / thinking 等全部跳过
    }
  }

  // ── 合并：前 N-1 轮摘要 + 最后 1 轮完整 ────────────────
  const kept = [...prevTurnMsgs, ...lastTurnMsgs];
  const dropped = messages.length - kept.length;

  let tokens = 0;
  for (const msg of kept) tokens += estimateMsgTokens(msg);

  return { messages: kept, tokens, dropped };
}

export default graphMemoryPlugin;
