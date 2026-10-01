import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionUsage } from '../lib/token-usage.js';
import { withUsageSink } from '../lib/usage-scope.js';
import { runGenerationAgent } from '../lib/generation-agent.js';

// WP27: what the model paths report. A direct call reports the provider's usage
// chunk; a DSH sub-agent (a generation child) reports its session's usage
// projection, or our mirror of its fold; neither is ever allowed to break the call.
const buckets = (uncachedInputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) =>
  ({ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const collect = () => {
  const reports = [];
  return { reports, entry: { key: 'test', sink: (usage, meta) => reports.push({ usage, meta }) } };
};
const textChunks = (text, usage) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  ...(usage ? [{ type: 'usage', usage }] : []),
  { type: 'finish', reason: { kind: 'stop' } },
];
const route = () => ({ provider: 'p', model: 'm' });
const ctxWith = (stream) => ({ llm: { resolveModelInfo: async () => ({}), resolveCallConfig: async (config) => config, stream } });
async function modelCompletion(t) {
  try { return (await import('../lib/index.js')).modelCompletion; }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai')) return t.skip('Host SDK absent');
    throw error;
  }
}

test('a direct call reports the provider usage; reasoning stays inside the output', async (t) => {
  const completion = await modelCompletion(t);
  if (!completion) return;
  const { reports, entry } = collect();
  const complete = completion(ctxWith(async function* () {
    yield* textChunks('{"ok":true}', { inputTokens: 120, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 30, reasoningTokens: 25, totalTokens: 990 });
  }), route, 's');
  const reply = await withUsageSink(entry, () => complete('system', 'prompt'), { feature: 'coach' });
  assert.equal(reply, '{"ok":true}');
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].usage, buckets(120, 40, 800, 30), 'output is 40, not 40 + 25 reasoning');
  assert.equal(reports[0].meta.calls, 1);
  assert.equal(reports[0].meta.feature, 'coach');
});

test('a call without a usage chunk reports nothing, and a sink that throws changes nothing', async (t) => {
  const completion = await modelCompletion(t);
  if (!completion) return;
  const silent = collect();
  const plain = completion(ctxWith(async function* () { yield* textChunks('hi'); }), route, 's');
  assert.equal(await withUsageSink(silent.entry, () => plain('s', 'p')), 'hi');
  assert.deepEqual(silent.reports, []);
  const loud = completion(ctxWith(async function* () { yield* textChunks('hi', { inputTokens: 1, outputTokens: 1 }); }), route, 's');
  const broken = { key: 'broken', sink: () => { throw new Error('ledger on fire'); } };
  assert.equal(await withUsageSink(broken, () => loud('s', 'p')), 'hi');
  // Usage reported by a call with no scope at all is simply dropped.
  assert.equal(await loud('s', 'p'), 'hi');
});

test('a failed stream that still billed tokens is reported before the error surfaces', async (t) => {
  const completion = await modelCompletion(t);
  if (!completion) return;
  const { reports, entry } = collect();
  const complete = completion(ctxWith(async function* () {
    yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'overloaded', code: 'OVERLOADED', status: 503 } } };
  }), route, 's');
  await assert.rejects(withUsageSink(entry, () => complete('s', 'p')), (error) => error.code === 'OVERLOADED');
  assert.deepEqual(reports.map((item) => item.usage), [buckets(50, 2)]);
});

test('a hedged light call counts the attempts that reported usage', async (t) => {
  const completion = await modelCompletion(t);
  if (!completion) return;
  const { reports, entry } = collect();
  let requests = 0;
  const complete = completion(ctxWith(async function* ({ signal }) {
    if (++requests === 1) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } };
      return;
    }
    yield* textChunks('{"ok":true}', { inputTokens: 10, outputTokens: 4 });
  }), route, 's', { light: true, lightTimeoutMs: 5000, hedgeMs: 30 });
  assert.equal(await withUsageSink(entry, () => complete('s', 'p')), '{"ok":true}');
  assert.equal(requests, 2);
  assert.deepEqual(reports.map((item) => item.usage), [buckets(10, 4)], 'the stalled attempt reported nothing');
});

test('a generation phase on the direct path reports once, through the model call', async (t) => {
  const completion = await modelCompletion(t);
  if (!completion) return;
  const { reports, entry } = collect();
  const complete = completion(ctxWith(async function* () { yield* textChunks('{"plan":1}', { inputTokens: 300, outputTokens: 60, cacheReadTokens: 100 }); }), route, 's');
  const events = [];
  const reply = await withUsageSink(entry, () => complete('system', 'prompt', { jobId: 'job-1', stage: 'Planning', onEvent: (event) => events.push(event) }));
  assert.equal(reply, '{"plan":1}');
  assert.deepEqual(reports.map((item) => item.usage), [buckets(300, 60, 100)], 'runGenerationAgent falls back to direct(); nothing is counted twice');
});

test('a session usage read prefers the host projection and falls back to the mirrored fold', async () => {
  const event = (turn, step, usage) => ({ type: 'assistant/message', data: { turn, step, message: {}, stream: [], usage } });
  let disposed = 0;
  const observe = (observation) => ({ observeSession: async (id, options) => { assert.equal(id, 'child-1'); void options; return { ...observation, [Symbol.dispose]: () => { disposed++; } }; } });
  const projected = await readSessionUsage(observe({ events: [event(0, 0, { inputTokens: 1, outputTokens: 1 })],
    projections: { values: { tokenUsage: buckets(500, 70, 4000, 0) } } }), 'child-1');
  assert.deepEqual(projected, { usage: buckets(500, 70, 4000, 0), requests: 1 });
  const folded = await readSessionUsage(observe({ events: [event(0, 0, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 }), event(0, 1, { inputTokens: 40, outputTokens: 5 })] }), 'child-1');
  assert.deepEqual(folded, { usage: buckets(140, 15, 50, 0), requests: 2 });
  const malformed = await readSessionUsage(observe({ events: [event(0, 0, { inputTokens: 7, outputTokens: 3 })], projections: { values: { tokenUsage: { outputTokens: 'x' } } } }), 'child-1');
  assert.deepEqual(malformed.usage, buckets(7, 3), 'a projection that is not whole numbers is not trusted');
  assert.equal(disposed, 3, 'every observation lease is released');
  assert.equal(await readSessionUsage({ observeSession: async () => { throw new Error('gone'); } }, 'child-1'), null);
  assert.equal(await readSessionUsage(undefined, 'child-1'), null);
  assert.equal(await readSessionUsage(observe({}), ''), null);
});

const childHarness = ({ childUsage, startContinuable = false }) => {
  const parent = { id: 'learner' }, output = '{"ok":true}';
  let listener;
  const observed = [];
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true }, prepareContinuable() {} }),
    startContinuable: async (spec) => { listener({ id: spec.childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: output }] }); },
    sendMessage() {}, drainContinuableChildren() {},
    start: async () => ({ id: 'child-run', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: output }] }), dispose: async () => {} }),
  };
  const sessionQuery = { observeSession: async (id) => { observed.push(id); return { events: [], projections: { values: { tokenUsage: childUsage } }, [Symbol.dispose]() {} }; } };
  const ctx = { on: (_event, fn) => { listener = fn; return () => {}; },
    get: (key) => key === 'subagents' ? subagents : key === 'agents' ? { get: () => parent } : key === 'sessionQuery' ? sessionQuery
      : key === 'tools' ? { get: () => (startContinuable ? {} : undefined) } : undefined };
  return { ctx, parent, observed, output };
};

test('a one-shot generation child reports its session usage', async () => {
  const { reports, entry } = collect();
  const { ctx, parent, observed, output } = childHarness({ childUsage: buckets(900, 250, 6000, 0) });
  const result = await withUsageSink(entry, () => runGenerationAgent(ctx, { provider: 'p', model: 'm' }, parent.id, 'system', 'prompt',
    { jobId: 'job-1', stage: 'Authoring', resultOwner: 'plugin', onEvent() {} }, () => { throw new Error('no direct call expected'); }), { feature: 'generate' });
  assert.equal(result, output);
  assert.deepEqual(observed, ['child-run']);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].usage, buckets(900, 250, 6000, 0));
  assert.equal(reports[0].meta.feature, 'generate');
  assert.ok(reports[0].meta.calls >= 1);
});

test('a continuable generation child reports its session usage too', async () => {
  const { reports, entry } = collect();
  const { ctx, parent, observed } = childHarness({ childUsage: buckets(10, 20, 30, 40), startContinuable: true });
  await withUsageSink(entry, () => runGenerationAgent(ctx, { provider: 'p', model: 'm' }, parent.id, 'system', 'prompt',
    { jobId: 'job-2', stage: 'Reviewing', onEvent() {}, setMessenger() {} }, () => { throw new Error('no direct call expected'); }));
  assert.equal(observed.length, 1);
  assert.notEqual(observed[0], 'child-run', 'the reserved continuable child id is read');
  assert.deepEqual(reports.map((item) => item.usage), [buckets(10, 20, 30, 40)]);
});

test('an unreadable child session loses the count, never the result', async () => {
  const { reports, entry } = collect();
  const { ctx, parent, output } = childHarness({ childUsage: undefined });
  ctx.get = ((original) => (key) => key === 'sessionQuery' ? { observeSession: async () => { throw new Error('session store busy'); } } : original(key))(ctx.get);
  const result = await withUsageSink(entry, () => runGenerationAgent(ctx, { provider: 'p', model: 'm' }, parent.id, 'system', 'prompt',
    { jobId: 'job-3', stage: 'Authoring', resultOwner: 'plugin', onEvent() {} }, () => { throw new Error('no direct call expected'); }));
  assert.equal(result, output);
  assert.deepEqual(reports, []);
});

test('a failing child still reports what it used before it failed', async () => {
  const { reports, entry } = collect();
  const { ctx, parent } = childHarness({ childUsage: buckets(5, 5) });
  const subagents = ctx.get('subagents');
  subagents.start = async () => ({ id: 'child-run', result: Promise.resolve({ stopReason: 'error', output: [], diagnostic: 'overloaded' }), dispose: async () => {} });
  await assert.rejects(withUsageSink(entry, () => runGenerationAgent(ctx, { provider: 'p', model: 'm' }, parent.id, 'system', 'prompt',
    { jobId: 'job-4', stage: 'Authoring', resultOwner: 'plugin', onEvent() {} }, () => 'direct')), /overloaded/);
  assert.deepEqual(reports.map((item) => item.usage), [buckets(5, 5)], 'a billed failed attempt counts');
});
