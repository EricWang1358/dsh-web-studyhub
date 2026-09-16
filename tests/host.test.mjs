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
    commands = [],
    sections = [],
    routes = [],
    disposers = [];
  const ctx = {
    tools: { register: (x) => tools.push(x) },
    commands: { register: (x) => commands.push(x) },
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
  assert.equal(commands[0].name, "study-spar");
  assert.equal(
    (await commands[0].handler({ agent: {}, rawInput: "  写成 MQ " })).kind,
    "error",
  );
  assert.equal(sections.length, 1);
  // Every tool result must be lossless JSON (DSH rejects undefined, NaN, -0 and class instances).
  const lossless = (value, path = "$") => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value) && !Object.is(value, -0), `${path} is not a finite JSON number`);
      return;
    }
    if (Array.isArray(value)) return value.forEach((v, i) => lossless(v, `${path}[${i}]`));
    assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, `${path} is not a plain JSON value`);
    for (const [k, v] of Object.entries(value)) lossless(v, `${path}.${k}`);
  };
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const agent = { id: "a", session: { header: { cwd: await mkdtemp(join(tmpdir(), "study-tool-")) } } };
  // Notebook actions must touch an isolated registry, never the real ~/.dsh.
  const nbHome = await mkdtemp(join(tmpdir(), "study-nb-home-"));
  process.env.DSH_HOME = nbHome;
  t.after(async () => {
    delete process.env.DSH_HOME;
    await rm(nbHome, { recursive: true, force: true });
  });
  const tool = async (action, payload) => {
    const value = await tools[0].execute(
      { action, ...(payload ? { payload_json: JSON.stringify(payload) } : {}) },
      { agent },
    );
    lossless(value, action);
    // The tool's output schema is `type: "object"`; DSH rejects anything else.
    assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, `${action} must return a JSON object`);
    return value;
  };
  assert.deepEqual(await tool("ingest.status"), { active: false });
  const text = "Bridge separates an abstraction from its implementation so the two can vary independently.";
  // Global board works through both entry points, even without a study library.
  const initialBoard = await tool("board.get");
  const createdBoard = await tool("board.card.add", { revision: initialBoard.revision, title: "Read iframe notes" });
  const { createHostHandler } = await import("../lib/host.js");
  const secondWorkspace = { header: { cwd: join(nbHome, "second-workspace") } };
  const boardHandler = createHostHandler({ sessions: { get: () => secondWorkspace } });
  const shared = await boardHandler("call", { sessionId: "board-test", action: "board.get" });
  assert.equal(shared.ok, true);
  assert.deepEqual(shared.value, createdBoard);
  const boardCard = Object.values(createdBoard.cards)[0];
  assert.equal(boardCard.origin.workspace, agent.session.header.cwd);
  const moved = await boardHandler("call", { sessionId: "board-test", action: "board.card.move", args: { revision: createdBoard.revision, id: boardCard.id, column: "done" } });
  assert.equal(moved.ok, true);
  assert.deepEqual((await tool("board.get")).columns.find((c) => c.done).cardIds, [boardCard.id]);
  const conflict = await boardHandler("call", { sessionId: "board-test", action: "board.card.edit", args: { revision: createdBoard.revision, id: boardCard.id, title: "Stale" } });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error.message, /revision conflict/);
  const src = await tool("source.add", { title: "notes", text });
  for (const payload of [{ q: "Bridge" }, { keywords: ["Bridge"] }])
    assert.equal((await tool("source.search", payload)).results[0].sourceId, src.id);
  assert.equal((await tool("source.find", { query: "Bridge" })).results[0].sourceId, src.id);
  const card = {
    id: "c1", kind: "flashcard", topic: "Bridge", objective: "Explain Bridge",
    prompt: "What does Bridge separate?", answer: "Abstraction and implementation.",
    hint: "Two dimensions.", explanation: "They vary independently.", misconception: "It adapts interfaces.",
    citations: [{ sourceId: src.id, quote: "separates an abstraction" }],
  };
  await tool("draft.save", { deck: { id: "d1", title: "Patterns", cards: [card] } });
  await tool("draft.publish", { id: "d1" });
  assert.equal((await tool("card.search", { keywords: ["Bridge"] })).results[0].cardId, "c1");
  await tool("snapshot");
  await tool("map");
  const run = await tool("review.start", { deckId: "d1", mode: "flashcard" });
  assert.equal("rubric" in run.card, false);
  await tool("card.get", { deckId: "d1", cardId: "c1" });
  await tool("card.current");
  await tool("review.reveal", { runId: run.id, cardId: "c1" });
  // Cross-workspace notebook actions ride the same tool and transport.
  const published = await tool("notebook.publish");
  assert.equal(published.notebooks.filter((n) => n.current).length, 1);
  const listed = await tool("notebook.list");
  assert.equal(listed.notebooks.length, published.notebooks.length);
  assert.ok(listed.notebooks.some((n) => n.current && n.exists));
  await tool("notebook.unpublish");
  assert.deepEqual((await tool("notebook.list")).notebooks, []);
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

test("light coach route picks thinking off, else low, and caps output only when thinking is off", async (t) => {
  let plugin;
  try {
    plugin = await import("../lib/index.js");
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && e.message.includes("@deepseek-ai")) {
      t.skip("Host SDK absent; install DSH peers to run native check");
      return;
    }
    throw e;
  }
  const { pickLightEffort, modelCompletion } = plugin;
  assert.deepEqual(pickLightEffort([{ id: "high", name: "High" }, { id: "low", name: "Low" }, { id: "none", name: "Off" }]), { id: "none", off: true });
  assert.deepEqual(pickLightEffort([{ id: "max", name: "Max" }, { id: "low", name: "Low" }]), { id: "low", off: false });
  assert.deepEqual(pickLightEffort([{ id: "high", name: "High" }, { id: "max", name: "Max" }]), { id: "high", off: false });
  assert.equal(pickLightEffort([]), null);
  const configs = [];
  const ctx = {
    llm: {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "high", name: "High" }, { id: "off", name: "Off" }] } }),
      resolveCallConfig: async (config) => (configs.push(config), config),
      async *stream() {
        yield { type: "text-delta", text: "{}" };
      },
    },
  };
  const light = modelCompletion(ctx, () => ({ provider: "p", model: "m", reasoningEffort: "high" }), "s", { light: true });
  await light("sys", "prompt", { maxTokens: 300 }).catch(() => {});
  assert.equal(String(configs[0].reasoningEffort), "off");
  assert.equal(configs[0].maxTokens, 300);
});

test("stored sessions resolve their workspace from the header once, never by replaying the log", async () => {
  const { workspaceFor } = await import("../lib/host.js");
  let stats = 0, observes = 0;
  const ctx = {
    sessions: { get: () => undefined },
    get: (name) =>
      name === "sessionPersistence"
        ? { stat: async (id) => (stats++, id === "cold" ? { header: { cwd: "/work/cold" } } : undefined) }
        : name === "sessionQuery"
          ? { observeSession: async (id) => (observes++, id === "legacy" ? { header: { cwd: "/work/legacy" } } : undefined) }
          : undefined,
  };
  const results = await Promise.all([workspaceFor(ctx, "cold"), workspaceFor(ctx, "cold"), workspaceFor(ctx, "cold")]);
  assert.deepEqual(results, ["/work/cold", "/work/cold", "/work/cold"]);
  assert.equal(await workspaceFor(ctx, "cold"), "/work/cold");
  assert.equal(stats, 1, "concurrent and later requests share one header lookup");
  assert.equal(observes, 0, "a header-only stat avoids the full-log observation");
  assert.equal(await workspaceFor(ctx, "legacy"), "/work/legacy", "hosts without stat still fall back");
  await assert.rejects(workspaceFor(ctx, "missing"), /unavailable/);
  await assert.rejects(workspaceFor(ctx, "missing"), /unavailable/);
  assert.equal(observes, 3, "an unknown session is not cached as a failure");
});
