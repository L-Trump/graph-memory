/**
 * graph-memory — Decay Engine Tests
 *
 * Tests the Weibull decay model and composite scoring.
 */

import { describe, it, assert } from "vitest";
import {
  createDecayEngine,
  getTypeImportance,
  toDecayableNode,
  DEFAULT_DECAY_CONFIG,
  type DecayableNode,
} from "../src/engine/decay.ts";

const MS_PER_DAY = 86_400_000;
const now = Date.now();

// Helper to create a DecayableNode with sensible defaults
function node(
  type: DecayableNode["type"],
  overrides: Partial<DecayableNode> & { id?: string } = {}
): DecayableNode {
  return {
    id: "test-node",
    type,
    importance: 0.5,
    belief: 0.5,
    accessCount: 0,
    createdAt: now - 30 * MS_PER_DAY,
    lastAccessedAt: 0,
    ...overrides,
  } as DecayableNode;
}

describe("getTypeImportance", () => {
  it("SKILL = 0.9", () => assert.closeTo(getTypeImportance("SKILL"), 0.9, 0.01));
  it("TOPIC = 0.85", () => assert.closeTo(getTypeImportance("TOPIC"), 0.85, 0.01));
  it("KNOWLEDGE = 0.7", () => assert.closeTo(getTypeImportance("KNOWLEDGE"), 0.7, 0.01));
  it("TASK = 0.6", () => assert.closeTo(getTypeImportance("TASK"), 0.6, 0.01));
  it("EVENT = 0.5", () => assert.closeTo(getTypeImportance("EVENT"), 0.5, 0.01));
  it("STATUS = 0.3", () => assert.closeTo(getTypeImportance("STATUS"), 0.3, 0.01));
});

describe("DecayEngine — recency", () => {
  const engine = createDecayEngine();

  it("fresh node has recency near 1.0", () => {
    const n = node("SKILL", { lastAccessedAt: now });
    const ds = engine.score(n, now);
    assert.closeTo(ds.recency, 1.0, 0.05);
  });

  it("very old never-accessed STATUS decays below 0.5", () => {
    const n = node("STATUS", {
      createdAt: now - 90 * MS_PER_DAY,
      lastAccessedAt: 0,
    });
    assert.isBelow(engine.score(n, now).recency, 0.5);
  });

  it("SKILL decays slower than STATUS", () => {
    const old = { createdAt: now - 60 * MS_PER_DAY, lastAccessedAt: 0 };
    const skill = engine.score(node("SKILL", old), now);
    const status = engine.score(node("STATUS", old), now);
    assert.isAbove(skill.recency, status.recency);
  });

  it("accessed node has better recency than never-accessed", () => {
    const base = now - 30 * MS_PER_DAY;
    const recent = now - 2 * MS_PER_DAY; // accessed 2 days ago
    const never = node("TASK", { createdAt: base, lastAccessedAt: 0 });
    const accessed = node("TASK", { createdAt: base, lastAccessedAt: recent });
    assert.isAbove(engine.score(accessed, now).recency, engine.score(never, now).recency);
  });
});

describe("DecayEngine — frequency", () => {
  const engine = createDecayEngine();

  it("accessCount=0 has low frequency", () => {
    const ds = engine.score(node("SKILL", { accessCount: 0 }), now);
    assert.isBelow(ds.frequency, 0.3);
  });

  it("high accessCount saturates toward 1.0", () => {
    const ds = engine.score(node("SKILL", { accessCount: 50 }), now);
    assert.closeTo(ds.frequency, 1.0, 0.1);
  });

  it("more accesses → higher frequency", () => {
    const low = engine.score(node("SKILL", { accessCount: 1 }), now);
    const high = engine.score(node("SKILL", { accessCount: 10 }), now);
    assert.isAbove(high.frequency, low.frequency);
  });
});

describe("DecayEngine — intrinsic", () => {
  const engine = createDecayEngine();

  it("intrinsic = importance × belief", () => {
    const n = node("SKILL", { belief: 0.8 });
    const ds = engine.score(n, now);
    assert.closeTo(ds.intrinsic, getTypeImportance("SKILL") * 0.8, 0.01);
  });

  it("SKILL intrinsic > STATUS intrinsic", () => {
    const skill = engine.score(node("SKILL", { belief: 0.5 }), now);
    const status = engine.score(node("STATUS", { belief: 0.5 }), now);
    assert.isAbove(skill.intrinsic, status.intrinsic);
  });
});

describe("DecayEngine — composite", () => {
  const engine = createDecayEngine();

  it("composite = weighted sum of recency + frequency + intrinsic", () => {
    const n = node("SKILL", { belief: 0.5, accessCount: 5 });
    const ds = engine.score(n, now);
    const expected =
      DEFAULT_DECAY_CONFIG.recencyWeight * ds.recency +
      DEFAULT_DECAY_CONFIG.frequencyWeight * ds.frequency +
      DEFAULT_DECAY_CONFIG.intrinsicWeight * ds.intrinsic;
    assert.closeTo(ds.composite, expected, 0.001);
  });

  it("fresh accessed SKILL has high composite", () => {
    const n = node("SKILL", { belief: 0.9, accessCount: 10, lastAccessedAt: now });
    assert.isAbove(engine.score(n, now).composite, 0.7);
  });

  it("old never-accessed STATUS has low composite", () => {
    const n = node("STATUS", {
      belief: 0.5, accessCount: 0,
      createdAt: now - 120 * MS_PER_DAY, lastAccessedAt: 0,
    });
    assert.isBelow(engine.score(n, now).composite, DEFAULT_DECAY_CONFIG.staleThreshold);
  });
});

describe("DecayEngine — stale detection", () => {
  const engine = createDecayEngine();

  it("getStaleNodes returns nodes below threshold sorted ascending", () => {
    const stale = node("STATUS", {
      id: "stale",
      belief: 0.3,
      accessCount: 0,
      createdAt: now - 120 * MS_PER_DAY,
      lastAccessedAt: 0,
    });
    const fresh = node("SKILL", {
      id: "fresh",
      belief: 0.9,
      accessCount: 5,
      lastAccessedAt: now,
    });
    const result = engine.getStaleNodes([stale, fresh], now);
    assert.equal(result.length, 1);
    assert.equal(result[0].nodeId, "stale");
  });

  it("stale nodes sorted by composite ascending", () => {
    const a = node("STATUS", {
      id: "a", belief: 0.2,
      createdAt: now - 180 * MS_PER_DAY, lastAccessedAt: 0,
    });
    const b = node("STATUS", {
      id: "b", belief: 0.4,
      createdAt: now - 60 * MS_PER_DAY, lastAccessedAt: 0,
    });
    const result = engine.getStaleNodes([a, b], now);
    assert.equal(result[0].nodeId, "a");
    assert.isBelow(result[0].composite, result[1].composite);
  });
});

describe("DecayEngine — applySearchBoost", () => {
  const engine = createDecayEngine();

  it("boosts high-composite more than low, but respects minimum", () => {
    const fresh = node("SKILL", {
      id: "fresh", belief: 0.9, accessCount: 5,
      createdAt: now, lastAccessedAt: now,
    });
    const stale = node("STATUS", {
      id: "stale", belief: 0.2, accessCount: 0,
      createdAt: now - 120 * MS_PER_DAY, lastAccessedAt: 0,
    });
    const results: Array<{ node: DecayableNode; score: number }> = [
      { node: fresh, score: 0.5 },
      { node: stale, score: 0.5 },
    ];
    engine.applySearchBoost(results, now);
    assert.isAbove(results[0].score, results[1].score);
    assert.isAtLeast(results[0].score, DEFAULT_DECAY_CONFIG.searchBoostMin);
    // Note: stale STATUS has floor=0.4 which protects it from going too low
    assert.isAtLeast(results[1].score, 0.2);
  });
});

describe("DecayEngine — Weibull beta", () => {
  const engine = createDecayEngine();

  it("SKILL (beta=0.8) retains more than STATUS (beta=1.3) at 200 days", () => {
    const old = {
      createdAt: now - 200 * MS_PER_DAY,
      lastAccessedAt: 0,
      accessCount: 0,
      belief: 0.5,
    };
    const skill = engine.score(node("SKILL", old), now);
    const status = engine.score(node("STATUS", old), now);
    assert.isAbove(skill.recency, status.recency);
  });
});

describe("toDecayableNode", () => {
  it("converts GmNode with correct importance from type", () => {
    const gmNode = {
      id: "test",
      type: "SKILL" as const,
      belief: 0.7,
      accessCount: 3,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now - 5 * MS_PER_DAY,
    };
    const d = toDecayableNode(gmNode);
    assert.equal(d.importance, getTypeImportance("SKILL"));
    assert.equal(d.belief, 0.7);
    assert.equal(d.accessCount, 3);
  });

  it("defaults missing fields for pre-access-tracking nodes", () => {
    const gmNode = {
      id: "old",
      type: "EVENT" as const,
      belief: 0.5,
      createdAt: now - 90 * MS_PER_DAY,
      updatedAt: now - 90 * MS_PER_DAY,
    };
    const d = toDecayableNode(gmNode as any);
    assert.equal(d.accessCount, 0);
    assert.equal(d.lastAccessedAt, 0);
  });
});

describe("DecayEngine — scoreAll", () => {
  const engine = createDecayEngine();

  it("returns scores for all input nodes", () => {
    const nodes = [
      node("SKILL", { id: "a", lastAccessedAt: now }),
      node("STATUS", { id: "b", lastAccessedAt: 0 }),
    ];
    const scores = engine.scoreAll(nodes, now);
    assert.equal(scores.length, 2);
    assert.ok(scores.find(s => s.nodeId === "a"));
    assert.ok(scores.find(s => s.nodeId === "b"));
  });
});

describe("DecayEngine — custom config", () => {
  it("custom staleThreshold affects stale detection", () => {
    const engine = createDecayEngine({ staleThreshold: 0.6 });
    const n = node("EVENT", {
      belief: 0.5, accessCount: 1,
      createdAt: now - 30 * MS_PER_DAY,
      lastAccessedAt: now - 15 * MS_PER_DAY,
    });
    const stale = engine.getStaleNodes([n], now);
    assert.isAtLeast(stale.length, 1);
  });
});
