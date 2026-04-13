/**
 * graph-memory — gm_dream 调试测试
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "@photostructure/sqlite";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { findById } from "../src/store/store.ts";

const TEST_DB = "/tmp/gm-test.db";

describe("exploreSubgraph 调试", () => {
  it("findById 能找到节点", () => {
    const db = new DatabaseSync(TEST_DB);
    const node = findById(db, "session-scan-strictly-greater-than-3-hours");
    console.log("findById result:", node ? `${node.name} [${node.id}]` : "null");
    expect(node).not.toBeNull();
    db.close();
  });

  it("Recaller.exploreSubgraph 返回结果", async () => {
    const db = new DatabaseSync(TEST_DB);
    const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });

    const result = await recaller.exploreSubgraph("session-scan-strictly-greater-than-3-hours");

    console.log("roots:", result.roots.length);
    console.log("nodes:", result.nodes.length);
    console.log("edges:", result.edges.length);

    db.close();
  });
});
