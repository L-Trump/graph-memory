/**
 * 多轮 Topic Induction 集成测试
 * 运行: npx vitest run test/multi-round-induction.test.ts
 */

import { describe, it, expect } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { Recaller } from "../src/recaller/recall.ts";
import { induceTopics } from "../src/engine/induction.ts";
import type { GmNode, GmConfig, NodeType } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// ─── Mock LLM ──────────────────────────────────────────────

/**
 * Mock LLM：基于 semantic 节点内容返回 topic 归纳结果。
 * existingTopicNames: 已有 topic 名称列表（让 mock 知道不重复创建）
 */
function createMockLlm(existingTopicNames: string[] = []): any {
  const existingSet = new Set(existingTopicNames.map(n => n.toLowerCase()));
  return async (_sys: string, user: string): Promise<string> => {
    // 提取 semantic 节点 name
    const nameMatches = user.match(/<semantic type="\w+" name="([^"]+)"/g) ?? [];
    const semanticNames = nameMatches.map((m: string) => m.match(/name="([^"]+)"/)?.[1] ?? "");
    // 提取 semantic 节点 desc（用于内容匹配）
    const descMatches = user.match(/<semantic[^>]*desc="([^"]*)"/g) ?? [];
    const semanticDescs = descMatches.map((m: string) => m.match(/desc="([^"]*)"/)?.[1] ?? "");
    const text = (semanticNames.join(" ") + " " + semanticDescs.join(" ")).toLowerCase();

    const hasVirtuoso = /virtuoso|cadence/.test(text);
    const hasAdexl = /ade|testbench|仿真/.test(text);
    const hasSemiconductor = /nmos|mosfet|cmos|pmos|半导体|器件|bandgap|layout|版图|建模/.test(text);
    const hasNixos = /nixos|nix/.test(text);

    const result: any = { nodes: [], edges: [] };

    const addTopic = (name: string, desc: string, content: string) => {
      if (result.nodes.find((n: any) => n.name === name)) return;
      result.nodes.push({ name, description: desc, content });
    };

    // 重要：prompt 中已有的 topic（existingSet）也要返回！
    // 这让 induceTopics 能识别并更新它们（isNew=false）
    for (const name of existingTopicNames) {
      addTopic(name, "已有主题", "已有主题内容");
    }

    const addEdge = (from: string, to: string, name: string, desc: string) => {
      const exists = result.edges.some((e: any) => e.from === from && e.to === to && e.name === name);
      if (!exists) result.edges.push({ from, to, name, description: desc });
    };

    if (hasSemiconductor) {
      addTopic("topic-semiconductor", "半导体器件与集成电路设计", "半导体器件与集成电路设计相关知识节点聚合");
      for (const name of semanticNames) {
        if (/nmos|mosfet|cmos|pmos|半导体|器件|bandgap|layout|版图|建模/.test(name.toLowerCase())) {
          addEdge(name, "topic-semiconductor", "主题属于", "归属于半导体主题");
        }
      }
    }

    if (hasVirtuoso || hasAdexl) {
      addTopic("topic-eda-tools", "集成电路设计工具", "EDA工具使用与仿真相关知识聚合");
      for (const name of semanticNames) {
        if (/virtuoso|cadence|ade|testbench/.test(name.toLowerCase())) {
          addEdge(name, "topic-eda-tools", "主题属于", "归属于EDA工具主题");
        }
      }
    }

    // topic↔topic 层级边
    const topicNames = result.nodes.map((n: any) => n.name);
    if (topicNames.includes("topic-eda-tools") && topicNames.includes("topic-semiconductor")) {
      addEdge("topic-eda-tools", "topic-semiconductor", "主题包含", "EDA工具是半导体设计的支撑工具");
    }

    if (hasNixos) {
      addTopic("topic-nixos", "NixOS系统管理", "NixOS配置与包管理");
      for (const name of semanticNames) {
        if (/nixos|nix/.test(name.toLowerCase())) {
          addEdge(name, "topic-nixos", "主题属于", "归属于NixOS主题");
        }
      }
    }

    return JSON.stringify(result);
  };
}

// ─── 测试数据库 ──────────────────────────────────────────────

function createTestDb(): DatabaseSyncInstance {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gm_nodes (
      id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT','KNOWLEDGE','STATUS','TOPIC')),
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
      validated_count INTEGER NOT NULL DEFAULT 1, source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id TEXT, pagerank REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, flags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE gm_edges (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE gm_vectors (node_id TEXT PRIMARY KEY, embedding TEXT NOT NULL);
  `);
  return db;
}

function seedNode(db: DatabaseSyncInstance, node: GmNode) {
  db.prepare(`
    INSERT OR IGNORE INTO gm_nodes (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at, flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    node.id, node.type, node.name, node.description, node.content,
    node.status, node.validatedCount, JSON.stringify(node.sourceSessions),
    node.createdAt, node.updatedAt, JSON.stringify(node.flags)
  );
}

function getTopics(db: DatabaseSyncInstance): any[] {
  return db.prepare("SELECT * FROM gm_nodes WHERE type='TOPIC' AND status='active'").all();
}

function getAllEdges(db: DatabaseSyncInstance): any[] {
  return db.prepare("SELECT * FROM gm_edges").all();
}

function makeNode(id: string, type: NodeType, name: string, description: string, content: string): GmNode {
  return {
    id, type, name, description, content,
    status: "active", validatedCount: 1, sourceSessions: [],
    communityId: null, pagerank: 0, flags: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

// ─── 多轮集成测试 ──────────────────────────────────────────────

describe("Topic Induction 多轮集成测试", () => {
  it("Round 1: 创建 semiconductor topic + semantic→topic edges", async () => {
    const db = createTestDb();
    const mockLlm = createMockLlm([]);
    const recaller = new Recaller(db, DEFAULT_CONFIG)
recaller.setEmbedFn(async () => null as any);

    const nodes = [
      makeNode("r1-n1", "KNOWLEDGE", "nmos-threshold-voltage", "N沟道MOSFET阈值电压特性", "NMOS的Vth温度特性"),
      makeNode("r1-n2", "SKILL", "mosfet-characterization", "MOSFET特性曲线测量", "使用曲线追踪仪测量"),
      makeNode("r1-n3", "KNOWLEDGE", "cmos-inverter-analysis", "CMOS反相器分析", "VTC曲线和传播延迟"),
    ];
    nodes.forEach(n => seedNode(db, n));

    const result = await induceTopics({ db, sessionNodes: nodes, llm: mockLlm, recaller });

    expect(result.createdTopics.map(t => t.name)).toContain("topic-semiconductor");
    expect(result.semanticToTopicEdges.length).toBeGreaterThanOrEqual(2);
    expect(getTopics(db).length).toBeGreaterThanOrEqual(1);
  });

  it("Round 2: 创建 eda-tools topic + topic↔topic 层级边（semiconductor 已有）", async () => {
    const db = createTestDb();
    // 传入已有 topic，让 mock 知道不重复创建
    const mockLlm = createMockLlm(["topic-semiconductor"]);
    const recaller = new Recaller(db, DEFAULT_CONFIG)
recaller.setEmbedFn(async () => null as any);

    seedNode(db, makeNode("existing-t1", "TOPIC", "topic-semiconductor", "半导体器件与集成电路设计", "半导体器件知识聚合"));

    const nodes = [
      makeNode("r2-n1", "SKILL", "virtuoso-schematic-entry", "Virtuoso原理图绘制", "使用Virtuoso绘制模拟电路"),
      makeNode("r2-n2", "KNOWLEDGE", "adexl-testbench-setup", "ADE XL仿真设置", "Corner分析和Monte Carlo"),
    ];
    nodes.forEach(n => seedNode(db, n));

    const result = await induceTopics({ db, sessionNodes: nodes, llm: mockLlm, recaller });

    // topic-eda-tools 是新 topic
    expect(result.createdTopics.map(t => t.name)).toContain("topic-eda-tools");
    // topic-semiconductor 已有 → 应更新而非创建
    expect(result.updatedTopics.map(t => t.name)).toContain("topic-semiconductor");
    // semantic→topic 边
    expect(result.semanticToTopicEdges.length).toBeGreaterThanOrEqual(1);
    // topic↔topic 层级边
    expect(result.topicToTopicEdges.length).toBeGreaterThanOrEqual(1);
    expect(result.topicToTopicEdges[0].name).toBe("主题包含");
  });

  it("Round 3: 空 sessionNodes + recaller，recall 返回空，不 crash", async () => {
    const db = createTestDb();
    const mockLlm = createMockLlm([]);
    const recaller = new Recaller(db, DEFAULT_CONFIG)
recaller.setEmbedFn(async () => null as any);

    seedNode(db, makeNode("t1", "TOPIC", "topic-semiconductor", "半导体", "聚合"));

    const result = await induceTopics({ db, sessionNodes: [], llm: mockLlm, recaller });
    expect(result.createdTopics).toHaveLength(0);
    expect(true).toBe(true);
  });

  it("Round 4: 复用已有 semiconductor topic（通过描述匹配），不重复创建", async () => {
    const db = createTestDb();
    const mockLlm = createMockLlm(["topic-semiconductor"]);
    const recaller = new Recaller(db, DEFAULT_CONFIG)
recaller.setEmbedFn(async () => null as any);

    seedNode(db, makeNode("t1", "TOPIC", "topic-semiconductor", "半导体器件与集成电路设计", "半导体器件知识聚合"));

    // 节点描述含 semiconductor 关键词
    const nodes = [
      makeNode("r4-n1", "KNOWLEDGE", "pmos-device-model", "P沟道MOSFET器件模型", "BSIM4模型对PMOS的建模"),
      makeNode("r4-n2", "EVENT", "device-modeling-session", "器件建模讨论会议", "与导师讨论SOA"),
    ];
    nodes.forEach(n => seedNode(db, n));

    const result = await induceTopics({ db, sessionNodes: nodes, llm: mockLlm, recaller });

    expect(result.createdTopics).toHaveLength(0);
    expect(result.updatedTopics.map(t => t.name)).toContain("topic-semiconductor");
    expect(result.semanticToTopicEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("Round 5: 连续多轮，验证只有 semantic→topic 或 topic↔topic 边（无边过滤）", async () => {
    const db = createTestDb();
    const mockLlm = createMockLlm([]);
    const recaller = new Recaller(db, DEFAULT_CONFIG)
recaller.setEmbedFn(async () => null as any);

    // Round 1: bandgap → semiconductor
    const n1 = makeNode("rr1-n1", "KNOWLEDGE", "bandgap-reference", "带隙基准电路分析", "Bandgap电路的温度特性");
    seedNode(db, n1);
    await induceTopics({ db, sessionNodes: [n1], llm: mockLlm, recaller });

    // Round 2: layout → semiconductor
    const n2 = makeNode("rr2-n1", "SKILL", "layout-vs-routing", "版图布线技巧", "模拟芯片版图绘制要点");
    seedNode(db, n2);
    await induceTopics({ db, sessionNodes: [n2], llm: mockLlm, recaller });

    const topics = getTopics(db);
    const edges = getAllEdges(db);

    expect(topics.length).toBeGreaterThanOrEqual(1);
    expect(edges.length).toBeGreaterThanOrEqual(1);

    // 验证所有边都是 semantic→topic 或 topic↔topic（无 semantic↔semantic）
    for (const e of edges) {
      const fromNode = db.prepare("SELECT type FROM gm_nodes WHERE id=?").get(e.from_id) as any;
      const toNode = db.prepare("SELECT type FROM gm_nodes WHERE id=?").get(e.to_id) as any;
      const fromType = fromNode?.type;
      const toType = toNode?.type;
      const valid = (fromType !== "TOPIC" && toType === "TOPIC") ||
                    (fromType === "TOPIC" && toType === "TOPIC");
      expect(valid).toBe(true);
    }
  });
});
