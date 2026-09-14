import test from "node:test";
import assert from "node:assert/strict";
import { runGenerationAgent } from "../lib/generation-agent.js";
import { runContinuablePhase } from "../lib/generation-continuable.js";
import { studyToolMode } from "../lib/study-tool-mode.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

test("installed DSH code-mode transport is removed only for the Study child's scope", async () => {
  const require = createRequire(import.meta.url);
  const fromTools = createRequire(require.resolve("@deepseek-ai/dsh-tools"));
  const load = (name) => import(pathToFileURL(fromTools.resolve(name)).href);
  const [{ Context }, { createScope }, { default: ToolRuntime }] = await Promise.all([
    load("@deepseek-ai/cordis"), load("@deepseek-ai/dsh-scope"), load("@deepseek-ai/dsh-tools"),
  ]);
  const ctx = new Context();
  ctx.provide("systemPrompt");
  ctx.set("systemPrompt", { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 });
  const runtime = new ToolRuntime(ctx, { mode: "ptc" });
  runtime.register({ name: "send_message", description: "Send to parent", parameters: {},
    output: { schema: { type: "object", properties: {} }, render: () => [] }, execute: async () => ({}) });
  const child = { id: "study-child" }, scope = createScope(ctx, child);
  child.ctx = scope.ctx;
  const selection = studyToolMode(ctx, child.id);
  try {
    assert.equal(runtime.modeFor(child), "ptc");
    ctx.emit("agent/created", { agent: { id: "unrelated" } });
    assert.equal(selection.configured(), false);
    ctx.emit("agent/created", { agent: child });
    assert.equal(selection.error(), undefined);
    assert.equal(selection.configured(), true);
    assert.equal(runtime.modeFor(child), "native");
    assert.equal(runtime.modeFor(), "ptc");
    assert.ok(!runtime.schemas(child).some((tool) => tool.name === "run_code"));
    assert.ok(runtime.schemas(child).some((tool) => tool.name === "send_message"));
  } finally { selection.dispose(); await scope.dispose(); }
});

test("communication is detected in the parent agent scope, not the global tool view", async () => {
  const parent = { id: "scoped-parent" };
  let listener, oneShot = 0;
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true }, prepareContinuable() {} }),
    startContinuable: async (spec) => {
      listener({ id: spec.childId, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: '{}' }] });
    },
    sendMessage() {}, drainContinuableChildren() {},
    start: async () => { oneShot++; return { id: "wrong-path", result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: '{}' }] }), dispose() {} }; },
  };
  const ctx = { on: (_n, fn) => { listener = fn; return () => {}; },
    get: (name) => name === "subagents" ? subagents : name === "agents" ? { get: () => parent } :
      name === "tools" ? { get: (_tool, scope) => scope === parent ? {} : undefined } : undefined };
  await runGenerationAgent(ctx, { provider: "p", model: "m" }, parent.id, "system", "prompt",
    { jobId: "job", stage: "Writing", onEvent() {} }, async () => "direct");
  assert.equal(oneShot, 0, "parent-scoped send_message must enable continuable execution");
});

test("continuable phase observes early settlement and unregisters its delivery handle", async () => {
  let listener, removed = 0, messenger;
  const parent = { id: "parent" }, events = [];
  const ctx = { on: (_name, fn) => { listener = fn; return () => removed++; } };
  const subagents = { startContinuable: async (spec) => {
    assert.deepEqual(spec.request.toolFilter.allow, ["send_message"]);
    assert.match(spec.request.prompt[0].text, /parent/);
    listener({ id: "unrelated", stopReason: "error" });
    listener({ id: spec.childId, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: '{"ok":true}' }] });
  } };
  assert.equal(await runContinuablePhase(ctx, subagents, parent, { label: "Study", prompt: [{ text: "Task" }] },
    { onEvent: (e) => events.push(e), setMessenger: (fn) => messenger = fn }), '{"ok":true}');
  assert.equal(removed, 1);
  assert.equal(messenger, null);
  assert.equal(events.at(-1).communication, true);
});

test("continuable phase forwards through the native parent and rejects interrupted output", async () => {
  let listener, spec, messenger, drained = 0;
  const parent = { id: "p" };
  const subagents = {
    startContinuable: async (input) => { spec = input; },
    sendMessage: async (sender, target, content) => {
      assert.equal(sender, parent); assert.equal(target, spec.childId);
      assert.equal(content[0].text, "Use Chinese"); return "receipt";
    },
    drainContinuableChildren: async (sender, ids) => { assert.equal(sender, parent); assert.deepEqual(ids, [spec.childId]); drained++; },
  };
  const pending = runContinuablePhase({ on: (_n, fn) => { listener = fn; return () => {}; } }, subagents, parent,
    { label: "Study", prompt: [{ text: "Task" }] }, { onEvent: () => {}, setMessenger: (fn) => messenger = fn });
  await Promise.resolve();
  assert.equal((await messenger("Use Chinese")).messageId, "receipt");
  listener({ id: spec.childId, stopReason: "cancelled", lastAssistantMessage: [{ type: "text", text: "partial" }] });
  await assert.rejects(pending, /cancelled/);
  assert.equal(drained, 1);
  assert.equal(messenger, null);
});

function fixture(stopReason = "completed") {
  const events = [], parent = { id: "parent" };
  let request, disposed = 0, directCalls = 0;
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true, persona: true } }),
    start: async (provider, input) => {
      assert.equal(provider, "spawn"); request = input;
      return { id: "real-child", result: Promise.resolve({ stopReason, output: [{ type: "text", text: '{"issues":[]}' }] }),
        dispose: async () => { disposed++; } };
    },
  };
  const ctx = { get: (key) => key === "subagents" ? subagents : key === "agents" ? { get: () => parent } : undefined };
  return { ctx, parent, events, request: () => request, disposed: () => disposed, directCalls: () => directCalls,
    run: () => runGenerationAgent(ctx, { provider: "p", model: "m" }, "parent", "Assessment editor", "Evidence", { jobId: "job-123", stage: "Part 1/6 · Reviewing ambiguity and source support", onEvent: (e) => events.push(e) }, async () => { directCalls++; return "direct"; }) };
}

test("generation creates a visible tool-less DSH child and records its real ID", async () => {
  const f = fixture();
  assert.equal(await f.run(), '{"issues":[]}');
  assert.equal(f.request().parent, f.parent);
  assert.deepEqual(f.request().toolFilter, { allow: [] });
  assert.deepEqual(f.request().agentOptions, { provider: "p", model: "m" });
  assert.match(f.request().label, /Study.*Part 1\/6/);
  assert.equal(f.events[0].childId, "real-child");
  assert.equal(f.events.at(-1).status, "complete");
  assert.equal(f.disposed(), 1);
  assert.equal(f.directCalls(), 0);
});

test("interrupted or failed child output cannot be accepted as a completed answer", async () => {
  const f = fixture("error");
  await assert.rejects(f.run(), /subagent error/);
  assert.equal(f.events.at(-1).status, "failed");
  assert.equal(f.disposed(), 1);
  assert.equal(f.directCalls(), 0);
});

test("missing native parent is explicitly identified as direct model execution", async () => {
  const events = [];
  assert.equal(await runGenerationAgent({ get: () => undefined }, { provider: "p", model: "m" }, "parent", "system", "prompt",
    { jobId: "job", stage: "Writing", onEvent: (event) => events.push(event) }, async () => "direct"), "direct");
  assert.equal(events[0].runtime, "direct");
  assert.ok(events[0].note);
  assert.equal(events[0].childId, undefined);
});


test("cancelling an admitted continuable child waits for actual cleanup", async () => {
  const controller = new AbortController();
  let started, release, cleanupStarted, removed = false, settled = false;
  const began = new Promise((resolve) => { started = resolve; });
  const cleanup = new Promise((resolve) => { cleanupStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let childId;
  const pending = runContinuablePhase({ on: () => () => { removed = true; } }, {
    startContinuable: async (spec) => { childId = spec.childId; },
    drainContinuableChildren: async (_parent, ids) => {
      assert.deepEqual(ids, [childId]); cleanupStarted(); await gate;
    },
  }, { id: "parent" }, { label: "Study", prompt: [{ text: "Task" }] }, {
    signal: controller.signal, onEvent: (event) => { if (event.status === "running") started(); },
  });
  pending.catch(() => { settled = true; });
  await began;
  controller.abort(new Error("User cancelled"));
  await cleanup;
  assert.equal(settled, false, "must not report completion while child cleanup is pending");
  release();
  await assert.rejects(pending, /User cancelled/);
  assert.equal(removed, true);
});
