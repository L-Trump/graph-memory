import { describe, expect, it } from "vitest";
import plugin from "../index.ts";

function makeApi() {
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
        return {};
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
  it("does not register before_message_write cleanup", () => {
    const { api, handlers } = makeApi();
    plugin.register(api);
    expect(handlers.has("before_message_write")).toBe(false);
  });
});
