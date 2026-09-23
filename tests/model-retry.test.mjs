import test from "node:test";
import assert from "node:assert/strict";
import { hedgeFirstChunk, isModelFailure, modelFailureMessage, withModelRetry } from "../lib/model-retry.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a light call with no first chunk races a second request and keeps the first answer", async () => {
  const signals = [];
  const text = await hedgeFirstChunk(async (signal, onChunk) => {
    signals.push(signal);
    if (signals.length === 1) {
      // Stalled: never streams, only ends when aborted.
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    onChunk();
    await sleep(5);
    return "second";
  }, { hedgeMs: 20 });
  assert.equal(text, "second");
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true, "the stalled request is cancelled");
});

test("a streaming request is not hedged, and a lone early failure is reported as is", async () => {
  let launches = 0;
  const text = await hedgeFirstChunk(async (_signal, onChunk) => {
    launches++;
    onChunk();
    await sleep(40);
    return "only";
  }, { hedgeMs: 10 });
  assert.equal(text, "only");
  assert.equal(launches, 1);

  launches = 0;
  await assert.rejects(hedgeFirstChunk(async () => {
    launches++;
    throw Object.assign(new Error("boom"), { code: "RATE_LIMIT" });
  }, { hedgeMs: 50 }), { code: "RATE_LIMIT" });
  await sleep(70);
  assert.equal(launches, 1, "a failed request does not also spawn a late hedge");
});

test("timeouts are model failures that are never retried; rate limits are retried", async () => {
  const timeout = Object.assign(new Error("Model timed out after 90s"), { name: "TimeoutError", modelFailure: true });
  let calls = 0;
  await assert.rejects(withModelRetry(async () => { calls++; throw timeout; }, { delays: [1, 1] }), { name: "TimeoutError" });
  assert.equal(calls, 1);
  assert.equal(isModelFailure(timeout), true);
  assert.match(modelFailureMessage(timeout), /请求超时/);

  calls = 0;
  const limited = await withModelRetry(async () => {
    if (++calls < 3) throw Object.assign(new Error("Too many"), { code: "RATE_LIMIT", status: 429 });
    return "ok";
  }, { delays: [1, 1] });
  assert.equal(limited, "ok");
  assert.equal(calls, 3);
  assert.equal(isModelFailure(new SyntaxError("Unexpected token")), false, "a bad reply is correctable, not a model failure");
});

test("modelCompletion reads the stream finish: provider errors keep their code, timeouts say so, stalls hedge", async (t) => {
  let plugin;
  try {
    plugin = await import("../lib/index.js");
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND" && e.message.includes("@deepseek-ai")) return t.skip("Host SDK absent");
    throw e;
  }
  const route = () => ({ provider: "p", model: "m" });
  const ctxWith = (stream) => ({ llm: { resolveModelInfo: async () => ({}), resolveCallConfig: async (c) => c, stream } });
  const textChunks = (text) => [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];

  const limited = plugin.modelCompletion(ctxWith(async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { message: "Too many requests", code: "RATE_LIMIT", status: 429 } } };
  }), route, "s", { light: true, hedgeMs: 1000 });
  await assert.rejects(limited("sys", "p"), (e) => e.code === "RATE_LIMIT" && e.status === 429 && e.modelFailure === true);

  const slow = plugin.modelCompletion(ctxWith(async function* ({ signal }) {
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
    yield { type: "finish", reason: { kind: "aborted", failure: { message: "aborted by caller", code: "ABORTED" } } };
  }), route, "s", { light: true, lightTimeoutMs: 60, hedgeMs: 1000 });
  await assert.rejects(slow("sys", "p"), (e) => e.name === "TimeoutError" && e.modelFailure === true);

  let requests = 0;
  const stalledOnce = plugin.modelCompletion(ctxWith(async function* ({ signal }) {
    if (++requests === 1) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      yield { type: "finish", reason: { kind: "aborted", failure: { message: "aborted", code: "ABORTED" } } };
      return;
    }
    yield* textChunks('{"ok":true}');
  }), route, "s", { light: true, lightTimeoutMs: 5000, hedgeMs: 30 });
  assert.equal(await stalledOnce("sys", "p"), '{"ok":true}');
  assert.equal(requests, 2);
});
