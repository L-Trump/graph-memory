/**
 * graph-memory — Topic 节点隔离测试
 *
 * 验证：
 * 1. TOPIC 类型节点在 extract 阶段被正确排除
 * 2. 连接到 TOPIC 节点的边在 extract 阶段被正确排除
 * 3. TOPIC 节点在 recall 阶段正常返回（assembleContext）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { assembleContext, buildExtractKnowledgeGraph } from "../src/format/assemble.ts";
import { findById } from "../src/store/store.ts";
import type { GmNode, GmEdge } from "../src/types.ts";

// toEdge 转换函数（来自 store.ts，测试中内联）
function toEdge(r: any): GmEdge {
  return {
    id: r.id,
    fromId: r.from_id,
    toId: r.to_id,
    name: r.name ?? r.type ?? "",
    description: r.description ?? r.instruction ?? "",
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

// ═══════════════════════════════════════════════════════════════
// 辅助：创建带 TOPIC 类型的测试数据库
// ═══════════════════════════════════════════════════════════════

/**
 * 创建支持 TOPIC 类型的测试数据库
 * 注意：helpers.ts 的 createTestDb 使用 CHECK(type IN (...)) 限制类型
 * 这里创建一个独立的内存数据库，包含 TOPIC 类型支持
 */
function createTestDbWithTopic(): DatabaseSyncInstance {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // 核心表（包含 TOPIC 类型）
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_nodes (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT','KNOWLEDGE','STATUS','TOPIC')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id    TEXT,
      pagerank        REAL NOT NULL DEFAULT 0,
      flags           TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gm_nodes_name ON gm_nodes(name);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_type_status ON gm_nodes(type, status);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_community ON gm_nodes(community_id);

    CREATE TABLE IF NOT EXISTS gm_edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL REFERENCES gm_nodes(id),
      to_id       TEXT NOT NULL REFERENCES gm_nodes(id),
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_edges_from ON gm_edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_gm_edges_to   ON gm_edges(to_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      extracted   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_msg_session ON gm_messages(session_id, turn_index);
  `);

  return db;
}

/**
 * 快速插入 TOPIC 节点
 */
function insertTopicNode(
  db: DatabaseSyncInstance,
  name: string,
  description = "",
  content = "",
): string {
  const id = `topic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO gm_nodes (id, type, name, description, content, status, validated_count, source_sessions, flags, created_at, updated_at)
    VALUES (?, 'TOPIC', ?, ?, ?, 'active', 1, '[]', '[]', ?, ?)
  `).run(id, name, description || `topic: ${name}`, content || `topic content: ${name}`, Date.now(), Date.now());
  return id;
}

let db: DatabaseSyncInstance;

beforeEach(() => { db = createTestDbWithTopic(); });

// ═══════════════════════════════════════════════════════════════
// buildExtractKnowledgeGraph — TOPIC 节点排除测试
// ═══════════════════════════════════════════════════════════════

describe("buildExtractKnowledgeGraph — TOPIC 节点排除", () => {
  it("TOPIC 节点不出现在 extraction graph 中", () => {
    // 插入一个 semantic 节点和一个 TOPIC 节点
    const skillId = insertNode(db, { name: "test-skill", type: "SKILL", content: "test skill content" });
    const topicId = insertTopicNode(db, "test-topic", "测试主题", "topic content");

    const skillNode = findById(db, skillId)!;
    const topicNode = findById(db, topicId)!;

    const xml = buildExtractKnowledgeGraph(
      db,
      [skillNode, topicNode],  // sessionNodes 包含 TOPIC
      [],                      // recalledNodes
      [],                      // sessionEdges
      [],                      // recalledEdges
    );

    expect(xml).toContain("test-skill");
    expect(xml).not.toContain("test-topic");
    expect(xml).not.toContain("<topic");
  });

  it("recalledNodes 中的 TOPIC 节点被排除", () => {
    const skillId = insertNode(db, { name: "recallable-skill", type: "SKILL", content: "content" });
    const topicId = insertTopicNode(db, "recalled-topic", "召回的主题");

    const skillNode = findById(db, skillId)!;
    const topicNode = {
      ...findById(db, topicId)!,
      tier: "L1" as const,
      semanticScore: 0.5,
      pprScore: 0.1,
      pagerankScore: 0.1,
      combinedScore: 0.5,
    };

    const xml = buildExtractKnowledgeGraph(
      db,
      [skillNode],
      [topicNode],  // recalledNodes 包含 TOPIC
      [],
      [],
    );

    expect(xml).toContain("recallable-skill");
    expect(xml).not.toContain("recalled-topic");
  });

  it("连接到 TOPIC 节点的边在 extraction graph 中被排除", () => {
    // skill → topic → task 的边结构
    const skillId = insertNode(db, { name: "edge-from-skill", type: "SKILL", content: "skill content" });
    const topicId = insertTopicNode(db, "edge-target-topic", "主题");
    const taskId = insertNode(db, { name: "edge-from-task", type: "TASK", content: "task content" });

    // skill → topic 的边
    insertEdge(db, { fromId: skillId, toId: topicId, name: "归属于", description: "属于该主题" });
    // topic → task 的边
    insertEdge(db, { fromId: topicId, toId: taskId, name: "包含", description: "主题包含任务" });
    // skill → task 的正常边
    insertEdge(db, { fromId: skillId, toId: taskId, name: "使用", description: "使用该技能完成任务" });

    const skillNode = findById(db, skillId)!;
    const topicNode = findById(db, topicId)!;
    const taskNode = findById(db, taskId)!;

    // 直接构造 GmEdge 对象（insertEdge 不返回构建的边）
    const skillToTopicEdge: GmEdge = {
      id: "e-skill-topic",
      fromId: skillId,
      toId: topicId,
      name: "归属于",
      description: "属于该主题",
      sessionId: "test",
      createdAt: Date.now(),
    };
    const topicToTaskEdge: GmEdge = {
      id: "e-topic-task",
      fromId: topicId,
      toId: taskId,
      name: "包含",
      description: "主题包含任务",
      sessionId: "test",
      createdAt: Date.now(),
    };
    const skillToTaskEdge: GmEdge = {
      id: "e-skill-task",
      fromId: skillId,
      toId: taskId,
      name: "使用",
      description: "使用该技能完成任务",
      sessionId: "test",
      createdAt: Date.now(),
    };
    const sessionEdges = [skillToTopicEdge, topicToTaskEdge, skillToTaskEdge];

    const xml = buildExtractKnowledgeGraph(
      db,
      [skillNode, topicNode, taskNode],
      [],
      sessionEdges,
      [],
    );

    // skill 和 task 应该出现
    expect(xml).toContain("edge-from-skill");
    expect(xml).toContain("edge-from-task");
    // topic 不应该出现
    expect(xml).not.toContain("edge-target-topic");
    // 指向/来自 topic 的边不应该出现
    expect(xml).not.toContain("归属于");
    expect(xml).not.toContain("包含");
    // skill ↔ task 的边应该出现
    expect(xml).toContain("使用");
  });

  it("纯 semantic 节点正常返回", () => {
    const skillId = insertNode(db, { name: "pure-skill", type: "SKILL", content: "skill content" });
    const eventId = insertNode(db, { name: "pure-event", type: "EVENT", content: "event content" });
    const knowledgeId = insertNode(db, { name: "pure-knowledge", type: "KNOWLEDGE", content: "knowledge content" });

    const skillNode = findById(db, skillId)!;
    const eventNode = findById(db, eventId)!;
    const knowledgeNode = findById(db, knowledgeId)!;

    const xml = buildExtractKnowledgeGraph(
      db,
      [skillNode, eventNode, knowledgeNode],
      [],
      [],
      [],
    );

    expect(xml).toContain("pure-skill");
    expect(xml).toContain("pure-event");
    expect(xml).toContain("pure-knowledge");
  });

  it("空输入返回空字符串", () => {
    const xml = buildExtractKnowledgeGraph(db, [], [], [], []);
    expect(xml).toBe("");
  });

  it("只有 TOPIC 节点时返回空字符串", () => {
    const topicId = insertTopicNode(db, "only-topic");
    const topicNode = findById(db, topicId)!;

    const xml = buildExtractKnowledgeGraph(
      db,
      [topicNode],
      [],
      [],
      [],
    );

    expect(xml).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════
// TOPIC 节点在其他场景的保留行为（assembleContext）
// ═══════════════════════════════════════════════════════════════

describe("TOPIC 节点在 assembleContext 中的保留", () => {
  it("TOPIC 节点在 recall 阶段可以正常出现在图中", () => {
    const topicId = insertTopicNode(db, "topic-for-recall", "召回测试主题");
    const topicNode = findById(db, topicId)!;

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [{ ...topicNode, tier: "L1" as const, semanticScore: 0.8, pprScore: 0.1, pagerankScore: 0.3, combinedScore: 0.5 }],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    // recall 阶段 TOPIC 节点应该出现
    expect(xml).toContain("topic-for-recall");
    expect(xml).toContain("<topic");
  });

  it("TOPIC 节点在 active 阶段可以正常出现在图中", () => {
    const topicId = insertTopicNode(db, "topic-active", "活跃主题");
    const topicNode = findById(db, topicId)!;

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      activeNodes: [topicNode],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    expect(xml).toContain("topic-active");
    expect(xml).toContain("<topic");
  });

  it("TOPIC 节点在 hot 阶段可以正常出现在图中", () => {
    const topicId = insertTopicNode(db, "topic-hot", "热门主题");
    const topicNode = { ...findById(db, topicId)!, flags: ["hot"] } as GmNode;

    const { xml } = assembleContext(db, null!, {
      tokenBudget: 128_000,
      hotNodes: [topicNode],
      hotEdges: [] as GmEdge[],
      activeNodes: [] as GmNode[],
      activeEdges: [] as GmEdge[],
      recalledNodes: [] as any[],
      recalledEdges: [] as GmEdge[],
      pprScores: {} as Record<string, number>,
    });

    expect(xml).toContain("topic-hot");
    expect(xml).toContain("<topic");
    expect(xml).toContain('tier="hot"');
  });
});
