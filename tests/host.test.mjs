import test from "node:test";
import assert from "node:assert/strict";

test("real DSH SDK entry imports, tool is defined and native HTTP route installs", async (t) => {
  let plugin;
  try {
    plugin = await import("../lib/index.js");
  } catch (e) {
    if (
      e.code === "ERR_MODULE_NOT_FOUND" &&
      e.message.includes("@deepseek-ai")
    ) {
      t.skip("Host SDK absent; install DSH peers to run native check");
      return;
    }
    throw e;
  }
  const tools = [],
    sections = [],
    routes = [],
    disposers = [];
  const ctx = {
    tools: { register: (x) => tools.push(x) },
    llm: {},
    systemPrompt: { section: (x) => sections.push(x) },
    sessions: { get: () => undefined },
    get: (name) =>
      name === "connection"
        ? {
            fetch: {
              register: (r) => {
                routes.push(r);
                return () => {};
              },
            },
          }
        : undefined,
    inject: (_deps, fn) => fn(ctx),
    effect: (fn) => disposers.push(fn()),
  };
  plugin.apply(ctx, {});
  assert.equal(plugin.name, "daily-flashcard");
  assert.equal(tools[0].name, "study_workspace");
  assert.equal(sections.length, 1);
  assert.equal(routes[0].path, "/api/study-workspace/call");
  const invalid = await routes[0].fetch(
    new Request("http://localhost/api/study-workspace/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  assert.equal(invalid.status, 400);
  const response = await routes[0].fetch(
    new Request("http://localhost/api/study-workspace/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "x",
        method: "study-workspace/call",
        payload: { sessionId: "missing", action: "snapshot" },
      }),
    }),
  );
  assert.equal((await response.json()).result.ok, false);
});
