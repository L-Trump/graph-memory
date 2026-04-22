/**
 * graph-memory — gm_merge tool 隔离测试
 *
 * 测试 gm_merge 工具的核心逻辑：
 * 1. 手动指定 keepName + mergeName 合并两个节点
 * 2. belief (success/failure counts) 正确合并
 * 3. 错误情况处理
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import {
  findByName, findById, upsertNode,
  mergeNodes, edgesFrom, allEdges,
} from "../src/store/store.ts";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
});

// ─── gm_merge 核心逻辑封装（复刻工具 handler 行为）───────────────

interface MergeResult {
  success: boolean;
  reason?: "same_name" | "keep_not_found" | "merge_not_found" | "type_mismatch";
  keepNode?: { id: string; name: string; type: string };
  mergeNode?: { id: string; name: string; type: string };
  message?: string;
}

/**
 * 复刻 gm_merge tool 的执行逻辑
 */
function gmMerge(keepName: string, mergeName: string): MergeResult {
  if (keepName === mergeName) {
    return { success: false, reason: "same_name", message: "两个节点名相同" };
  }
  const keepNode = findByName(db, keepName);
  const mergeNode = findByName(db, mergeName);
  if (!keepNode) {
    return { success: false, reason: "keep_not_found", message: `未找到: ${keepName}` };
  }
  if (!mergeNode) {
    return { success: false, reason: "merge_not_found", message: `未找到: ${mergeName}` };
  }
  if (keepNode.type !== mergeNode.type) {
    return { success: false, reason: "type_mismatch", message: `${keepNode.type} vs ${mergeNode.type}` };
  }
  mergeNodes(db, keepNode.id, mergeNode.id);
  return {
    success: true,
    keepNode: { id: keepNode.id, name: keepNode.name, type: keepNode.type },
    mergeNode: { id: mergeNode.id, name: mergeNode.name, type: mergeNode.type },
    message: `合并完成: ${keepName} 保留, ${mergeName} deprecated`,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────────

describe("gm_merge — 手动合并节点", () => {

  it("happy path: 两个同名 Skill 节点合并，belief counts 累加", () => {
    // 插入两个同类型节点，带不同的 belief 信号
    upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "创建 conda 环境 A", content: "conda create -n myenv",
    }, "session-1");

    upsertNode(db, {
      type: "SKILL", name: "conda-create-environment",
      description: "创建 conda 环境 B", content: "conda env create",
    }, "session-2");

    // 手动注入 belief 信号（模拟多次引用后积累的信号）
    // keep 节点: 3 success, 1 failure
    const keep = findByName(db, "conda-env-create")!;
    db.prepare("UPDATE gm_nodes SET success_count=3, failure_count=1 WHERE id=?").run(keep.id);

    // merge 节点: 2 success, 2 failure
    const merge = findByName(db, "conda-create-environment")!;
    db.prepare("UPDATE gm_nodes SET success_count=2, failure_count=2 WHERE id=?").run(merge.id);

    const result = gmMerge("conda-env-create", "conda-create-environment");

    expect(result.success).toBe(true);
    expect(result.keepNode!.name).toBe("conda-env-create");
    expect(result.mergeNode!.name).toBe("conda-create-environment");

    // 验证合并后的 keep 节点
    const keepAfter = findById(db, keep.id)!;
    expect(keepAfter.status).toBe("active");
    expect(keepAfter.validatedCount).toBe(2); // 1+1
    expect(keepAfter.successCount).toBe(5);  // 3+2
    expect(keepAfter.failureCount).toBe(3);  // 1+2

    // belief 重新计算: (1+5)/(2+5+3) = 6/10 = 0.6
    expect(keepAfter.belief).toBeCloseTo(0.6);

    // merge 节点 deprecated
    const mergeAfter = findById(db, merge.id)!;
    expect(mergeAfter.status).toBe("deprecated");
  });

  it("happy path: 节点带多条 sourceSessions，合并后合并", () => {
    upsertNode(db, { type: "EVENT", name: "libgl-error", description: "libgl缺失", content: "apt install libgl1" }, "session-A");
    upsertNode(db, { type: "EVENT", name: "importerror-libgl", description: "libgl导入错误", content: "import libgl error" }, "session-B");

    const keep = findByName(db, "libgl-error")!;
    const merge = findByName(db, "importerror-libgl")!;

    gmMerge("libgl-error", "importerror-libgl");

    const keepAfter = findById(db, keep.id)!;
    // sourceSessions is already parsed by toNode
    expect(keepAfter.sourceSessions).toContain("session-A");
    expect(keepAfter.sourceSessions).toContain("session-B");
    // merge obj captured before deprecate, re-fetch to verify
    const mergeAfter = findById(db, merge.id)!;
    expect(mergeAfter.status).toBe("deprecated");
  });

  it("边迁移: merge 节点的边迁移到 keep 节点", () => {
    const a = insertNode(db, { name: "node-a", type: "TASK" });
    const b = insertNode(db, { name: "node-b", type: "TASK" });
    const c = insertNode(db, { name: "node-c", type: "SKILL" });

    // b → c 边
    insertEdge(db, { fromId: b, toId: c, name: "SOLVED_BY" });

    gmMerge("node-a", "node-b");

    const edgesFromA = edgesFrom(db, a);
    expect(edgesFromA.some(e => e.toId === c)).toBe(true);
    // b 自己不再有边（已被 merge）
  });

  it("错误: 同名节点", () => {
    upsertNode(db, { type: "SKILL", name: "docker-up", description: "", content: "docker compose up" }, "s1");
    const result = gmMerge("docker-up", "docker-up");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("same_name");
  });

  it("错误: keep 节点不存在", () => {
    upsertNode(db, { type: "SKILL", name: "docker-up", description: "", content: "docker compose up" }, "s1");
    const result = gmMerge("not-exist", "docker-up");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("keep_not_found");
  });

  it("错误: merge 节点不存在", () => {
    upsertNode(db, { type: "SKILL", name: "docker-up", description: "", content: "docker compose up" }, "s1");
    const result = gmMerge("docker-up", "not-exist");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("merge_not_found");
  });

  it("错误: 类型不同不能合并", () => {
    upsertNode(db, { type: "SKILL", name: "docker-up", description: "", content: "docker compose up" }, "s1");
    upsertNode(db, { type: "EVENT", name: "docker-up-event", description: "", content: "docker failed" }, "s1");
    const result = gmMerge("docker-up", "docker-up-event");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("type_mismatch");
  });

  it("flags 合并: keep 和 merge 的 flags 取并集", () => {
    upsertNode(db, {
      type: "KNOWLEDGE", name: "nixos-rebuild",
      description: "NixOS 重建", content: "nixos-rebuild switch",
      flags: ["hot"],
    }, "s1");
    upsertNode(db, {
      type: "KNOWLEDGE", name: "nixos-rebuild-cmd",
      description: "NixOS rebuild command", content: "just switch",
      flags: ["scope_hot:nixos"],
    }, "s2");

    const keep = findByName(db, "nixos-rebuild")!;
    const merge = findByName(db, "nixos-rebuild-cmd")!;
    // merge 前手动设 flags（upsertNode 不会自动继承）
    db.prepare("UPDATE gm_nodes SET flags=? WHERE id=?").run(JSON.stringify(["scope_hot:nixos"]), merge.id);

    gmMerge("nixos-rebuild", "nixos-rebuild-cmd");

    const keepAfter = findById(db, keep.id)!;
    // flags is already parsed by toNode
    expect(keepAfter.flags).toContain("hot");
    expect(keepAfter.flags).toContain("scope_hot:nixos");
  });

  it("content/description 取较长者", () => {
    upsertNode(db, {
      type: "SKILL", name: "short-name",
      description: "短", content: "短内容",
    }, "s1");
    upsertNode(db, {
      type: "SKILL", name: "short-name-2",
      description: "长得多的描述", content: "长得多的内容",
    }, "s2");

    gmMerge("short-name", "short-name-2");

    const keep = findByName(db, "short-name")!;
    expect(keep.description.length).toBeGreaterThanOrEqual("长得多的描述".length);
    expect(keep.content).toBe("长得多的内容");
  });
});
