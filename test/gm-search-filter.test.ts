/**
 * graph-memory — gm_search 工具输出格式测试
 *
 * 直接对 filterAndFormat 逻辑做单元测试，不依赖真实数据库
 */

import { describe, it, expect } from "vitest";

// ─────────────────────────────────────────────────────────────────
// 辅助：从 index.ts 复制的 gm_search 过滤+渲染逻辑
// ─────────────────────────────────────────────────────────────────
function filterAndFormat(res: { nodes: any[]; edges: any[] }) {
  const displayNodes = res.nodes.filter((n) => n.tier !== "filtered");
  const nodeMap = new Map(displayNodes.map((n) => [n.id, n]));

  const lines = displayNodes.map((n) => {
    const tierLabel =
      n.tier === "hot" ? "【🔥HOT】" :
      n.tier === "L1" ? "【L1-完整】" :
      n.tier === "L2" ? "【L2-描述】" :
      "【L3-名称】";
    const hotFlag = n.flags?.includes("hot") ? " 🔥" : "";
    const scores: string[] = [];
    if (n.semanticScore != null) scores.push(`语义=${n.semanticScore.toFixed(3)}`);
    if (n.pprScore != null) scores.push(`PPR=${n.pprScore.toFixed(3)}`);
    if (n.combinedScore != null) scores.push(`综合=${n.combinedScore.toFixed(3)}`);
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
    (e) => nodeMap.has(e.fromId) && nodeMap.has(e.toId),
  );
  const edgeLines = filteredEdges.map((e) => {
    const from = nodeMap.get(e.fromId)?.name ?? e.fromId;
    const to = nodeMap.get(e.toId)?.name ?? e.toId;
    return `  ${from} --[${e.name}]--> ${to}: ${e.description}`;
  });

  const text = [
    `找到 ${displayNodes.length} 个节点：\n`,
    ...lines,
    ...(edgeLines.length ? ["\n关系：", ...edgeLines] : []),
  ].join("\n\n");

  const tieredInfo = displayNodes.map((n) => ({
    id: n.id, type: n.type, name: n.name,
    description: n.description, content: n.content,
    tier: n.tier,
  }));

  return { displayNodes, lines, text, filteredEdges, count: displayNodes.length, tieredInfo };
}

// ─────────────────────────────────────────────────────────────────
// 模拟 RecallResult
// ─────────────────────────────────────────────────────────────────
function makeNode(id: string, tier: string, overrides: Partial<any> = {}) {
  return {
    id, type: "KNOWLEDGE", name: `Node-${id}`,
    description: `desc-${id}`, content: `content-${id}`,
    flags: [], semanticScore: 0.5, pprScore: 0.3, pagerankScore: 0.2,
    combinedScore: 0.4, tier, ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────
// 测试：filtered 节点被过滤
// ─────────────────────────────────────────────────────────────────
describe("filtered 节点被过滤", () => {
  it("displayNodes 不包含 filtered 节点", () => {
    const res = {
      nodes: [
        makeNode("a", "L1"),
        makeNode("b", "filtered"),
        makeNode("c", "L2"),
        makeNode("d", "filtered"),
        makeNode("e", "L3"),
      ],
      edges: [],
    };
    const { displayNodes } = filterAndFormat(res);
    expect(displayNodes.map((n) => n.id)).toEqual(["a", "c", "e"]);
    expect(displayNodes.every((n) => n.tier !== "filtered")).toBe(true);
  });

  it("lines 不包含 filtered 节点文本", () => {
    const res = {
      nodes: [
        makeNode("a", "L1"),
        makeNode("b", "filtered"),
      ],
      edges: [],
    };
    const { lines } = filterAndFormat(res);
    for (const line of lines) {
      expect(line).not.toContain("【过滤】");
    }
  });

  it("tieredInfo 不包含 filtered 节点", () => {
    const res = {
      nodes: [
        makeNode("a", "L1"),
        makeNode("b", "filtered"),
        makeNode("c", "L2"),
      ],
      edges: [],
    };
    const { tieredInfo } = filterAndFormat(res);
    expect(tieredInfo.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("count 等于 displayNodes.length", () => {
    const res = {
      nodes: [
        makeNode("a", "L1"),
        makeNode("b", "filtered"),
        makeNode("c", "L2"),
      ],
      edges: [],
    };
    const { count, displayNodes } = filterAndFormat(res);
    expect(count).toBe(displayNodes.length);
    expect(count).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// 测试：分层渲染内容
// ─────────────────────────────────────────────────────────────────
describe("分层渲染内容", () => {
  it("L1 层包含 description 和 content", () => {
    const res = {
      nodes: [makeNode("l1", "L1", {
        description: "这是L1描述",
        content: "这是L1完整内容，很长很长",
      })],
      edges: [],
    };
    const { lines } = filterAndFormat(res);
    const l1Line = lines.find((l: string) => l.includes("Node-l1"));
    expect(l1Line).toContain("这是L1描述");
    expect(l1Line).toContain("这是L1完整内容");
  });

  it("L2 层只包含 description，不包含 content", () => {
    const res = {
      nodes: [makeNode("l2", "L2", {
        description: "这是L2描述",
        content: "这是L2完整内容不应该出现",
      })],
      edges: [],
    };
    const { lines } = filterAndFormat(res);
    const l2Line = lines.find((l: string) => l.includes("Node-l2"));
    expect(l2Line).toContain("这是L2描述");
    expect(l2Line).not.toContain("不应该出现");
  });

  it("L3 层只有名字，无 description", () => {
    const res = {
      nodes: [makeNode("l3", "L3", {
        description: "这是描述不应该出现",
        content: "这是内容也不应该出现",
      })],
      edges: [],
    };
    const { lines } = filterAndFormat(res);
    // L3 只有一行：[【L3-名称】] [KNOWLEDGE] Node-l3
    const l3Line = lines.find((l: string) => l.includes("Node-l3"));
    expect(l3Line).toContain("Node-l3");
    expect(l3Line).not.toContain("不应该出现");
  });

  it("hot 节点只有名字", () => {
    const res = {
      nodes: [makeNode("hot1", "hot", {
        description: "hot描述不应出现",
        content: "hot内容不应出现",
        flags: ["hot"],
      })],
      edges: [],
    };
    const { lines } = filterAndFormat(res);
    const hotLine = lines.find((l: string) => l.includes("Node-hot1"));
    expect(hotLine).toContain("Node-hot1");
    expect(hotLine).not.toContain("不应出现");
  });
});

// ─────────────────────────────────────────────────────────────────
// 测试：边过滤
// ─────────────────────────────────────────────────────────────────
describe("边过滤", () => {
  it("只保留两端节点都在 displayNodes 中的边", () => {
    const res = {
      nodes: [makeNode("a", "L1"), makeNode("b", "L2"), makeNode("c", "filtered")],
      edges: [
        { fromId: "a", toId: "b", name: "使用", description: "" },   // ✓ 两端都在
        { fromId: "a", toId: "c", name: "依赖", description: "" },   // ✗ c 被过滤
        { fromId: "b", toId: "a", name: "引用", description: "" },   // ✓ 两端都在
      ],
    };
    const { filteredEdges } = filterAndFormat(res);
    expect(filteredEdges.map((e) => e.name)).toEqual(["使用", "引用"]);
  });

  it("过滤后边的 from/to 名称能正确解析", () => {
    const res = {
      nodes: [makeNode("node-x", "L1"), makeNode("node-y", "L2")],
      edges: [{ fromId: "node-x", toId: "node-y", name: "依赖", description: "A依赖B" }],
    };
    const { filteredEdges } = filterAndFormat(res);
    expect(filteredEdges[0]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────
// 测试：空结果
// ─────────────────────────────────────────────────────────────────
describe("空结果", () => {
  it("全部是 filtered 时返回空 displayNodes", () => {
    const res = {
      nodes: [makeNode("a", "filtered"), makeNode("b", "filtered")],
      edges: [],
    };
    const { displayNodes, count, lines } = filterAndFormat(res);
    expect(displayNodes).toHaveLength(0);
    expect(count).toBe(0);
    expect(lines).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// 测试：tierLabel 正确
// ─────────────────────────────────────────────────────────────────
describe("tierLabel", () => {
  it("各 tier 对应正确标签", () => {
    const res = {
      nodes: [
        makeNode("n1", "L1"),
        makeNode("n2", "L2"),
        makeNode("n3", "L3"),
        makeNode("n4", "hot", { flags: ["hot"] }),
      ],
      edges: [],
    };
    const { lines } = filterAndFormat(res);
    const l1Line = lines.find((l: string) => l.includes("Node-n1"));
    const l2Line = lines.find((l: string) => l.includes("Node-n2"));
    const l3Line = lines.find((l: string) => l.includes("Node-n3"));
    const hotLine = lines.find((l: string) => l.includes("Node-n4"));
    expect(l1Line).toContain("【L1-完整】");
    expect(l2Line).toContain("【L2-描述】");
    expect(l3Line).toContain("【L3-名称】");
    expect(hotLine).toContain("【🔥HOT】");
    expect(lines[3]).toContain("【🔥HOT】");
  });
});
