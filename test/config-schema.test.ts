import fs from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: { properties: Record<string, unknown> } };

describe("graph-memory manifest config schema", () => {
  const props = manifest.configSchema.properties;

  it("declares P0 automation controls", () => {
    expect(props.enabled).toMatchObject({ type: "boolean", default: true });
    expect(props.recallEnabled).toMatchObject({ type: "boolean", default: true });
    expect(props.extractionEnabled).toMatchObject({ type: "boolean", default: true });
    expect(props.allowedChatTypes).toMatchObject({
      type: "array",
      items: { type: "string", enum: ["direct", "group", "channel", "explicit"] },
    });
    expect(props.allowedChatIds).toMatchObject({ type: "array", items: { type: "string" } });
    expect(props.deniedChatIds).toMatchObject({ type: "array", items: { type: "string" } });
  });

  it("declares P1 recall resilience controls", () => {
    expect(props.recallTimeoutMs).toMatchObject({ type: "integer", minimum: 50, maximum: 120000 });
    expect(props.recallCacheTtlMs).toMatchObject({ type: "integer", minimum: 0, maximum: 120000 });
    expect(props.recallCircuitBreakerMaxTimeouts).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
    expect(props.recallCircuitBreakerCooldownMs).toMatchObject({ type: "integer", minimum: 1000, maximum: 600000 });
  });

  it("declares P3 status debug control", () => {
    expect(props.statusDebugEnabled).toMatchObject({ type: "boolean", default: true });
  });
});
