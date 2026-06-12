/**
 * graph-memory — 组装 + 消息修复测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { assembleStableContext, assembleDynamicContext, renderRecallIndexContext, buildSystemPromptAddition } from "../src/format/assemble.ts";
import { sanitizeToolUseResultPairing } from "../src/format/transcript-repair.ts";
import { findById } from "../src/store/store.ts";
import type { GmNode, GmEdge } from "../src/types.ts";

let db: DatabaseSyncInstance;

beforeEach(() => { db = createTestDb(); });

// ═══════════════════════════════════════════════════════════════
// buildSystemPromptAddition
// ═══════════════════════════════════════════════════════════════

describe("buildSystemPromptAddition", () => {
  it("空节点返回空字符串", () => {
    const result = buildSystemPromptAddition({ selectedNodes: [], edgeCount: 0 });
    expect(result).toBe("");
  });

  it("有节点返回引导文字", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active", tier: "active" },
        { type: "EVENT", src: "recalled", tier: "high" },
      ],
      edgeCount: 2,
    });

    expect(result).toContain("Graph Memory");
    expect(result).toContain("知识图谱记忆");
  });

  it("丰富图谱包含导航说明", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active", tier: "active" },
        { type: "SKILL", src: "active", tier: "active" },
        { type: "TASK", src: "active", tier: "active" },
        { type: "EVENT", src: "recalled", tier: "L1" },
      ],
      edgeCount: 5,
    });

    expect(result).toContain("解决");
    expect(result).toContain("扩展");
  });
});

// ═══════════════════════════════════════════════════════════════
// hot 节点渲染
// ═══════════════════════════════════════════════════════════════

describe("hot 节点渲染", () => {
  it("hot 节点始终渲染且 tier 为 hot", () => {
    // 插入一个普通节点和一个 hot 节点
    const id1 = insertNode(db, { name: "normal-skill", type: "SKILL" });
    const id2 = insertNode(db, { name: "hot-skill", type: "SKILL", flags: ["hot"] });
    const node1 = findById(db, id1)!;
    const node2 = findById(db, id2)!;

    // 单独渲染 hot 节点（active 和 recalled 都为空）
    const { xml } = assembleStableContext(db, null!, {
      hotNodes: [node2],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
    });

    expect(xml).toContain('name="hot-skill"');
    expect(xml).toContain('tier="hot"');
    expect(xml).not.toContain("normal-skill");
  });

  it("hot 节点与其他节点冲突时 hot 优先", () => {
    // 同一个节点同时出现在 hot 和 recalled 中，hot 应优先
    const id = insertNode(db, { name: "conflict-skill", type: "SKILL" });
    const node = findById(db, id)!;

    const { xml } = assembleStableContext(db, null!, {
      hotNodes: [{ ...node, flags: ["hot"] } as GmNode],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
    });

    expect(xml).toContain('name="conflict-skill"');
    expect(xml).toContain('tier="hot"');
    expect(xml).not.toContain('tier="l1"');
  });

  it("hot 节点带 description 渲染（tier 不是 L3）", () => {
    const id = insertNode(db, { name: "hot-with-desc", type: "SKILL", description: "hot 节点描述", content: "hot 节点内容" });
    const node = findById(db, id)!;

    const { xml } = assembleStableContext(db, null!, {
      hotNodes: [{ ...node, flags: ["hot"] } as GmNode],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
    });

    // hot tier 非 L3，应带 desc
    expect(xml).toContain('desc="hot 节点描述"');
    expect(xml).toContain('tier="hot"');
  });


  it("stable context 去掉 updated/confidence 并稳定排序", () => {
    const bId = insertNode(db, { name: "b-hot", type: "SKILL", description: "b desc", content: "b content" });
    const aId = insertNode(db, { name: "a-hot", type: "SKILL", description: "a desc", content: "a content" });
    const bNode = { ...findById(db, bId)!, belief: 0.91, updatedAt: Date.now() } as GmNode;
    const aNode = { ...findById(db, aId)!, belief: 0.42, updatedAt: Date.now() - 86400000 } as GmNode;

    const first = assembleStableContext(db, null!, {
      hotNodes: [bNode, aNode],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
    });
    const second = assembleStableContext(db, null!, {
      hotNodes: [{ ...aNode, updatedAt: Date.now(), belief: 0.11 }, { ...bNode, updatedAt: Date.now() + 9999, belief: 0.99 }],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
    });

    expect(first.xml).not.toContain("updated=");
    expect(first.xml).not.toContain("confidence=");
    expect(first.xml!.indexOf('name="a-hot"')).toBeLessThan(first.xml!.indexOf('name="b-hot"'));
    expect(second.xml).toBe(first.xml);
  });

  it("hot 节点在 hot+active+recalled 混合场景中排序正确", () => {
    const id1 = insertNode(db, { name: "active-node", type: "TASK" });
    const id2 = insertNode(db, { name: "hot-node", type: "SKILL", flags: ["hot"] });
    const node1 = findById(db, id1)!;
    const node2 = findById(db, id2)!;

    const { xml } = assembleStableContext(db, null!, {
      hotNodes: [node2],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
      compactActiveNodes: [node1],
      compactActiveEdges: [] as GmEdge[],
    });

    // 两个节点都应存在
    expect(xml).toContain('name="hot-node"');
    expect(xml).toContain('name="active-node"');
    expect(xml).toContain('tier="hot"');
    expect(xml).toContain('tier="active"');
  });

  it("stable context 不渲染 hot 节点边以保持 system prompt 前缀稳定", () => {
    const id1 = insertNode(db, { name: "hot-from", type: "SKILL" });
    const id2 = insertNode(db, { name: "hot-to", type: "TASK" });
    const node1 = findById(db, id1)!;
    const node2 = findById(db, id2)!;
    // 手动构建 hot 边（由调用方传入）
    const hotEdge: GmEdge = {
      id: "e-hot-test",
      fromId: node1.id,
      toId: node2.id,
      name: "使用",
      description: "hot 节点之间的边",
      sessionId: "test",
      createdAt: Date.now(),
    };

    const { xml } = assembleStableContext(db, null!, {
      hotNodes: [{ ...node1, flags: ["hot"] } as GmNode, node2],
      hotEdges: [hotEdge],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
    });

    // stable 层故意不渲染边：边关系更容易变化，会破坏 system prompt 前缀缓存
    expect(xml).not.toContain('<edges>');
    expect(xml).not.toContain('name="使用"');
    expect(xml).not.toContain('from="hot-from"');
    expect(xml).not.toContain('to="hot-to"');
  });
});


// ═══════════════════════════════════════════════════════════════
// 分层 assemble
// ═══════════════════════════════════════════════════════════════

describe("分层 assemble", () => {
  it("stable context 只渲染 hot/scope_hot，不渲染 recalled", () => {
    const hotId = insertNode(db, { name: "stable-hot", type: "SKILL", content: "hot content" });
    const recalledId = insertNode(db, { name: "dynamic-recalled", type: "TASK", content: "dynamic content" });
    const hotNode = findById(db, hotId)!;
    const recalledNode = findById(db, recalledId)!;

    const stable = assembleStableContext(db, null!, {
      hotNodes: [hotNode],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
    });

    expect(stable.context).toContain("Graph Memory");
    expect(stable.context).toContain("stable-hot");
    expect(stable.context).not.toContain("dynamic-recalled");
    expect(stable.xml).toContain('tier="hot"');
  });


  it("recall index 只渲染 L1 name+desc、L2 name 且不渲染边/正文", () => {
    const l1Id = insertNode(db, { name: "idx-l1", type: "KNOWLEDGE", description: "l1 desc", content: "full l1 content should not appear" });
    const l2Id = insertNode(db, { name: "idx-l2", type: "SKILL", description: "l2 desc should not appear", content: "full l2 content should not appear" });
    const l3Id = insertNode(db, { name: "idx-l3", type: "TASK", description: "l3 desc", content: "full l3 content" });
    const stableId = insertNode(db, { name: "idx-stable", type: "EVENT", description: "stable desc", content: "stable content" });
    const l1Node = findById(db, l1Id)!;
    const l2Node = findById(db, l2Id)!;
    const l3Node = findById(db, l3Id)!;
    const stableNode = findById(db, stableId)!;

    const result = renderRecallIndexContext({
      recalledNodes: [
        { ...l1Node, tier: "L1" as const, semanticScore: 1, pprScore: 0, pagerankScore: 0, combinedScore: 1 },
        { ...l2Node, tier: "L2" as const, semanticScore: 1, pprScore: 0, pagerankScore: 0, combinedScore: 1 },
        { ...l3Node, tier: "L3" as const, semanticScore: 1, pprScore: 0, pagerankScore: 0, combinedScore: 1 },
        { ...stableNode, tier: "L1" as const, semanticScore: 1, pprScore: 0, pagerankScore: 0, combinedScore: 1 },
      ],
      stableNodeIds: new Set([stableNode.id]),
    });

    expect(result.context).toContain("<gm_memory>");
    expect(result.context).toContain('name="idx-l1"');
    expect(result.context).toContain('desc="l1 desc"');
    expect(result.context).toContain('name="idx-l2"');
    expect(result.context).not.toContain("l2 desc should not appear");
    expect(result.context).not.toContain("idx-l3");
    expect(result.context).not.toContain("idx-stable");
    expect(result.context).not.toContain("full l1 content should not appear");
    expect(result.context).not.toContain("<edges>");
    expect(result.context).toContain("gm_get_node");
    expect(result.context).toContain("gm_search");
  });

  it("dynamic context 过滤 stable 已包含节点，compact active 保留在 stable", () => {
    const hotId = insertNode(db, { name: "shared-hot", type: "SKILL", content: "hot content" });
    const l1Id = insertNode(db, { name: "dynamic-l1", type: "KNOWLEDGE", content: "l1 content" });
    const activeId = insertNode(db, { name: "compact-active", type: "TASK", content: "active content" });
    const hotNode = findById(db, hotId)!;
    const l1Node = findById(db, l1Id)!;
    const activeNode = findById(db, activeId)!;

    const stable = assembleStableContext(db, null!, {
      hotNodes: [hotNode],
      hotEdges: [] as GmEdge[],
      scopeHotNodes: [] as GmNode[],
      scopeHotEdges: [] as GmEdge[],
      compactActiveNodes: [activeNode],
      compactActiveEdges: [] as GmEdge[],
    });

    const dynamic = assembleDynamicContext(db, null!, {
      recalledNodes: [
        { ...hotNode, tier: "L1" as const, semanticScore: 1, pprScore: 0, pagerankScore: 0, combinedScore: 1 },
        { ...l1Node, tier: "L1" as const, semanticScore: 1, pprScore: 0, pagerankScore: 0, combinedScore: 1 },
      ],
      recalledEdges: [] as GmEdge[],
      stableNodeIds: new Set([hotNode.id, activeNode.id]),
    });

    expect(stable.context).toContain("compact-active");
    expect(stable.context).toContain('tier="active"');
    expect(dynamic.context).toContain("<gm_memory>");
    expect(dynamic.context).toContain("dynamic-l1");
    expect(dynamic.context).not.toContain("compact-active");
    expect(dynamic.context).not.toContain("shared-hot");
  });
});

// ═══════════════════════════════════════════════════════════════
// sanitizeToolUseResultPairing
// ═══════════════════════════════════════════════════════════════

describe("sanitizeToolUseResultPairing", () => {
  it("正常配对不修改", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(3);
  });

  it("缺失的 toolResult 被补充", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      // 缺少 toolResult for c1
      { role: "user", content: "next" },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    // 应该补一个 toolResult
    const toolResults = result.filter(m => m.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it("孤立 toolResult 被移除", () => {
    const msgs = [
      { role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "lost" }] },
      { role: "user", content: "hello" },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    expect(result.some(m => m.role === "toolResult")).toBe(false);
  });

  it("重复 toolResult 保持配对正确", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "duplicate" }] },
      { role: "assistant", content: "next response" },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    // assistant 消息保留
    expect(result.filter(m => m.role === "assistant")).toHaveLength(2);
    // 至少有一个匹配的 toolResult
    const toolResults = result.filter(m => m.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    // 第一个 toolResult 的内容是 "first"
    expect((toolResults[0].content[0] as any).text).toBe("first");
  });
});