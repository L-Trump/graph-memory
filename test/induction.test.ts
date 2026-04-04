/**
 * Topic Induction 单元测试
 *
 * 适配新接口（induceTopics 内部写数据库）：
 * 1. 边界条件
 * 2. 约束过滤（主题属于只允许 semantic→topic，主题包含只允许 topic↔topic）
 * 3. 数据库写入验证（所有节点需先写入 DB 再调用 induceTopics）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { induceTopics } from "../src/engine/induction.ts";
import type { GmNode, GmEdge } from "../src/types.ts";

// ─── 测试数据库 ─────────────────────────────────────────────

function createTestDb(): DatabaseSyncInstance {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gm_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT','KNOWLEDGE','STATUS','TOPIC')),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id TEXT,
      pagerank REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      flags TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE gm_edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE gm_vectors (
      node_id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL
    );
  `);
  return db;
}

let testDb: DatabaseSyncInstance;

beforeEach(() => {
  testDb = createTestDb();
});

// ─── 辅助函数 ─────────────────────────────────────────────

/**
 * 将 semantic 节点写入数据库（模拟 extract 阶段的 upsertNode）
 * 返回值可以传给 induceTopics 作为 sessionNodes
 */
function seedSemanticNode(db: DatabaseSyncInstance, overrides: Partial<GmNode> = {}): GmNode {
  const node: GmNode = {
    id: overrides.id ?? "n1",
    type: overrides.type ?? "KNOWLEDGE",
    name: overrides.name ?? "test-node",
    description: overrides.description ?? "测试节点",
    content: overrides.content ?? "测试内容",
    status: "active",
    validatedCount: 1,
    sourceSessions: [],
    communityId: null,
    pagerank: 0,
    flags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  db.prepare(`
    INSERT INTO gm_nodes (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at, flags)
    VALUES (?, ?, ?, ?, ?, 'active', 1, '[]', ?, ?, '[]')
  `).run(node.id, node.type, node.name, node.description, node.content, node.createdAt, node.updatedAt);
  return node;
}

/**
 * 将 TOPIC 节点写入数据库（用于预置已有 topic）
 */
function seedTopicNode(db: DatabaseSyncInstance, overrides: Partial<GmNode> = {}): GmNode {
  const node: GmNode = {
    id: overrides.id ?? "topic-x",
    type: "TOPIC",
    name: overrides.name ?? "topic-x",
    description: overrides.description ?? "",
    content: overrides.content ?? "",
    status: "active",
    validatedCount: 1,
    sourceSessions: [],
    communityId: null,
    pagerank: 0,
    flags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  db.prepare(`
    INSERT INTO gm_nodes (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at, flags)
    VALUES (?, 'TOPIC', ?, ?, ?, 'active', 1, '[]', ?, ?, '[]')
  `).run(node.id, node.name, node.description, node.content, node.createdAt, node.updatedAt);
  return node;
}

function getTopics(db: DatabaseSyncInstance): any[] {
  return db.prepare("SELECT * FROM gm_nodes WHERE type='TOPIC' AND status='active'").all();
}

function getTopicEdges(db: DatabaseSyncInstance): any[] {
  return db.prepare(`
    SELECT e.* FROM gm_edges e
    JOIN gm_nodes f ON f.id = e.from_id
    JOIN gm_nodes t ON t.id = e.to_id
    WHERE f.type = 'TOPIC' AND t.type = 'TOPIC'
  `).all();
}

function getSemanticToTopicEdges(db: DatabaseSyncInstance): any[] {
  return db.prepare(`
    SELECT e.* FROM gm_edges e
    JOIN gm_nodes f ON f.id = e.from_id
    JOIN gm_nodes t ON t.id = e.to_id
    WHERE f.type != 'TOPIC' AND t.type = 'TOPIC'
  `).all();
}

// ─── 测试：边界条件 ─────────────────────────────────────────

describe("induceTopics - 边界条件", () => {
  it("sessionNodes 为空且无 recaller 时返回空，不调用 LLM", async () => {
    const llm = vi.fn().mockResolvedValue('{"nodes":[],"edges":[]}');
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [],
      llm,
    });

    expect(result.createdTopics).toHaveLength(0);
    expect(result.updatedTopics).toHaveLength(0);
    expect(result.semanticToTopicEdges).toHaveLength(0);
    expect(result.topicToTopicEdges).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("有 sessionNodes 时调用 LLM（即使只有 1 个）", async () => {
    seedSemanticNode(testDb, { id: "n1", name: "node-1" });
    const llm = vi.fn().mockResolvedValue('{"nodes":[],"edges":[]}');
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [{ id: "n1", type: "KNOWLEDGE", name: "node-1", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 }],
      llm,
    });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(getTopics(testDb)).toHaveLength(0);
  });

  it("LLM 返回空时数据库无写入", async () => {
    seedSemanticNode(testDb, { id: "n1", name: "node-1" });
    seedSemanticNode(testDb, { id: "n2", name: "node-2" });
    const llm = vi.fn().mockResolvedValue('{"nodes":[],"edges":[]}');
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "node-1", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
        { id: "n2", type: "KNOWLEDGE", name: "node-2", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    expect(result.createdTopics).toHaveLength(0);
    expect(result.updatedTopics).toHaveLength(0);
    expect(getTopics(testDb)).toHaveLength(0);
    expect(getSemanticToTopicEdges(testDb)).toHaveLength(0);
  });
});

// ─── 测试：约束过滤 ─────────────────────────────────────────

describe("induceTopics - 约束过滤", () => {
  it("主题属于：from 是 topic（而非 semantic）时丢弃", async () => {
    // topic-foo 是 TOPIC 类型，用作 from → topic-bar 时应该被过滤
    seedTopicNode(testDb, { id: "topic-foo", name: "topic-foo" });
    seedTopicNode(testDb, { id: "topic-bar", name: "topic-bar" });

    const mockResponse = {
      nodes: [],
      edges: [
        { from: "topic-foo", to: "topic-bar", name: "主题属于", description: "非法：topic 当 from" },
      ],
    };

    const llm = vi.fn().mockResolvedValue(JSON.stringify(mockResponse));
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "n1", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    // 主题属于：from 必须是 semantic，topic-foo 是 TOPIC → 过滤
    expect(result.semanticToTopicEdges).toHaveLength(0);
  });

  it("主题包含：from 或 to 不是 topic 时丢弃", async () => {
    const mockResponse = {
      nodes: [
        { name: "topic-ops", description: "ops", content: "ops" },
      ],
      edges: [
        // 非法：semantic → topic 用"主题包含"
        { from: "n1", to: "topic-ops", name: "主题包含", description: "非法" },
      ],
    };

    const llm = vi.fn().mockResolvedValue(JSON.stringify(mockResponse));
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "n1", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    // 主题包含：两端都必须是 TOPIC，n1 是 KNOWLEDGE → 过滤
    expect(result.topicToTopicEdges).toHaveLength(0);
  });
});

// ─── 测试：数据库写入 ─────────────────────────────────────────

describe("induceTopics - 数据库写入", () => {
  it("新 topic 节点正确写入数据库", async () => {
    seedSemanticNode(testDb, { id: "n1", name: "nixos-config-rebuild" });
    seedSemanticNode(testDb, { id: "n2", name: "nixos-package-install" });

    const mockResponse = {
      nodes: [
        {
          name: "nixos-sysmgmt",
          description: "NixOS 系统配置与管理",
          content: "该主题聚合了 NixOS 系统配置相关节点",
        },
      ],
      edges: [],
    };

    const llm = vi.fn().mockResolvedValue(JSON.stringify(mockResponse));
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "nixos-config-rebuild", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
        { id: "n2", type: "KNOWLEDGE", name: "nixos-package-install", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    expect(result.createdTopics).toHaveLength(1);
    expect(result.createdTopics[0].name).toBe("nixos-sysmgmt");

    // 数据库验证
    const topics = getTopics(testDb);
    expect(topics).toHaveLength(1);
    expect(topics[0].name).toBe("nixos-sysmgmt");
  });

  it("已有 topic 被识别为更新（upsert）", async () => {
    seedTopicNode(testDb, { id: "topic-pre", name: "topic-feishu-integration", description: "旧描述", content: "旧内容" });
    seedSemanticNode(testDb, { id: "n1", name: "feishu-bitable-query" });

    const mockResponse = {
      nodes: [
        {
          name: "topic-feishu-integration",
          description: "飞书集成（更新后）",
          content: "更新后的内容",
        },
      ],
      edges: [],
    };

    const llm = vi.fn().mockResolvedValue(JSON.stringify(mockResponse));
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "feishu-bitable-query", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    expect(result.updatedTopics).toHaveLength(1);
    expect(result.updatedTopics[0].id).toBe("topic-pre");
    expect(result.createdTopics).toHaveLength(0);

    // 数据库验证：只有 1 个 topic（没有重复创建）
    const topics = getTopics(testDb);
    expect(topics).toHaveLength(1);
    expect(topics[0].description).toBe("飞书集成（更新后）");
    expect(topics[0].validated_count).toBe(2); // 1+1
  });

  it("semantic → topic 归属边正确写入（from/to 都存在于 DB）", async () => {
    seedSemanticNode(testDb, { id: "n1", name: "n1" });
    seedTopicNode(testDb, { id: "topic-xxx", name: "topic-xxx" });

    const mockResponse = {
      nodes: [],
      edges: [
        { from: "n1", to: "topic-xxx", name: "主题属于", description: "n1 归属 topic-xxx" },
      ],
    };

    const llm = vi.fn().mockResolvedValue(JSON.stringify(mockResponse));
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "n1", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    expect(result.semanticToTopicEdges).toHaveLength(1);
    expect(result.semanticToTopicEdges[0].fromId).toBe("n1");
    expect(result.semanticToTopicEdges[0].toId).toBe("topic-xxx");
    expect(result.semanticToTopicEdges[0].name).toBe("主题属于");

    // 数据库验证
    const edges = getSemanticToTopicEdges(testDb);
    expect(edges).toHaveLength(1);
    expect(edges[0].from_id).toBe("n1");
    expect(edges[0].to_id).toBe("topic-xxx");
  });

  it("topic ↔ topic 层级边正确写入（两端都是 LLM 新建的 topic）", async () => {
    seedSemanticNode(testDb, { id: "n1", name: "n1" });

    const mockResponse = {
      nodes: [
        { name: "topic-ops", description: "ops", content: "ops" },
        { name: "topic-arch", description: "arch", content: "arch" },
      ],
      edges: [
        { from: "topic-ops", to: "topic-arch", name: "主题包含", description: "ops 包含 arch" },
      ],
    };

    const llm = vi.fn().mockResolvedValue(JSON.stringify(mockResponse));
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "n1", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    expect(result.createdTopics).toHaveLength(2);
    expect(result.topicToTopicEdges).toHaveLength(1);
    expect(result.topicToTopicEdges[0].name).toBe("主题包含");

    // 数据库验证
    const edges = getTopicEdges(testDb);
    expect(edges).toHaveLength(1);
    expect(edges[0].name).toBe("主题包含");
  });

  it("综合：新建 topic + 更新已有 topic + 两种边", async () => {
    seedTopicNode(testDb, { id: "topic-pre", name: "topic-pre", description: "旧描述", content: "旧内容" });
    seedSemanticNode(testDb, { id: "n1", name: "n1" });

    const mockResponse = {
      nodes: [
        { name: "topic-new", description: "新 topic", content: "内容" },
        { name: "topic-pre", description: "更新后描述", content: "更新后内容" },
      ],
      edges: [
        { from: "n1", to: "topic-new", name: "主题属于", description: "归属" },
        { from: "topic-pre", to: "topic-new", name: "主题包含", description: "包含" },
      ],
    };

    const llm = vi.fn().mockResolvedValue(JSON.stringify(mockResponse));
    const result = await induceTopics({
      db: testDb,
      sessionNodes: [
        { id: "n1", type: "KNOWLEDGE", name: "n1", description: "", content: "", status: "active", validatedCount: 1, sourceSessions: [], communityId: null, pagerank: 0, flags: [], createdAt: 0, updatedAt: 0 },
      ],
      llm,
    });

    expect(result.createdTopics).toHaveLength(1);
    expect(result.createdTopics[0].name).toBe("topic-new");
    expect(result.updatedTopics).toHaveLength(1);
    expect(result.updatedTopics[0].id).toBe("topic-pre");
    expect(result.semanticToTopicEdges).toHaveLength(1);
    expect(result.topicToTopicEdges).toHaveLength(1);

    // 数据库验证
    expect(getTopics(testDb)).toHaveLength(2);
    expect(getSemanticToTopicEdges(testDb)).toHaveLength(1);
    expect(getTopicEdges(testDb)).toHaveLength(1);
  });
});
