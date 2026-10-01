import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCorrector, RollingCorrection } from '../lib/live-correction.js';
import { runCorrectionAgent } from '../lib/live-correction-agent.js';
import { LiveSession } from '../lib/live.js';
import { GeminiTiers } from '../lib/gemini.js';
import { mergeLiveSnapshot } from '../ui/live-client.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(2); } throw new Error('condition did not become true'); }
const segments = count => Array.from({ length: count }, (_, i) => ({ id: i + 1, en: `Sentence ${i + 1}.`, zh: `句 ${i + 1}`, t: i * 1000, rev: i + 1, zhState: 'done' }));
function fixture(count, complete, extra = {}) {
  const saved = [];
  const correct = makeCorrector({ subject: 'Cloud computing', complete, ...extra });
  const session = new LiveSession({ id: 'correction-test', title: 'Class', tiers: new GeminiTiers({}), correct,
    saved: { segments: segments(count) }, save: async data => { saved.push(structuredClone(data)); } });
  return { session, correction: session.correction, saved };
}
const response = (input, extra = {}) => JSON.stringify({ items: [],
  note: { text: `知识点 ${input.items.at(-1).n}`, refs: [input.items.at(-1).n] },
  memory: { text: '课程摘要', refs: [input.items.at(-1).n] }, followups: [], ...extra });

test('a burst is fully covered by ordered batches with two overlapping sentences, then idle does not call', async () => {
  const calls = [];
  const { correction, saved } = fixture(35, async (_system, prompt, options) => {
    const input = JSON.parse(prompt); calls.push(input); assert.equal(options.task, 'live.correct'); return response(input);
  });
  await correction.run();
  assert.deepEqual(calls.map(call => call.items.map(item => item.n)), [
    [1, 2, 3, 4, 5, 6, 7, 8], [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    [15, 16, 17, 18, 19, 20, 21, 22, 23, 24], [23, 24, 25, 26, 27, 28, 29, 30, 31, 32], [31, 32, 33, 34, 35],
  ]);
  assert.equal(new Set(calls.flatMap(call => call.items.map(item => item.n))).size, 35);
  assert.equal(correction.snapshot().pending, 0);
  assert.equal(calls[1].memory.text, '课程摘要');
  assert.equal(calls[1].recentNotes[0].text, '知识点 8');
  assert.equal(saved.at(-1).correction.coveredThrough, 35);
  await correction.run(); assert.equal(calls.length, 5);
});

test('arrivals during a sweep are handled in the next sweep and stop flushes the tail', async () => {
  const started = gate(), release = gate(); let calls = 0;
  const { session, correction } = fixture(1, async (_system, prompt) => { if (++calls === 1) { started.resolve(); await release.promise; } return response(JSON.parse(prompt)); });
  const first = correction.run(); await started.promise;
  session.segments.push(...segments(5).slice(1));
  assert.equal(correction.run(), first);
  release.resolve(); await first;
  assert.equal(correction.snapshot().pending, 4);
  await correction.finish(); assert.equal(correction.snapshot().covered, 5);
  await session.retirePersistence();
});

test('failed windows keep their cursor; retry succeeds, and late timeout results never apply', async () => {
  let fail = true;
  const { correction } = fixture(19, async (_system, prompt) => {
    const input = JSON.parse(prompt);
    if (input.firstNewId === 9 && fail) throw new Error('temporary failure');
    return response(input);
  });
  await correction.run(); assert.equal(correction.snapshot().covered, 8);
  assert.equal(correction.snapshot().pending, 11); assert.match(correction.error, /temporary/);
  fail = false; await correction.run(); assert.equal(correction.snapshot().covered, 19);
  const release = gate(); let signal;
  const stalled = fixture(1, async (_s, prompt, options) => { signal = options.signal; await release.promise; return response(JSON.parse(prompt), { items: [{ n: 1, text: 'Late edit', zh: '晚到校正', confidence: 'high' }] }); });
  stalled.correction.timeoutMs = 5;
  await stalled.correction.run(); assert.equal(signal.aborted, true);
  release.resolve(); await sleep(5);
  assert.equal(stalled.session.segments[0].en, 'Sentence 1.'); assert.equal(stalled.correction.snapshot().covered, 0);
});

test('correction updates the existing row, persists the original and rejects unknown IDs and uncited notes', async () => {
  const { session, correction } = fixture(1, async (_s, prompt) => response(JSON.parse(prompt), { items: [{ n: 1,
    text: 'The token usage grows quadratically.', zh: 'Token 用量呈平方级增长。', confidence: 'high', reason: '后文提到 n 方。' }] }));
  const before = session.snapshot(); await correction.run();
  const patch = session.snapshot(before.revision), merged = mergeLiveSnapshot(before, patch);
  assert.equal(merged.segments.length, 1);
  assert.equal(merged.segments[0].en, 'The token usage grows quadratically.');
  assert.equal(merged.segments[0].originalEn, 'Sentence 1.');
  assert.match(merged.segments[0].zh, /平方/);
  const restored = new LiveSession({ tiers: new GeminiTiers({}), saved: session.toSaved() });
  assert.equal(restored.correction.snapshot().covered, 1);
  assert.equal(restored.snapshot().segments[0].originalEn, 'Sentence 1.');
  assert.equal(restored.correction.notes.length, 1);
  for (const extra of [{ items: [{ n: 99, text: 'x', zh: 'x', confidence: 'high' }] }, { note: { text: 'Unsupported', refs: [99] } }]) {
    const rejected = fixture(1, async (_s, prompt) => response(JSON.parse(prompt), extra));
    await rejected.correction.run(); assert.equal(rejected.correction.coveredThrough, 0); assert.ok(rejected.correction.error);
  }
});

test('an old in-flight translation cannot overwrite a corrected original or Chinese translation', async () => {
  const release = gate();
  const { session, correction } = fixture(1, async (_s, prompt) => response(JSON.parse(prompt), { items: [{ n: 1, text: 'A partition.', zh: '一个分区。', confidence: 'high' }] }));
  session.segments[0].zhState = 'pending'; session.segments[0].zh = '';
  session.translate = async () => { await release.promise; return new Map([[1, '过期翻译']]); };
  session.translateSoon(); await until(() => session.translating.running);
  await correction.run(); release.resolve(); await session.settled();
  assert.equal(session.segments[0].en, 'A partition.'); assert.equal(session.segments[0].zh, '一个分区。');
});

test('background subagent never blocks batch coverage; a version conflict preserves the newer sentence', async () => {
  const release = gate(), spawned = gate();
  let childPrompt;
  const { session, correction } = fixture(33, async (_s, prompt) => {
    const input = JSON.parse(prompt);
    return response(input, { followups: input.firstNewId === 9 ? [{ ids: [1], reason: 'Later evidence clarifies the first sentence.' }] : [] });
  }, { background: async (_s, prompt) => {
    childPrompt = JSON.parse(prompt); spawned.resolve(); await release.promise;
    return JSON.stringify({ items: [{ n: 1, text: 'Child correction.', zh: '子代理修正。', confidence: 'high' }], note: { text: '修正补记', refs: [1] } });
  } });
  await correction.run(); await spawned.promise;
  assert.equal(correction.snapshot().covered, 33, 'main cursor advances while child is unresolved');
  assert.equal(correction.snapshot().background.running, true);
  assert.deepEqual(childPrompt.items.map(item => item.n), [1]);
  assert.equal(childPrompt.evidence.length, 10);
  session.segments[0].en = 'Newer version.'; session.segments[0].textVersion = 1;
  release.resolve(); await correction.settled();
  assert.equal(session.segments[0].en, 'Newer version.');
  assert.equal(correction.snapshot().background.failed, 1);
  assert.match(correction.tasks[0].error, /旧结果未合并/);
  await correction.retryBackground();
  assert.equal(session.segments[0].en, 'Child correction.');
  assert.equal(correction.notes.at(-1).kind, 'amendment');
});

test('unavailable background correction is visibly retained for retry without blocking batch coverage', async () => {
  let calls = 0;
  const { correction } = fixture(20, async (_s, prompt) => {
    calls++; const input = JSON.parse(prompt);
    return response(input, { followups: input.firstNewId === 9 ? [{ ids: [1], reason: 'Check old ambiguity.' }] : [] });
  });
  await correction.run(); await correction.settled();
  assert.equal(calls, 3); assert.equal(correction.coveredThrough, 20);
  assert.equal(correction.tasks[0].status, 'failed'); assert.match(correction.tasks[0].error, /没有可用的后台校正模型/);
  const restored = new RollingCorrection(correction.session, undefined, { saved: correction.saved() });
  assert.equal(restored.tasks[0].status, 'failed'); assert.equal(restored.coveredThrough, 20);
});

test('native child uses a tool-free independent spawn with low or default reasoning, never parent high', async () => {
  let request, disposed = 0;
  const ctx = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }) },
    get: name => name === 'agents' ? { get: () => ({ id: 'parent' }) } : {
      getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true, persona: true } }),
      start: async (kind, value) => { assert.equal(kind, 'spawn'); request = value; return { result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{}' }] }), dispose: async () => { disposed++; } }; },
    } };
  const route = { provider: 'provider', model: 'fast', reasoningEffort: 'high' };
  await runCorrectionAgent(ctx, route, 'parent', 'system', 'prompt');
  assert.equal(request.agentOptions.reasoningEffort, 'low'); assert.deepEqual(request.toolFilter.allow, []);
  await runCorrectionAgent(ctx, route, 'parent', 'system', 'prompt', { reasoningEffort: 'default' });
  assert.equal(request.agentOptions.reasoningEffort, undefined); assert.equal(disposed, 2);
  const controller = new AbortController();
  const originalGet = ctx.get;
  ctx.get = name => name === 'agents' ? originalGet(name) : { ...originalGet(name),
    start: async () => ({ result: new Promise(() => {}), dispose: async () => { disposed++; } }) };
  const pending = runCorrectionAgent(ctx, route, 'parent', 's', 'p', { signal: controller.signal });
  await sleep(1); controller.abort(new Error('stop child'));
  await assert.rejects(pending, /stop child/); assert.equal(disposed, 3);
  await assert.rejects(runCorrectionAgent({ get: () => undefined }, route, 'parent', '', ''), /没有可用的子代理/);
});
