import { describe, it, expect, vi } from "vitest";
import type { TieredNode } from "../src/recaller/recall.ts";

// ── 引用 index.ts 中尚未 export 的 parallelRecall（临时方案：内联复制测试）─────────
/** 临时复制的 parallelRecall（与 index.ts 同步修改，验证通过后替换） */
async function parallelRecall(
  recaller: any,
  historyQuery: string,
  promptQuery: string,
): Promise<{ nodes: TieredNode[]; edges: any[]; pprScores: Record<string, number> }> {
  const tierPriority = (tier: string): number => {
    const p: Record<string, number> = { scope_hot: 6, hot: 5, active: 4, L1: 3, L2: 2, L3: 1, filtered: 0 };
    return p[tier] ?? 0;
  };

  const [historyRes, promptRes] = await Promise.all([
    recaller.recallV2(historyQuery),
    recaller.recallV2(promptQuery),
  ]);

  // 节点去重（按 name，保留更高 tier）
  const nodesMap = new Map<string, TieredNode>();
  for (const n of [...historyRes.nodes, ...promptRes.nodes]) {
    const existing = nodesMap.get(n.name);
    if (!existing || tierPriority(n.tier) > tierPriority(existing.tier)) {
      nodesMap.set(n.name, n);
    }
  }

  // 边去重（按 from+to+name）
  const edgesSet = new Set<string>();
  const mergedEdges: any[] = [];
  for (const e of [...historyRes.edges, ...promptRes.edges]) {
    const key = `${e.from}-${e.to}-${e.name}`;
    if (!edgesSet.has(key)) {
      edgesSet.add(key);
      mergedEdges.push(e);
    }
  }

  // 合并 pprScores（取更高值）
  const pprScores: Record<string, number> = { ...historyRes.pprScores };
  for (const [k, v] of Object.entries(promptRes.pprScores ?? {})) {
    if (!pprScores[k] || v > pprScores[k]) pprScores[k] = v;
  }

  return { nodes: Array.from(nodesMap.values()), edges: mergedEdges, pprScores };
}

describe("parallelRecall 去重合并", () => {
  // ── Mock recaller ───────────────────────────────────────────────
  function mockRecaller(historyNodes: TieredNode[], promptNodes: TieredNode[], historyEdges: any[] = [], promptEdges: any[] = []) {
    const histEdges = historyEdges.length ? historyEdges : [];
    const promEdges = promptEdges.length ? promptEdges : [];
    return {
      recallV2: vi.fn().mockImplementation(async (query: string) => {
        if (query === "history") return { nodes: historyNodes, edges: histEdges, pprScores: {} };
        if (query === "prompt") return { nodes: promptNodes, edges: promEdges, pprScores: {} };
        return { nodes: [], edges: [], pprScores: {} };
      }),
    };
  }

  function node(name: string, tier: string = "L1"): TieredNode {
    return { id: name, name, type: "KNOWLEDGE" as any, tier: tier as any, content: "", description: "", confidence: 0.5, updated: "" };
  }

  function edge(from: string, to: string, name: string = "使用"): any {
    return { from, to, name, fromId: from, toId: to };
  }

  // ── 测试用例 ───────────────────────────────────────────────────
  it("两次召回结果合并，节点去重（同名保留更高 tier）", async () => {
    const recaller = mockRecaller(
      [node("test-node", "L2")],  // history: L2
      [node("test-node", "L1")],  // prompt: L1（更高）
      [],
      [],
    );
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].tier).toBe("L1"); // 取更高 tier
  });

  it("两次召回均有同一节点，prompt 返回的 tier 更高", async () => {
    const recaller = mockRecaller(
      [node("same-node", "L3")],
      [node("same-node", "scope_hot")],
      [],
      [],
    );
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].tier).toBe("scope_hot");
  });

  it("两次召回无重复，节点数相加", async () => {
    const recaller = mockRecaller(
      [node("node-a", "L1"), node("node-b", "L2")],
      [node("node-c", "L3")],
      [],
      [],
    );
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.nodes).toHaveLength(3);
    const names = result.nodes.map(n => n.name).sort();
    expect(names).toEqual(["node-a", "node-b", "node-c"]);
  });

  it("边去重：相同 from-to-name 只保留一条", async () => {
    const recaller = mockRecaller(
      [],
      [],
      [edge("A", "B", "使用"), edge("A", "B", "使用")], // 重复边
      [edge("A", "B", "使用")],
    );
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.edges).toHaveLength(1);
  });

  it("不同类型的边都保留", async () => {
    const recaller = mockRecaller([], [], [edge("A", "B", "使用")], [edge("A", "C", "依赖")]);
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.edges).toHaveLength(2);
  });

  it("pprScores 取较高值", async () => {
    let histEdges: any[] = [];
    let promEdges: any[] = [];
    const recaller = {
      recallV2: vi.fn().mockImplementation(async (q: string) => {
        if (q === "history") return { nodes: [node("n1", "L2")], edges: histEdges, pprScores: { n1: 0.3 } };
        return { nodes: [node("n1", "L1")], edges: promEdges, pprScores: { n1: 0.8 } }; // prompt 分数更高
      }),
    };
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.pprScores["n1"]).toBe(0.8); // 取更高
  });

  it("history 无结果时也能正常工作", async () => {
    const recaller = mockRecaller([], [node("only-prompt")], [], []);
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("only-prompt");
  });

  it("prompt 无结果时也能正常工作", async () => {
    const recaller = mockRecaller([node("only-history")], [], [], []);
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("only-history");
  });

  it("active / hot / scope_hot 节点优先级高于 L 系列", async () => {
    const recaller = mockRecaller(
      [node("mixed", "L1")],
      [node("mixed", "active")],
      [],
      [],
    );
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.nodes[0].tier).toBe("active"); // active > L1
  });

  it("hot 节点优先级高于 active", async () => {
    const recaller = mockRecaller(
      [node("mixed", "active")],
      [node("mixed", "hot")],
      [],
      [],
    );
    const result = await parallelRecall(recaller, "history", "prompt");
    expect(result.nodes[0].tier).toBe("hot");
  });
});
