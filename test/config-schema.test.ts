import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/types.ts";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: { properties: Record<string, any> } };

function manifestDefault(path: string): unknown {
  const parts = path.split(".");
  let node: any = manifest.configSchema.properties;
  for (const part of parts) {
    node = node?.[part] ?? node?.properties?.[part];
  }
  return node?.default;
}

function configDefault(path: string): unknown {
  return path.split(".").reduce<any>((acc, part) => acc?.[part], DEFAULT_CONFIG as any);
}

describe("graph-memory manifest config schema", () => {
  const props = manifest.configSchema.properties;

  it("declares automation controls", () => {
    expect(props.enabled).toMatchObject({ type: "boolean", default: true });
    expect(props.recallEnabled).toMatchObject({ type: "boolean", default: true });
    expect(props.extractionEnabled).toMatchObject({ type: "boolean", default: true });
    expect(props.allowedChatTypes).toMatchObject({
      type: "array",
      items: { type: "string", enum: ["direct", "group", "channel", "explicit"] },
      default: ["direct", "group", "channel", "explicit"],
    });
    expect(props.allowedChatIds).toMatchObject({ type: "array", items: { type: "string" }, default: [] });
    expect(props.deniedChatIds).toMatchObject({ type: "array", items: { type: "string" }, default: [] });
  });

  it("declares recall resilience controls", () => {
    expect(props.recallTimeoutMs).toMatchObject({ type: "integer", minimum: 50, maximum: 120000, default: 20000 });
    expect(props.recallCacheTtlMs).toMatchObject({ type: "integer", minimum: 0, maximum: 120000, default: 15000 });
    expect(props.recallCircuitBreakerMaxTimeouts).toMatchObject({ type: "integer", minimum: 1, maximum: 20, default: 3 });
    expect(props.recallCircuitBreakerCooldownMs).toMatchObject({ type: "integer", minimum: 1000, maximum: 600000, default: 60000 });
  });

  it("declares status and independent logging controls", () => {
    expect(props.statusDebugEnabled).toMatchObject({ type: "boolean", default: true });
    expect(props.dedupMaxMergesPerRun).toMatchObject({ type: "integer", minimum: 0, default: 200 });
    expect(props.dedupMaxPairsPerRun).toMatchObject({ type: "integer", minimum: 0, default: 1000 });
    expect(props.dedupMaxPendingVectorsPerRun).toMatchObject({ type: "integer", minimum: 0, default: 2000 });

    expect(props.independentLogFile).toMatchObject({
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
        maxFileBytes: { type: "integer", default: 104857600 },
      },
    });
  });

  it("keeps DEFAULT_CONFIG and manifest defaults in sync for runtime control fields", () => {
    const defaultPaths = [
      "enabled",
      "recallEnabled",
      "extractionEnabled",
      "allowedChatTypes",
      "allowedChatIds",
      "deniedChatIds",
      "recallTimeoutMs",
      "recallCacheTtlMs",
      "recallCircuitBreakerMaxTimeouts",
      "recallCircuitBreakerCooldownMs",
      "statusDebugEnabled",
      "autoRecallMode",
      "compactTurnCount",
      "compactActiveNodesEnabled",
      "compactActiveNodesMax",
      "recallMaxNodes",
      "recallMaxDepth",
      "dedupThreshold",
      "dedupMaxMergesPerRun",
      "dedupMaxPairsPerRun",
      "dedupMaxPendingVectorsPerRun",
      "pagerankDamping",
      "pagerankIterations",
      "extractionRecentTurns",
      "decayEnabled",
      "debugContextPreview",
      "retention.enabled",
      "retention.retentionDays",
      "retention.maxDeletePerRun",
      "retention.vacuum",
      "independentLogFile.enabled",
      "independentLogFile.maxFileBytes",
    ];
    for (const path of defaultPaths) {
      expect(manifestDefault(path), path).toEqual(configDefault(path));
    }
  });
});
