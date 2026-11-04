import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCorrector, RollingCorrection } from '../lib/live-correction.js';
import { LIVE_CORRECTION, correctionBudget } from '../lib/live-correction-settings.js';
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
    await rejected.correction.run(); assert.ok(rejected.correction.error);
    // A reply that is malformed twice is not asked a third time: the sentence is skipped with its text untouched, and the learner can retry it.
    assert.equal(rejected.correction.snapshot().skipped, 1); assert.equal(rejected.session.segments[0].en, 'Sentence 1.');
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

// ---- Long sentences: character budgets, scaled requests, no endless identical retries ----
const sized = lengths => lengths.map((length, i) => ({ id: i + 1, en: `S${i + 1} ${'a'.repeat(length)}`, zh: `句 ${i + 1}`, t: i * 1000, rev: i + 1, zhState: 'done' }));
function sizedFixture(lengths, complete, extra = {}) {
  const { session: sessionExtra, ...modelExtra } = extra;
  const correct = makeCorrector({ subject: 'Cloud computing', complete, ...modelExtra });
  const session = new LiveSession({ id: 'long-correction-test', title: 'Class', tiers: new GeminiTiers({}), correct,
    saved: { segments: sized(lengths) }, save: async () => {}, ...(sessionExtra || {}) });
  return { session, correction: session.correction, correct };
}
const timeoutError = () => Object.assign(new Error('Model timed out after 20s'), { name: 'TimeoutError' });
const ids = input => input.items.map(item => item.n);
// Sentence 1 is never edited, so it stays long and keeps being read-only context for the sentences after it.
const fix = (input, n) => n === 1 ? response(input) : response(input, { items: [{ n, text: `Fixed ${n}`, zh: `修正 ${n}`, confidence: 'high', reason: 'term' }] });
const size = lengths => lengths.reduce((total, length, i) => total + `S${i + 1} `.length + length, 0);

test('correctionBudget grows with the characters asked about and stays within its caps', () => {
  const short = correctionBudget(80), single = correctionBudget(700), huge = correctionBudget(50_000);
  assert.equal(short.timeoutMs >= LIVE_CORRECTION.requestMs, true); assert.equal(short.maxOutputTokens >= LIVE_CORRECTION.maxTokens, true);
  assert.ok(single.timeoutMs > short.timeoutMs); assert.ok(single.maxOutputTokens > short.maxOutputTokens);
  assert.equal(correctionBudget(0).timeoutMs, LIVE_CORRECTION.requestMs); assert.equal(correctionBudget(0).maxOutputTokens, LIVE_CORRECTION.maxTokens);
  assert.deepEqual(huge, { timeoutMs: 60_000, maxOutputTokens: 8192 });
  const background = correctionBudget(700, { background: true });
  assert.ok(background.timeoutMs >= LIVE_CORRECTION.backgroundMs); assert.equal(correctionBudget(50_000, { background: true }).timeoutMs, 120_000);
});

test('eight short sentences are still one request; long sentences are batched by characters', async () => {
  const calls = [];
  const short = sizedFixture(Array(8).fill(10), async (_s, prompt) => { const input = JSON.parse(prompt); calls.push(input); return response(input); });
  await short.correction.run();
  assert.equal(calls.length, 1); assert.deepEqual(ids(calls[0]), [1, 2, 3, 4, 5, 6, 7, 8]); assert.equal(calls[0].before, undefined);
  calls.length = 0;
  // 500 + 500 fit the 1200-character budget, the third 500 does not.
  const mixed = sizedFixture([500, 500, 500], async (_s, prompt) => { const input = JSON.parse(prompt); calls.push(input); return response(input); });
  await mixed.correction.run();
  assert.deepEqual(calls.map(ids), [[1, 2], [3]]); assert.equal(mixed.correction.coveredThrough, 3);
});

test('three 700-character sentences are three single-sentence requests with the earlier one only as read-only context', async () => {
  const calls = [];
  const { correction, session } = sizedFixture([700, 700, 700], async (_s, prompt) => { const input = JSON.parse(prompt); calls.push(input); return response(input); });
  await correction.run();
  assert.deepEqual(calls.map(ids), [[1], [2], [3]]);
  assert.equal(calls[0].before, undefined);
  for (const [i, call] of [[1, calls[1]], [2, calls[2]]]) {
    assert.equal(call.before.length, 1); assert.equal(call.before[0].n, i);
    assert.equal(call.before[0].text.length, LIVE_CORRECTION.overlapChars);
    assert.equal(call.before[0].text, session.segments[i - 1].en.slice(-LIVE_CORRECTION.overlapChars));
  }
  assert.equal(calls[0].firstNewId, 1); assert.equal(calls[1].firstNewId, 2);
  // The stable prefix still comes first, the moving window last.
  assert.deepEqual(Object.keys(calls[1]).slice(0, 2), ['subject', 'terms']); assert.equal(Object.keys(calls[1]).at(-1), 'items');
  assert.equal(correction.snapshot().calls, 3);
});

test('short earlier sentences still ride along as editable overlap, within the character budget', async () => {
  const calls = [];
  const { correction } = sizedFixture([100, 100, 100, 100, 700], async (_s, prompt) => { const input = JSON.parse(prompt); calls.push(input); return response(input); });
  await correction.run();
  assert.deepEqual(calls.map(ids), [[1, 2, 3, 4, 5]]);
  calls.length = 0;
  const many = sizedFixture(Array(16).fill(100), async (_s, prompt) => { const input = JSON.parse(prompt); calls.push(input); return response(input); });
  await many.correction.run();
  // 16 sentences of ~104 characters: 8 new at a time (count bound), 2 earlier ones (208 <= 300 characters) as editable overlap.
  assert.deepEqual(calls.map(ids), [[1, 2, 3, 4, 5, 6, 7, 8], [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]]);
});

test('each request is allowed time and tokens in proportion to its characters', async () => {
  const seen = [];
  const { correction } = sizedFixture([20, 700], async (_s, prompt, options) => { const input = JSON.parse(prompt); seen.push({ n: ids(input), ...options }); return response(input); });
  await correction.run();
  assert.equal(seen.length, 1, 'both fit one 1200-character batch');
  assert.deepEqual({ timeoutMs: seen[0].timeoutMs, maxOutputTokens: seen[0].maxOutputTokens }, correctionBudget(size([20, 700])));
  const lone = sizedFixture([900, 900], async (_s, prompt, options) => { const input = JSON.parse(prompt); seen.push({ n: ids(input), ...options }); return response(input); });
  seen.length = 0; await lone.correction.run();
  assert.equal(seen.length, 2);
  assert.ok(seen[0].timeoutMs > LIVE_CORRECTION.requestMs); assert.ok(seen[0].maxOutputTokens > LIVE_CORRECTION.maxTokens);
  assert.ok(seen[0].maxOutputTokens <= 8192 && seen[0].timeoutMs <= 60_000);
});

test('without a driver the request is stopped at the scaled time, not at the fixed 20 seconds', async () => {
  const { correction } = sizedFixture([700], async () => '');
  let asked = 0;
  correction.ask = (_work, ms) => { asked = ms; return Promise.reject(timeoutError()); };
  await correction.run();
  assert.equal(asked, correctionBudget(size([700])).timeoutMs);
  assert.ok(asked > LIVE_CORRECTION.requestMs);
});

test('a single long sentence that times out is tried twice, skipped, and the next sentences are still corrected', async () => {
  const calls = [];
  const { session, correction } = sizedFixture([700, 700, 700], async (_s, prompt) => {
    const input = JSON.parse(prompt); calls.push(ids(input));
    if (input.items.some(item => item.n === 2)) throw timeoutError();
    return fix(input, input.items.at(-1).n);
  });
  await correction.run();
  assert.deepEqual(calls, [[1], [2], [2], [3]]);
  const snapshot = correction.snapshot();
  assert.equal(snapshot.calls, 4, 'calls equal the requests actually sent');
  assert.equal(snapshot.covered, 2); assert.equal(snapshot.pending, 0); assert.equal(snapshot.skipped, 1); assert.equal(snapshot.coveredThrough, 3); assert.deepEqual(snapshot.skippedIds, [2]);
  assert.match(snapshot.skippedItems[0].reason, /超时/);
  assert.equal(session.segments[1].en.startsWith('S2 a'), true, 'the skipped sentence keeps its uncorrected text');
  assert.equal(session.segments[0].en.startsWith('S1 a'), true); assert.equal(session.segments[2].en, 'Fixed 3');
  assert.match(snapshot.error, /有 1 句太长，润色超时，已跳过（原文保留）；可点『重试待校正内容』再试。/);
  await correction.run(); assert.equal(correction.snapshot().calls, 4, 'nothing is asked again on the next interval');
  assert.match(correction.snapshot().error, /已跳过/, 'the skipped note survives an idle interval');
});

test('a failing batch is retried once with half the characters, then the smaller size is kept for the pass', async () => {
  const calls = [];
  const { correction } = sizedFixture([295, 295, 295, 295], async (_s, prompt) => {
    const input = JSON.parse(prompt); calls.push(ids(input));
    if (input.items.length >= 3 && input.firstNewId === 1) throw timeoutError();
    return response(input);
  });
  await correction.run();
  assert.deepEqual(calls[0], [1, 2, 3, 4]); assert.deepEqual(calls[1], [1, 2]);
  assert.equal(correction.coveredThrough, 4); assert.equal(correction.snapshot().skipped, 0); assert.equal(correction.error, '');
  assert.equal(correction.snapshot().calls, calls.length);
});

test('sentences that keep failing in a row stop the pass instead of burning one request after another', async () => {
  let calls = 0;
  const { correction } = sizedFixture([700, 700, 700, 700, 700], async () => { calls++; throw timeoutError(); });
  await correction.run();
  assert.equal(calls, LIVE_CORRECTION.skipStreak * 2);
  assert.equal(correction.snapshot().skipped, LIVE_CORRECTION.skipStreak); assert.equal(correction.coveredThrough, LIVE_CORRECTION.skipStreak);
  await correction.run(); assert.equal(calls, LIVE_CORRECTION.skipStreak * 2, 'it waits for the learner');
  assert.match(correction.error, /已暂停/);
});

test('a transient failure is retried on later intervals at most three times, then waits for the learner', async () => {
  let calls = 0, healthy = false;
  const { correction } = sizedFixture([10, 10], async (_s, prompt) => {
    calls++; if (!healthy) throw Object.assign(new Error('fetch failed'), { status: 503 });
    return response(JSON.parse(prompt));
  });
  for (let i = 0; i < 5; i++) await correction.run();
  assert.equal(calls, LIVE_CORRECTION.transientAttempts); assert.equal(correction.coveredThrough, 0);
  assert.equal(correction.snapshot().skipped, 0, 'a transient failure never skips a sentence');
  assert.match(correction.error, /fetch failed/); assert.match(correction.error, /重试待校正内容/);
  healthy = true; await correction.run(); assert.equal(calls, LIVE_CORRECTION.transientAttempts, 'still waiting for the learner');
  await correction.retry(); assert.equal(calls, LIVE_CORRECTION.transientAttempts + 1);
  assert.equal(correction.coveredThrough, 2); assert.equal(correction.error, '');
});

test('the learner\'s retry asks for the skipped sentences exactly', async () => {
  let healthy = false; const calls = [];
  const { session, correction } = sizedFixture([700, 700, 700], async (_s, prompt) => {
    const input = JSON.parse(prompt); calls.push(ids(input));
    if (!healthy && input.items.some(item => item.n === 2)) throw timeoutError();
    return fix(input, input.firstNewId);
  });
  await correction.run(); assert.equal(correction.snapshot().skipped, 1);
  const before = calls.length; healthy = true;
  await correction.retry();
  assert.deepEqual(calls.slice(before), [[2]]);
  assert.equal(session.segments[1].en, 'Fixed 2'); assert.equal(correction.snapshot().skipped, 0); assert.equal(correction.error, '');
  assert.equal(correction.coveredThrough, 3, 'the cursor never moves back');
  const failing = sizedFixture([700], async () => { throw timeoutError(); });
  await failing.correction.run(); await failing.correction.retry();
  assert.equal(failing.correction.snapshot().skipped, 1, 'a sentence that still fails stays skipped');
  const restored = new RollingCorrection(failing.session, failing.correct, { saved: failing.correction.saved() });
  assert.deepEqual(restored.snapshot().skippedIds, [1]);
});

test('a driven correction follows the same budgets and skip rules', async () => {
  const controller = new AbortController(), seen = [];
  const { correction, correct } = sizedFixture([700, 700], async (_s, prompt, options) => {
    const input = JSON.parse(prompt); seen.push({ n: ids(input), ...options });
    if (input.items.some(item => item.n === 1)) throw timeoutError();
    return response(input);
  }, { session: { managedCorrection: true } });
  assert.equal(correction.managed, true);
  await correction.serve({ correct, signal: controller.signal });
  assert.deepEqual(seen.map(call => call.n), [[1], [1], [2]]);
  assert.ok(seen.every(call => call.timeoutMs > LIVE_CORRECTION.requestMs && call.maxOutputTokens > LIVE_CORRECTION.maxTokens));
  assert.equal(correction.snapshot().skipped, 1); assert.equal(correction.coveredThrough, 2);
});

test('a background request is allowed time in proportion to what it rereads', async () => {
  let childOptions;
  const { correction } = sizedFixture([700, 700], async (_s, prompt) => response(JSON.parse(prompt), { followups: [] }), {
    background: async (_s, _prompt, options) => { childOptions = options; return JSON.stringify({ items: [], note: { text: '', refs: [] } }); } });
  correction.enqueue({ ids: [1], reason: 'Check old ambiguity.' }, [2]);
  await correction.settled();
  assert.equal(correction.tasks[0].status, 'done');
  assert.deepEqual({ timeoutMs: childOptions.timeoutMs, maxOutputTokens: childOptions.maxOutputTokens }, correctionBudget(size([700, 700]), { background: true }));
});
