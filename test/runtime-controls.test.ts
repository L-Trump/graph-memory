import { describe, expect, it } from "vitest";
import plugin from "../index.ts";

function makeApi(config: Record<string, unknown> = {}) {
  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const store = new Map<string, unknown>();
  const sessionEntries: Record<string, any> = {};
  const api: any = {
    pluginConfig: config,
    on(name: string, fn: Function) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand(command: any) {
      commands.set(command.name, command);
    },
    registerContextEngine() {},
    registerTool() {},
    config: { get() { return {}; } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      state: {
        openKeyedStore(options: any) {
          expect(options.namespace).toBe("graph-memory-session-toggles");
          return {
            lookup: async (key: string) => store.get(key),
            register: async (key: string, value: unknown) => { store.set(key, value); },
            delete: async (key: string) => { store.delete(key); },
          };
        },
      },
      agent: {
        session: {
          patchSessionEntry: async ({ sessionKey, update }: any) => {
            const existing = sessionEntries[sessionKey] ?? { sessionId: sessionKey, updatedAt: 0 };
            sessionEntries[sessionKey] = { ...existing, ...update(existing) };
            return sessionEntries[sessionKey];
          },
        },
      },
    },
  };
  return { api, handlers, commands, store, sessionEntries };
}

describe("graph-memory runtime controls", () => {
  it("registers /gm session toggle command and preserves partial on/off semantics", async () => {
    const { api, commands } = makeApi();
    plugin.register(api);
    const gm = commands.get("gm");
    expect(gm).toBeDefined();

    const sessionKey = "agent:main:direct:user1";
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("recall=on");

    expect((await gm.handler({ args: "off recall", sessionKey })).text).toContain("recall off");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("recall=off");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("extract=on");

    expect((await gm.handler({ args: "on recall", sessionKey })).text).toContain("recall on");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("recall=on");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("extract=on");

    expect((await gm.handler({ args: "off", sessionKey })).text).toContain("all off");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("recall=off");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("extract=off");

    expect((await gm.handler({ args: "on", sessionKey })).text).toContain("all on");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("recall=on");
    expect((await gm.handler({ args: "status", sessionKey })).text).toContain("extract=on");
  });

  it("writes graph-memory pluginDebugEntries via session patch", async () => {
    const { api, commands, sessionEntries } = makeApi();
    plugin.register(api);
    const gm = commands.get("gm");
    const sessionKey = "agent:main:direct:user2";

    await gm.handler({ args: "off recall", sessionKey });

    expect(sessionEntries[sessionKey]?.pluginDebugEntries).toEqual([
      {
        pluginId: "graph-memory",
        lines: ["🧠 Graph Memory: session recall=off"],
      },
    ]);
  });
});
