import { describe, expect, it } from "vitest";
import plugin from "../index.ts";

function makeApi(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function[]>();
  const api: any = {
    on(name: string, fn: Function) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerContextEngine() {},
    registerTool() {},
    config: {
      get() {
        return config;
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  };
  return { api, handlers };
}

describe("graph-memory runtime strip behavior", () => {
  it("before_message_write is not a cleanup hook in full mode", () => {
    const { api, handlers } = makeApi({ autoRecallMode: "full" });
    plugin.register(api);
    const hooks = handlers.get("before_message_write") ?? [];
    expect(hooks.length).toBeGreaterThanOrEqual(1);

    const result = hooks[0]({ message: { role: "user", content: "hello" }, sessionKey: "s1" }, { sessionKey: "s1" });
    expect(result).toBeUndefined();
  });
});
