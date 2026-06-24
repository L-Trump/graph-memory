import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDb, resetDb } from "../src/store/db.ts";
import {
  upsertNode, setNodeFlags, upsertEdge, findByName,
  setScopesForSession, getScopesForSession, getScopeHotNodes, listScopes,
  getEdgesForNodes, getHotNodes, getStats,
} from "../src/store/store.ts";
import { assembleStableContext } from "../src/format/assemble.ts";
import type { GmNode, GmEdge } from "../src/types.ts";

let dbPath: string;
let db: ReturnType<typeof getDb>;
let _counter = 0;

beforeEach(() => {
  resetDb(); // clear singletons so getDb creates a fresh instance shared by all modules
  _counter++;
  dbPath = join(tmpdir(), `gm-scope-test-${_counter}.db`);
  db = getDb(dbPath); // both test and store.ts now share this same instance
});

afterEach(() => {
  try { unlinkSync(dbPath); } catch {}
});

describe("scope management", () => {
  it("setScopesForSession stores and retrieves scopes", () => {
    setScopesForSession(db, "session-A", ["gm开发", "飞书群oc_123"]);
    const scopes = getScopesForSession(db, "session-A");
    expect(scopes).toEqual(["gm开发", "飞书群oc_123"]);
  });

  it("setScopesForSession overwrites previous scopes", () => {
    setScopesForSession(db, "session-A", ["scope-1"]);
    setScopesForSession(db, "session-A", ["scope-2", "scope-3"]);
    const scopes = getScopesForSession(db, "session-A");
    expect(scopes).toEqual(["scope-2", "scope-3"]);
  });

  it("setScopesForSession with empty array clears all scopes", () => {
    setScopesForSession(db, "session-A", ["gm开发"]);
    setScopesForSession(db, "session-A", []);
    const scopes = getScopesForSession(db, "session-A");
    expect(scopes).toEqual([]);
  });

  it("multiple sessions can share the same scope", () => {
    setScopesForSession(db, "session-A", ["gm开发"]);
    setScopesForSession(db, "session-B", ["gm开发"]);
    const scopes = listScopes(db);
    expect(scopes).toContainEqual({ scopeName: "gm开发", sessionCount: 2 });
  });

  it("listScopes returns all scopes with session counts", () => {
    setScopesForSession(db, "s1", ["a", "b"]);
    setScopesForSession(db, "s2", ["a"]);
    setScopesForSession(db, "s3", ["b", "c"]);
    const scopes = listScopes(db);
    expect(scopes).toContainEqual({ scopeName: "a", sessionCount: 2 });
    expect(scopes).toContainEqual({ scopeName: "b", sessionCount: 2 });
    expect(scopes).toContainEqual({ scopeName: "c", sessionCount: 1 });
  });
});

describe("scope_hot nodes", () => {
  it("getScopeHotNodes returns nodes with matching scope_hot flag", () => {
    const { node: n1 } = upsertNode(db, { type: "SKILL", name: "skill-a", description: "", content: "content A" }, "s1");
    const { node: n2 } = upsertNode(db, { type: "SKILL", name: "skill-b", description: "", content: "content B" }, "s2");
    setNodeFlags(db, n1.id, ["scope_hot:gm开发"]);
    setNodeFlags(db, n2.id, ["scope_hot:飞书群oc_123"]);

    const scopeHot = getScopeHotNodes(db, ["gm开发"]);
    expect(scopeHot.map(n => n.name)).toEqual(["skill-a"]);

    const scopeHot2 = getScopeHotNodes(db, ["飞书群oc_123"]);
    expect(scopeHot2.map(n => n.name)).toEqual(["skill-b"]);

    const both = getScopeHotNodes(db, ["gm开发", "飞书群oc_123"]);
    expect(both.map(n => n.name).sort()).toEqual(["skill-a", "skill-b"]);
  });

  it("getScopeHotNodes returns empty for unknown scope", () => {
    const { node } = upsertNode(db, { type: "KNOWLEDGE", name: "k-unknown", description: "", content: "k" }, "s1");
    setNodeFlags(db, node.id, ["scope_hot:gm开发"]);
    expect(getScopeHotNodes(db, ["unknown-scope"])).toEqual([]);
  });

  it("node with multiple scope_hot flags matches multiple scopes", () => {
    const { node } = upsertNode(db, { type: "KNOWLEDGE", name: "k-multi", description: "", content: "k" }, "s1");
    setNodeFlags(db, node.id, ["scope_hot:gm开发", "scope_hot:飞书群oc_456"]);

    const fromGm = getScopeHotNodes(db, ["gm开发"]);
    expect(fromGm.map(n => n.name)).toEqual(["k-multi"]);

    const fromFeishu = getScopeHotNodes(db, ["飞书群oc_456"]);
    expect(fromFeishu.map(n => n.name)).toEqual(["k-multi"]);
  });

  it("getScopeHotNodes returns empty array when no scopes given", () => {
    const { node } = upsertNode(db, { type: "SKILL", name: "s-alone", description: "", content: "s" }, "s1");
    setNodeFlags(db, node.id, ["scope_hot:gm开发"]);
    expect(getScopeHotNodes(db, [])).toEqual([]);
  });

  it("uses exact JSON array flag matching, not LIKE substring matching", () => {
    const { node: exact } = upsertNode(db, { type: "SKILL", name: "exact-scope", description: "", content: "" }, "s1");
    const { node: suffix } = upsertNode(db, { type: "SKILL", name: "suffix-scope", description: "", content: "" }, "s1");
    const { node: longer } = upsertNode(db, { type: "SKILL", name: "longer-scope", description: "", content: "" }, "s1");
    setNodeFlags(db, exact.id, ["scope_hot:gm"]);
    setNodeFlags(db, suffix.id, ["not_scope_hot:gm"]);
    setNodeFlags(db, longer.id, ["scope_hot:gm开发"]);

    expect(getScopeHotNodes(db, ["gm"]).map(n => n.name)).toEqual(["exact-scope"]);
  });

  it("skips malformed or non-array flags JSON instead of throwing", () => {
    const { node: good } = upsertNode(db, { type: "SKILL", name: "good-json-flags", description: "", content: "" }, "s1");
    const { node: bad } = upsertNode(db, { type: "SKILL", name: "bad-json-flags", description: "", content: "" }, "s1");
    const { node: scalar } = upsertNode(db, { type: "SKILL", name: "scalar-json-flags", description: "", content: "" }, "s1");
    const { node: object } = upsertNode(db, { type: "SKILL", name: "object-json-flags", description: "", content: "" }, "s1");
    setNodeFlags(db, good.id, ["scope_hot:gm开发"]);
    db.prepare("UPDATE gm_nodes SET flags=? WHERE id=?").run("not-json", bad.id);
    db.prepare("UPDATE gm_nodes SET flags=? WHERE id=?").run('"scope_hot:gm开发"', scalar.id);
    db.prepare("UPDATE gm_nodes SET flags=? WHERE id=?").run('{"flag":"scope_hot:gm开发"}', object.id);

    expect(getScopeHotNodes(db, ["gm开发"]).map(n => n.name)).toEqual(["good-json-flags"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// 测试：hot flag 精确匹配
// ─────────────────────────────────────────────────────────────────
describe("hot nodes", () => {
  it("getHotNodes and getStats use exact JSON array flag matching", () => {
    const { node: hot } = upsertNode(db, { type: "KNOWLEDGE", name: "real-hot", description: "", content: "" }, "s1");
    const { node: notHot } = upsertNode(db, { type: "KNOWLEDGE", name: "not-hot", description: "", content: "" }, "s1");
    const { node: malformed } = upsertNode(db, { type: "KNOWLEDGE", name: "malformed-flags", description: "", content: "" }, "s1");
    const { node: scalar } = upsertNode(db, { type: "KNOWLEDGE", name: "scalar-hot", description: "", content: "" }, "s1");
    const { node: object } = upsertNode(db, { type: "KNOWLEDGE", name: "object-hot", description: "", content: "" }, "s1");
    setNodeFlags(db, hot.id, ["hot"]);
    setNodeFlags(db, notHot.id, ["not-hot"]);
    db.prepare("UPDATE gm_nodes SET flags=? WHERE id=?").run("not-json", malformed.id);
    db.prepare("UPDATE gm_nodes SET flags=? WHERE id=?").run('"hot"', scalar.id);
    db.prepare("UPDATE gm_nodes SET flags=? WHERE id=?").run('{"flag":"hot"}', object.id);

    expect(getHotNodes(db).map(n => n.name)).toEqual(["real-hot"]);
    expect(getStats(db).hotNodes).toBe(1);
  });
});

describe("assemble with scope_hot tier", () => {
  it("scope_hot nodes appear in XML output with scope_hot tier", () => {
    const { node: scopeHotNode } = upsertNode(
      db, { type: "SKILL", name: "scope-hot-skill", description: "a scope hot skill", content: "scope hot content" }, "session-1"
    );
    setNodeFlags(db, scopeHotNode.id, ["scope_hot:gm开发"]);
    setScopesForSession(db, "session-1", ["gm开发"]);

    const scopeHotNodes = getScopeHotNodes(db, ["gm开发"]);
    const scopeHotEdges: GmEdge[] = [];

    const { xml } = assembleStableContext(db, null!, {
      scopeHotNodes,
      scopeHotEdges,
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      compactActiveNodes: [] as GmNode[],
      compactActiveEdges: [] as GmEdge[],
    });

    expect(xml).toContain("<knowledge_graph>");
    expect(xml).toContain('name="scope-hot-skill"');
    expect(xml).toContain('tier="scope_hot"');
    expect(xml).toContain("scope hot content");
  });

  it("scope_hot nodes take priority over hot nodes for same id", () => {
    const { node } = upsertNode(db, { type: "SKILL", name: "shared-skill", description: "desc", content: "content" }, "s1");
    setNodeFlags(db, node.id, ["hot", "scope_hot:gm开发"]);
    setScopesForSession(db, "s1", ["gm开发"]);

    const scopeHotNodes = getScopeHotNodes(db, ["gm开发"]);
    const hotNodes: GmNode[] = [{ ...node, flags: ["hot"] }];

    const { xml } = assembleStableContext(db, null!, {
      scopeHotNodes,
      scopeHotEdges: [],
      hotNodes,
      hotEdges: [],
      compactActiveNodes: [] as GmNode[],
      compactActiveEdges: [] as GmEdge[],
    });

    expect(xml).toContain('name="shared-skill"');
    expect(xml).toContain('tier="scope_hot"');
  });

  it("scope_hot count appears in system prompt when present", () => {
    const { node } = upsertNode(db, { type: "SKILL", name: "scope-hot-1", description: "", content: "c" }, "s1");
    setNodeFlags(db, node.id, ["scope_hot:gm开发"]);
    setScopesForSession(db, "s1", ["gm开发"]);

    const scopeHotNodes = getScopeHotNodes(db, ["gm开发"]);

    const { xml, systemPrompt } = assembleStableContext(db, null!, {
      scopeHotNodes,
      scopeHotEdges: [],
      hotNodes: [] as GmNode[],
      hotEdges: [] as GmEdge[],
      compactActiveNodes: [] as GmNode[],
      compactActiveEdges: [] as GmEdge[],
    });

    expect(systemPrompt).toContain("scope_hot");
    expect(xml).toContain('tier="scope_hot"');
  });


  // ── setNodeFlags 追加模式验证 ────────────────────────────────
  it("setNodeFlags appends hot without removing other flags", () => {
    upsertNode(db, { type: "KNOWLEDGE", name: "test-node", description: "", content: "" }, "sid");
    // 先设一个普通 flag
    setNodeFlags(db, findByName(db, "test-node")!.id, ["scope_hot:foo"]);
    // 再追加 hot（模拟 gm_set_hot 的追加逻辑）
    const node = findByName(db, "test-node")!;
    setNodeFlags(db, node.id, [...node.flags, "hot"]);
    const after = findByName(db, "test-node")!;
    expect(after.flags).toContain("scope_hot:foo");
    expect(after.flags).toContain("hot");
    expect(after.flags).toHaveLength(2);
  });

  it("setNodeFlags appends scope_hot without removing hot or other scope_hot", () => {
    upsertNode(db, { type: "KNOWLEDGE", name: "test-node", description: "", content: "" }, "sid");
    // 先设 hot
    setNodeFlags(db, findByName(db, "test-node")!.id, ["hot"]);
    // 再追加 scope_hot:foo（模拟 gm_set_scope_hot 的追加逻辑）
    const node = findByName(db, "test-node")!;
    setNodeFlags(db, node.id, [...node.flags, "scope_hot:foo"]);
    const after = findByName(db, "test-node")!;
    expect(after.flags).toContain("hot");
    expect(after.flags).toContain("scope_hot:foo");
    expect(after.flags).toHaveLength(2);
    // 再追加 scope_hot:bar，也不应移除 scope_hot:foo
    const node2 = findByName(db, "test-node")!;
    setNodeFlags(db, node2.id, [...node2.flags, "scope_hot:bar"]);
    const after2 = findByName(db, "test-node")!;
    expect(after2.flags).toContain("hot");
    expect(after2.flags).toContain("scope_hot:foo");
    expect(after2.flags).toContain("scope_hot:bar");
    expect(after2.flags).toHaveLength(3);
  });
});
