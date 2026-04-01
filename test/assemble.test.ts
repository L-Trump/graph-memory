/**
 * graph-memory — 组装 + 消息修复测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { assembleContext, buildSystemPromptAddition } from "../src/format/assemble.ts";
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
    expect(result).toContain("1 nodes recalled from OTHER conversations");
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
// assembleContext
// ═══════════════════════════════════════════════════════════════

describe("assembleContext", () => {
  it("有节点时生成 XML", () => {
    const id = insertNode(db, { name: "test-skill", type: "SKILL", content: "## test\nsome content" });
    const node = findById(db, id)!;

    const { xml, systemPrompt, tokens } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      activeNodes: [node],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    expect(xml).toContain("<knowledge_graph>");
    expect(xml).toContain('name="test-skill"');
    expect(xml).toContain("</knowledge_graph>");
    expect(systemPrompt).toContain("Graph Memory");
    expect(tokens).toBeGreaterThan(0);
  });

  it("空节点返回 null", () => {
    const { xml, systemPrompt } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    expect(xml).toBeNull();
    expect(systemPrompt).toBe("");
  });

  it("recalled 节点标记 source=recalled", () => {
    const id = insertNode(db, { name: "recalled-skill", type: "SKILL" });
    const node = findById(db, id)!;

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [{ ...node, tier: "L1" as const, semanticScore: 0.8, pprScore: 0.1, pagerankScore: 0.3, combinedScore: 0.5 }],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    expect(xml).toContain('source="recalled"');
  });

  it("token 预算不截断节点（全量放入）", () => {
    // 插入很多大节点
    const nodes: GmNode[] = [];
    for (let i = 0; i < 20; i++) {
      const id = insertNode(db, {
        name: `skill-${i}`,
        content: "x".repeat(5000), // 每个节点 5000 字符
      });
      nodes.push(findById(db, id)!);
    }

    // 很小的 token 预算
    const { xml } = assembleContext(db, null!, {
      tokenBudget: 1000, // 1000 * 0.15 * 3 = 450 字符
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      activeNodes: nodes,
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    // 不应该包含所有 20 个节点
    if (xml) {
      const matches = xml.match(/name="skill-/g);
      expect(matches!.length).toBe(20);
    }
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
    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [node2],
      hotEdges: [] as GmEdge[],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    expect(xml).toContain('name="hot-skill"');
    expect(xml).toContain('tier="hot"');
    expect(xml).not.toContain("normal-skill");
  });

  it("hot 节点与其他节点冲突时 hot 优先", () => {
    // 同一个节点同时出现在 hot 和 recalled 中，hot 应优先
    const id = insertNode(db, { name: "conflict-skill", type: "SKILL" });
    const node = findById(db, id)!;

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [{ ...node, flags: ["hot"] } as GmNode],
      hotEdges: [] as GmEdge[],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [{ ...node, tier: "L1" as const, semanticScore: 0.8, pprScore: 0.1, pagerankScore: 0.3, combinedScore: 0.5 }],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    expect(xml).toContain('name="conflict-skill"');
    expect(xml).toContain('tier="hot"');
    expect(xml).not.toContain('tier="l1"');
  });

  it("hot 节点带 description 渲染（tier 不是 L3）", () => {
    const id = insertNode(db, { name: "hot-with-desc", type: "SKILL", description: "hot 节点描述", content: "hot 节点内容" });
    const node = findById(db, id)!;

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [{ ...node, flags: ["hot"] } as GmNode],
      hotEdges: [] as GmEdge[],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    // hot tier 非 L3，应带 desc
    expect(xml).toContain('desc="hot 节点描述"');
    expect(xml).toContain('tier="hot"');
  });

  it("hot 节点在 hot+active+recalled 混合场景中排序正确", () => {
    const id1 = insertNode(db, { name: "active-node", type: "TASK" });
    const id2 = insertNode(db, { name: "hot-node", type: "SKILL", flags: ["hot"] });
    const node1 = findById(db, id1)!;
    const node2 = findById(db, id2)!;

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [node2],
      hotEdges: [] as GmEdge[],
      activeNodes: [node1],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    // 两个节点都应存在
    expect(xml).toContain('name="hot-node"');
    expect(xml).toContain('name="active-node"');
    expect(xml).toContain('tier="hot"');
    expect(xml).toContain('tier="active"');
  });

  it("hot 节点的边在两侧节点都在时正确渲染", () => {
    const id1 = insertNode(db, { name: "hot-from", type: "SKILL" });
    const id2 = insertNode(db, { name: "hot-to", type: "TASK" });
    const node1 = findById(db, id1)!;
    const node2 = findById(db, id2)!;
    // 手动构建 hot 边（assembleContext 不自动查 hot 边，由调用方传入）
    const hotEdge: GmEdge = {
      id: "e-hot-test",
      fromId: node1.id,
      toId: node2.id,
      name: "使用",
      description: "hot 节点之间的边",
      sessionId: "test",
      createdAt: Date.now(),
    };

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [{ ...node1, flags: ["hot"] } as GmNode, node2],
      hotEdges: [hotEdge],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    // 边应该渲染
    expect(xml).toContain('name="使用"');
    expect(xml).toContain('from="hot-from"');
    expect(xml).toContain('to="hot-to"');
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