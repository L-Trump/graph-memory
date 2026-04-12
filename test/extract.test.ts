/**
 * graph-memory — 提取器测试
 *
 * By: adoresever
 * Updated for flexible edge names (v2)
 */

import { describe, it, expect } from "vitest";
import { Extractor } from "../src/extractor/extract.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import type { ExtractionResult, FinalizeResult } from "../src/types.ts";

// ─── Mock LLM：直接返回预设 JSON ────────────────────────────────

function mockLlm(response: string) {
  return async (_sys: string, _user: string) => response;
}

function createExtractor(response: string): Extractor {
  return new Extractor(DEFAULT_CONFIG, mockLlm(response));
}

// ═══════════════════════════════════════════════════════════════
// 节点验证（未变）
// ═══════════════════════════════════════════════════════════════

describe("节点验证", () => {
  it("非法 type 的节点被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "valid-skill", description: "有效", content: "## valid-skill\n### 触发条件\n..." },
        { type: "WORKFLOW", name: "invalid-workflow", description: "无效类型", content: "## invalid" },
      ],
      edges: [],
    }));

    const result = await ext.extract({ messages: [],  });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("valid-skill");
  });

  it("缺少必填字段的节点被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "has-all-fields", description: "完整", content: "## complete" },
        { type: "SKILL", name: "no-content", description: "缺 content" },
        { type: "SKILL", content: "缺 name" },
        { name: "no-type", description: "缺 type", content: "## no-type" },
      ],
      edges: [],
    }));

    const result = await ext.extract({ messages: [],  });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].name).toBe("has-all-fields");
  });

  it("name 自动标准化", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "SKILL", name: "Docker Port Expose", description: "端口", content: "## docker-port-expose" },
        { type: "TASK", name: "EXTRACT_PDF_TABLES", description: "提取表格", content: "## extract-pdf-tables" },
      ],
      edges: [],
    }));

    const result = await ext.extract({ messages: [],  });

    expect(result.nodes[0].name).toBe("docker-port-expose");
    expect(result.nodes[1].name).toBe("extract-pdf-tables");
  });
});

// ═══════════════════════════════════════════════════════════════
// 边验证（新 schema: name + description）
// ═══════════════════════════════════════════════════════════════

describe("边验证（新 schema）", () => {
  it("完整边字段正确解析", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "deploy-mcp", description: "部署", content: "## deploy-mcp" },
        { type: "SKILL", name: "docker-run", description: "运行容器", content: "## docker-run" },
      ],
      edges: [
        { from: "deploy-mcp", to: "docker-run", name: "使用", description: "第 2 步用 docker run 启动容器" },
      ],
    }));

    const result = await ext.extract({ messages: [],  });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].name).toBe("使用");
    expect(result.edges[0].description).toBe("第 2 步用 docker run 启动容器");
    expect(result.edges[0].from).toBe("deploy-mcp");
    expect(result.edges[0].to).toBe("docker-run");
  });

  it("缺少 name 的边被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "task-a", description: "任务", content: "## task-a" },
        { type: "SKILL", name: "skill-a", description: "技能", content: "## skill-a" },
      ],
      edges: [
        { from: "task-a", to: "skill-a", description: "缺 name 字段" },
        { from: "task-a", to: "skill-a", name: "", description: "name 为空" },
        { from: "task-a", to: "skill-a", name: "使用", description: "有 name" },
      ],
    }));

    const result = await ext.extract({ messages: [],  });

    // 前两条缺少 name 或 name 为空，只保留第三条
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].name).toBe("使用");
  });

  it("缺少 description 的边被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "task-a", description: "任务", content: "## task-a" },
        { type: "SKILL", name: "skill-a", description: "技能", content: "## skill-a" },
      ],
      edges: [
        { from: "task-a", to: "skill-a", name: "使用", description: "" },
        { from: "task-a", to: "skill-a", name: "使用", description: "有 description" },
      ],
    }));

    const result = await ext.extract({ messages: [],  });

    // 第一条 description 为空，只保留第二条
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].description).toBe("有 description");
  });

  it("边的 from/to name 自动标准化后匹配节点", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "deploy-mcp", description: "部署", content: "## deploy-mcp" },
        { type: "SKILL", name: "docker-run", description: "运行", content: "## docker-run" },
      ],
      edges: [
        { from: "Deploy MCP", to: "Docker_Run", name: "使用", description: "docker run" },
      ],
    }));

    const result = await ext.extract({ messages: [],  });

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe("deploy-mcp");
    expect(result.edges[0].to).toBe("docker-run");
  });
});

// ═══════════════════════════════════════════════════════════════
// LLM 输出格式容错
// ═══════════════════════════════════════════════════════════════

describe("LLM 输出格式容错", () => {
  it("处理 markdown 代码块包裹", async () => {
    const ext = createExtractor('```json\n{"nodes":[{"type":"SKILL","name":"test-skill","description":"测试","content":"## test"}],"edges":[]}\n```');

    const result = await ext.extract({ messages: [],  });

    expect(result.nodes).toHaveLength(1);
  });

  it("处理 JSON 前有额外文字", async () => {
    const ext = createExtractor('好的，以下是提取结果：\n{"nodes":[{"type":"SKILL","name":"test-skill","description":"测试","content":"## test"}],"edges":[]}');

    const result = await ext.extract({ messages: [],  });

    expect(result.nodes).toHaveLength(1);
  });

  it("完全无效的输出抛出异常", async () => {
    const ext = createExtractor("这不是 JSON，我不知道该怎么提取。");

    await expect(ext.extract({ messages: [],  })).rejects.toThrow();
  });

  it("空 JSON 返回空结果", async () => {
    const ext = createExtractor('{"nodes":[],"edges":[]}');

    const result = await ext.extract({ messages: [],  });

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 完整场景模拟
// ═══════════════════════════════════════════════════════════════

describe("完整场景模拟", () => {
  it("混合场景：TASK + EVENT + 多个 SKILL + 多种边", async () => {
    const ext = createExtractor(JSON.stringify({
      nodes: [
        { type: "TASK", name: "deploy-bilibili-mcp", description: "部署 bilibili MCP 服务", content: "## deploy-bilibili-mcp\n### 目标\n部署 MCP" },
        { type: "SKILL", name: "docker-compose-up", description: "docker compose 启动", content: "## docker-compose-up\n### 触发条件\n需要启动服务" },
        { type: "SKILL", name: "pip-install-deps", description: "安装 Python 依赖", content: "## pip-install-deps\n### 触发条件\n缺少依赖时" },
        { type: "EVENT", name: "importerror-bilibili-api", description: "缺少 bilibili-api", content: "## importerror-bilibili-api\n### 现象\nModuleNotFoundError" },
      ],
      edges: [
        { from: "deploy-bilibili-mcp", to: "docker-compose-up", name: "使用", description: "docker compose up -d 启动服务" },
        { from: "importerror-bilibili-api", to: "pip-install-deps", name: "解决", description: "pip install bilibili-api-python 解决导入错误" },
        { from: "docker-compose-up", to: "pip-install-deps", name: "依赖", description: "compose 启动前需要依赖已安装" },
      ],
    }));

    const result = await ext.extract({ messages: [],  });

    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(3);

    const taskEdge = result.edges.find(e => e.from === "deploy-bilibili-mcp");
    expect(taskEdge!.name).toBe("使用");

    const eventEdge = result.edges.find(e => e.from === "importerror-bilibili-api");
    expect(eventEdge!.name).toBe("解决");

    const skillEdge = result.edges.find(e => e.from === "docker-compose-up");
    expect(skillEdge!.name).toBe("依赖");
  });
});

// ═══════════════════════════════════════════════════════════════
// finalize 验证
// ═══════════════════════════════════════════════════════════════

describe("finalize 验证", () => {
  it("newEdges 缺少 name/description 被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      promotedSkills: [],
      newEdges: [
        { from: "a", to: "b", name: "使用", description: "合法" },
        { from: "a", to: "b", name: "", description: "缺 name" },
        { from: "a", to: "b", name: "依赖", description: "" },
      ],
      invalidations: [],
    }));

    const result = await ext.finalize({ sessionNodes: [], graphSummary: "" });

    // 只保留第一条
    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0].name).toBe("使用");
  });

  it("promotedSkills 缺少必填字段被过滤", async () => {
    const ext = createExtractor(JSON.stringify({
      promotedSkills: [
        { type: "SKILL", name: "valid-skill", description: "有效", content: "## valid" },
        { type: "SKILL", name: "no-content", description: "缺 content" },
      ],
      newEdges: [],
      invalidations: [],
    }));

    const result = await ext.finalize({ sessionNodes: [], graphSummary: "" });

    expect(result.promotedSkills).toHaveLength(1);
    expect(result.promotedSkills[0].name).toBe("valid-skill");
  });
});
