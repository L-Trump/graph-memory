/**
 * graph-memory — gm_dream real DB smoke tests
 *
 * Gated by RUN_GM_REAL_DB_TESTS=1 because it expects a prepared copy at
 * /tmp/gm-test.db. Standard `npm test` keeps this suite skipped.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "@photostructure/sqlite";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import {
  getRecentlyRecalledNodes,
  getRecentlyCreatedNodes,
  findById,
} from "../src/store/store.ts";

const TEST_DB = "/tmp/gm-test.db";
const describeRealDb = process.env.RUN_GM_REAL_DB_TESTS === "1" ? describe : describe.skip;

type DreamNode = { id: string; name: string; type: string; description?: string; content?: string; tier?: string };
type DreamEdge = { fromId: string; toId: string };

function buildSubgraphResult(roots: DreamNode[], nodes: DreamNode[], edges: DreamEdge[]) {
  const tieredNodes = nodes.filter(n => n.tier === "L1");
  const nodeIds = new Set(tieredNodes.map(n => n.id));
  const subgraphEdges = edges.filter(e => nodeIds.has(e.fromId) && nodeIds.has(e.toId));

  return {
    seeds: roots.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      description: r.description ?? "",
      content: (r.content ?? "").slice(0, 200),
    })),
    subgraphs: roots.map(root => ({ seed: root.name, nodes: tieredNodes, edges: subgraphEdges })),
  };
}

function exponentialDecayPick<T extends Record<string, unknown>>(
  candidates: T[],
  timeField: keyof T,
  lambda = 0.33,
): T | null {
  if (!candidates.length) return null;
  const now = Date.now();
  const msPerDay = 86_400_000;
  const withWeights = candidates.map(c => {
    const t = Number(c[timeField]) || 0;
    const days = Math.max(0, (now - t) / msPerDay);
    return { item: c, weight: Math.exp(-lambda * days) };
  });
  const total = withWeights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return candidates[0];
  let r = Math.random() * total;
  for (const { item, weight } of withWeights) {
    r -= weight;
    if (r <= 0) return item;
  }
  return withWeights[withWeights.length - 1].item;
}

describeRealDb("gm_dream real DB smoke", () => {
  it("recent recalled and created pools have candidates", () => {
    const db = new DatabaseSync(TEST_DB);
    try {
      const recalled = getRecentlyRecalledNodes(db, 168, 50);
      const created = getRecentlyCreatedNodes(db, 168, 50);
      expect(recalled.length).toBeGreaterThan(0);
      expect(created.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("exploreSubgraph can recall nodes for a known seed id", async () => {
    const db = new DatabaseSync(TEST_DB);
    try {
      const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });
      const seedId = "n-1775085785709-xgcg9";
      expect(findById(db, seedId)).not.toBeNull();

      const result = await recaller.exploreSubgraph(seedId);
      expect(result.roots.length).toBeGreaterThan(0);
      expect(result.nodes.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("buildSubgraphResult filters to L1 nodes and internal edges", () => {
    const roots = [{ id: "root", name: "root", type: "TASK", tier: "L1" }];
    const nodes = [
      { id: "a", name: "a", type: "TASK", tier: "L1" },
      { id: "b", name: "b", type: "SKILL", tier: "L1" },
      { id: "c", name: "c", type: "EVENT", tier: "filtered" },
    ];
    const edges = [
      { fromId: "a", toId: "b" },
      { fromId: "a", toId: "c" },
    ];

    const result = buildSubgraphResult(roots, nodes, edges);
    expect(result.seeds.map(s => s.name)).toEqual(["root"]);
    expect(result.subgraphs[0].nodes.map(n => n.id)).toEqual(["a", "b"]);
    expect(result.subgraphs[0].edges).toEqual([{ fromId: "a", toId: "b" }]);
  });

  it("samples one recalled and one created anchor then explores both", async () => {
    const db = new DatabaseSync(TEST_DB);
    try {
      const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 45 });
      const recalledPool = getRecentlyRecalledNodes(db, 168, 50);
      const createdPool = getRecentlyCreatedNodes(db, 168, 50);

      const recalledDedup = new Map<string, typeof recalledPool[0]>();
      for (const r of recalledPool) if (!recalledDedup.has(r.nodeId)) recalledDedup.set(r.nodeId, r);

      const recalledPick = exponentialDecayPick(Array.from(recalledDedup.values()), "recalledAt");
      const createdPick = exponentialDecayPick(createdPool, "createdAt");
      expect(recalledPick).not.toBeNull();
      expect(createdPick).not.toBeNull();

      const rootsById = new Map<string, DreamNode>();
      const nodes: DreamNode[] = [];
      const edges: DreamEdge[] = [];
      for (const id of [recalledPick!.nodeId, createdPick!.id]) {
        const sub = await recaller.exploreSubgraph(id);
        for (const root of sub.roots) rootsById.set(root.id, root);
        nodes.push(...sub.nodes);
        edges.push(...sub.edges);
      }

      const roots = Array.from(rootsById.values());
      const result = buildSubgraphResult(roots, nodes, edges);
      expect(result.seeds.length).toBeGreaterThan(0);
      expect(result.seeds.length).toBeLessThanOrEqual(2);
      expect(result.subgraphs.length).toBe(result.seeds.length);
    } finally {
      db.close();
    }
  });
});
