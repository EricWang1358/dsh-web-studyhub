import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WP27: token accounting that follows DSH's own model. The four buckets, the
// replay fold and the display helpers below mirror @deepseek-ai/dsh-token-meter
// (usage-projection) and @deepseek-ai/dsh-client-ui-chat (token-format) of DSH
// 0.2.0-rc.2. Every expected number was produced by running DSH's own code.
const usage = await import('../lib/token-usage.js');
const scope = await import('../lib/usage-scope.js');
const ledgerModule = await import('../lib/model-usage.js');

const u = (inputTokens, outputTokens, extra = {}) => ({ inputTokens, outputTokens, ...extra });
const chunkStream = (value) => [{ type: 'chunk', chunk: { type: 'usage', usage: value } }];
const message = (turn, step, value, viaStream = false) => ({ type: 'assistant/message',
  data: { turn, step, message: {}, stream: viaStream ? chunkStream(value) : [], ...(viaStream ? {} : { usage: value }) } });
const attempt = (turn, step, value) => ({ type: 'assistant/attempt', data: { turn, step, stream: chunkStream(value) } });
const retryStarted = (turn, step) => ({ type: 'llm/retry-started', data: { turn, step } });
const buckets = (uncachedInputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) =>
  ({ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const tmp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wp27-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('a provider TokenUsage becomes DSH buckets; reasoning stays inside the output', () => {
  assert.deepEqual(usage.usageFromTokenUsage(u(100, 20, { cacheReadTokens: 900, cacheWriteTokens: 5, reasoningTokens: 12, totalTokens: 1025 })),
    buckets(100, 20, 900, 5), 'reasoning tokens are part of outputTokens already and are not added again');
  assert.deepEqual(usage.usageFromTokenUsage(u(7, 3)), buckets(7, 3), 'missing cache fields are zero');
  assert.equal(usage.usageFromTokenUsage(undefined), null);
  assert.equal(usage.usageFromTokenUsage(u(-1, 3)), null, 'a negative count is not usage');
  assert.equal(usage.usageFromTokenUsage(u(Number.NaN, 3)), null);
  assert.equal(usage.usageFromTokenUsage(u(1.5, 3)), null, 'counts are whole tokens');
  assert.equal(usage.usageFromTokenUsage({ outputTokens: 3 }), null, 'input is required');
});

test('the replay fold matches DSH tokenUsage projection on every scenario', () => {
  const cases = {
    twoSteps: [[message(0, 0, u(100, 20, { cacheReadTokens: 900 })), message(0, 1, u(50, 10, { cacheWriteTokens: 300, cacheReadTokens: 100, reasoningTokens: 4 }))], buckets(150, 30, 1000, 300)],
    viaStream: [[message(0, 0, u(70, 30), true)], buckets(70, 30)],
    retryAdds: [[attempt(0, 0, u(40, 5)), retryStarted(0, 0), message(0, 0, u(40, 25, { cacheReadTokens: 10 }))], buckets(80, 30, 10)],
    replacesWithoutRetry: [[attempt(0, 0, u(40, 5)), message(0, 0, u(40, 25))], buckets(40, 25)],
    noUsage: [[{ type: 'assistant/message', data: { turn: 0, step: 0, message: {}, stream: [] } }, { type: 'user/message', data: {} }], buckets(0, 0)],
    otherEvents: [[{ type: 'turn/start', data: { turn: 0 } }, message(0, 0, u(1, 2)), { type: 'step/end', data: { turn: 0, step: 0 } }], buckets(1, 2)],
  };
  for (const [name, [events, expected]] of Object.entries(cases))
    assert.deepEqual(usage.foldUsageEvents(events).totals, expected, name);
  assert.equal(usage.foldUsageEvents(cases.twoSteps[0]).requests, 2);
  assert.equal(usage.foldUsageEvents(cases.retryAdds[0]).requests, 2, 'a retried attempt is a second billed request');
  assert.equal(usage.foldUsageEvents(cases.replacesWithoutRetry[0]).requests, 1);
  assert.deepEqual(usage.foldUsageEvents(undefined).totals, buckets(0, 0), 'no events, no usage');
});

test('Token 用量 is the sum of the four buckets, as in the DSH session panel', () => {
  const session = buckets(81139, 24266, 1758854, 247421);
  assert.equal(usage.promptTokens(session), 2087414);
  assert.equal(usage.totalTokens(session), 2111680);
  assert.equal(usage.cacheHitPercent(session), '84');
  assert.equal(usage.cacheHitPercent(buckets(0, 50)), null, 'no input, no hit rate');
  assert.deepEqual(usage.addUsage({ ...buckets(1, 2, 3, 4), calls: 2 }, { ...buckets(10, 20, 30, 40), calls: 1 }), { ...buckets(11, 22, 33, 44), calls: 3 });
  assert.deepEqual(usage.addUsage(undefined, buckets(1, 2)), { ...buckets(1, 2), calls: 0 });
});

test('number and cache-hit formatting is byte for byte DSH', () => {
  const compact = [[0, '0'], [7, '7'], [999, '999'], [1000, '1K'], [1049, '1K'], [1050, '1.1K'], [12200, '12.2K'], [99999, '100K'], [100000, '100K'],
    [517000, '517K'], [999999, '1000K'], [1000000, '1M'], [1234567, '1.2M'], [12345678, '12.3M']];
  for (const [n, text] of compact) assert.equal(usage.formatCompactTokens(n), text, `compact ${n}`);
  const exact = [[0, '0'], [5, '5'], [999, '999'], [1000, '1,000'], [81139, '81,139'], [1758854, '1,758,854'], [2111680, '2,111,680']];
  for (const [n, text] of exact) assert.equal(usage.formatExactTokens(n), text, `exact ${n}`);
  const hits = [[0, 0, 0, null], [0, 100, 0, '0'], [1758854, 2087414, 0, '84'], [996, 1000, 0, '99.6'], [999999, 1000000, 0, '99.9999'],
    [1000, 1000, 0, '100'], [1, 3, 0, '33'], [1, 3, 1, '33.3'], [5, 8, 0, '63'], [995, 1000, 0, '99.5'], [9995, 10000, 0, '99.95'],
    [99999999, 100000000, 0, '99.999999'], [500, 1000, 1, '50']];
  for (const [read, prompt, places, text] of hits) assert.equal(usage.formatCacheHitPercent(read, prompt, places), text, `hit ${read}/${prompt}`);
});

test('usage scopes chain, deduplicate by key and never let a sink break the caller', async () => {
  const seen = [];
  const result = await scope.withUsageSink({ key: 'a', sink: (value, meta) => seen.push(['a', value, meta.feature]) }, async () => {
    await Promise.resolve();
    return scope.withUsageSink({ key: 'b', sink: (value) => seen.push(['b', value]) }, async () => {
      // The same key again (a model wrapped twice) must count once.
      await scope.withUsageSink({ key: 'a', sink: () => seen.push(['dup']) }, async () => scope.reportUsage(buckets(1, 2), { calls: 1 }));
      return 'done';
    }, { feature: 'case' });
  }, { feature: 'generate' });
  assert.equal(result, 'done');
  assert.deepEqual(seen, [['a', buckets(1, 2), 'case'], ['b', buckets(1, 2)]], 'the inner feature wins and each sink runs once');
  assert.doesNotThrow(() => scope.reportUsage(buckets(1, 2)), 'no scope, nothing happens');
  await scope.withUsageSink({ key: 'bad', sink: () => { throw new Error('disk full'); } }, async () => {
    assert.doesNotThrow(() => scope.reportUsage(buckets(1, 2)));
  });
  await scope.withUsageSink({ key: 'rejects', sink: () => Promise.reject(new Error('later')) }, async () => {
    assert.doesNotThrow(() => scope.reportUsage(buckets(1, 2)));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(scope.reportUsage(null), undefined, 'empty usage is ignored');
});

test('the feature a caller names beats the default of the model wrapper that runs inside it', async () => {
  const seen = [];
  const entry = { key: 'a', sink: (_usage, meta) => seen.push(meta.feature) };
  // The wrapper of a model (innermost) only supplies a default; the caller that knows what the work is for decides.
  await scope.withUsageSink({ key: 'caller', sink: () => {} }, () => scope.withUsageSink(entry, async () => scope.reportUsage(buckets(1, 1)), { fallback: 'generate' }), { feature: 'case' });
  await scope.withUsageSink(entry, async () => scope.reportUsage(buckets(1, 1)), { fallback: 'coach' });
  await scope.withUsageSink({ key: 'outer', sink: () => {} }, () => scope.withUsageSink(entry, async () => scope.reportUsage(buckets(1, 1)), { fallback: 'flow' }));
  assert.deepEqual(seen, ['case', 'coach', 'flow']);
});

test('a job usage sink adds every report to the job and its step', () => {
  const job = {}, step = {};
  const sink = usage.jobUsageSink(job, step);
  sink(buckets(10, 5, 100), { calls: 1 });
  sink(buckets(1, 1), { calls: 2 });
  assert.deepEqual(job.tokenUsage, { ...buckets(11, 6, 100), calls: 3 });
  assert.deepEqual(step.tokenUsage, { ...buckets(11, 6, 100), calls: 3 });
});

test('the ledger records per day and feature, stays bounded and survives damage', async (t) => {
  const root = await tmp(t);
  const day = (iso) => Date.parse(`${iso}T12:00:00`);
  const ledger = ledgerModule.createUsageLedger(root, { now: () => day('2026-10-02') });
  await ledger.record({ feature: 'generate', usage: buckets(100, 10, 50), at: day('2026-10-02') });
  await ledger.record({ feature: 'generate', usage: buckets(20, 5), at: day('2026-10-02') });
  await ledger.record({ feature: 'coach', usage: buckets(3, 1), at: day('2026-09-30') });
  await ledger.record({ feature: 'audio', usage: buckets(500, 400), at: day('2026-08-20') });
  const week = await ledger.summary({ days: 7 });
  assert.deepEqual(week.byFeature.generate, { ...buckets(120, 15, 50), calls: 2 });
  assert.deepEqual(week.byFeature.coach, { ...buckets(3, 1), calls: 1 });
  assert.equal(week.byFeature.audio, undefined, 'older than the window');
  assert.deepEqual(week.total, { ...buckets(123, 16, 50), calls: 3 });
  const month = await ledger.summary({ days: 30 });
  assert.equal(month.byFeature.audio, undefined, '43 days ago is outside 30 days');
  assert.equal((await ledger.summary({ days: 90 })).byFeature.audio.uncachedInputTokens, 500);

  // Old days are dropped when something new is written; unknown features fold into other.
  await ledger.record({ feature: 'surprise', usage: buckets(1, 1), at: day('2026-10-02') });
  await ledger.record({ feature: 'generate', usage: buckets(1, 1), at: day('2026-01-01') });
  const stored = JSON.parse(await readFile(join(root, 'model-usage.json'), 'utf8'));
  assert.ok(Object.keys(stored.days).every((date) => date >= '2026-07-04'), `older days are pruned: ${Object.keys(stored.days)}`);
  assert.ok(Object.values(stored.days).every((features) => Object.keys(features).every((id) => ledgerModule.USAGE_FEATURES.includes(id))));
  assert.deepEqual((await ledger.summary({ days: 7 })).byFeature.other, { ...buckets(1, 1), calls: 1 });
  assert.ok((await readFile(join(root, 'model-usage.json'), 'utf8')).length < 8000, 'a quarter of daily buckets stays small');

  // A damaged file starts afresh instead of failing the caller.
  await writeFile(join(root, 'model-usage.json'), '{not json', 'utf8');
  await ledger.record({ feature: 'flow', usage: buckets(9, 9), at: day('2026-10-02') });
  assert.deepEqual((await ledger.summary({ days: 7 })).byFeature, { flow: { ...buckets(9, 9), calls: 1 } });
  // Garbage usage is ignored.
  await ledger.record({ feature: 'flow', usage: null });
  await ledger.record({ feature: 'flow', usage: { uncachedInputTokens: -5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  assert.equal((await ledger.summary({ days: 7 })).byFeature.flow.calls, 1);
});

test('concurrent records for one library are never lost and share one writer', async (t) => {
  const root = await tmp(t);
  const first = ledgerModule.usageLedger(root), second = ledgerModule.usageLedger(root);
  assert.equal(first, second, 'every runtime of a library uses one ledger instance');
  await Promise.all(Array.from({ length: 25 }, (_, index) => (index % 2 ? first : second).record({ feature: 'generate', usage: buckets(1, 1), at: Date.now() })));
  const total = (await first.summary({ days: 7 })).byFeature.generate;
  assert.equal(total.calls, 25);
  assert.equal(total.uncachedInputTokens, 25);
});

test('the ledger sink maps a report to its feature and keeps the job tally out of the file', async (t) => {
  const root = await tmp(t);
  const ledger = ledgerModule.createUsageLedger(root);
  const sink = ledgerModule.ledgerSink(ledger);
  await sink(buckets(5, 5), { feature: 'case', calls: 3 });
  await sink(buckets(1, 1), {});
  const summary = await ledger.summary({ days: 7 });
  assert.equal(summary.byFeature.case.calls, 3, 'calls come from the report');
  assert.equal(summary.byFeature.other.calls, 1, 'no feature means other, one call by default');
});

test('features are mapped from the context and action that made the call', () => {
  const featureOf = ledgerModule.featureOf;
  assert.equal(featureOf('generation', 'generate'), 'generate');
  assert.equal(featureOf('generation', 'supplement'), 'generate');
  assert.equal(featureOf('generation', 'generate.suggest'), 'generate');
  assert.equal(featureOf('generation', 'draft.repair'), 'repair');
  assert.equal(featureOf('generation', 'case.drills'), 'case');
  assert.equal(featureOf('authoring', 'draft.publish'), 'repair');
  assert.equal(featureOf('study', 'card.grade'), 'case');
  assert.equal(featureOf('study', 'oral.next'), 'coach');
  assert.equal(featureOf('coach', 'coach.nudge'), 'coach');
  assert.equal(featureOf('workflows', 'workflow.teaching.start'), 'flow');
  assert.equal(featureOf('skeleton', 'skeleton.generate'), 'flow');
  assert.equal(featureOf('audio', 'audio.import'), 'audio');
  assert.equal(featureOf('notes', 'note.generate'), 'other');
  assert.equal(featureOf('nonsense', 'x'), 'other');
});

test('the fallback estimator matches DSH estimateMessage on real samples', async () => {
  const estimate = await import('../lib/token-estimate.js');
  // Values measured with DSH 0.2.0-rc.2 estimateMessage (chars / 4, +4 per block, +4 role framing).
  const measured = { empty: [0, 8, 0], hello: [11, 11, 7], ascii400: [400, 108, 104], zh: [49, 21, 17], json: [155, 47, 43], emoji: [12, 11, 7] };
  const text = {
    empty: '', hello: 'Hello world', ascii400: 'abcdefghij'.repeat(40),
    zh: '设计模式讲义：Memento 与 Bridge 让对象在不暴露内部细节的前提下保存和恢复自身状态。',
    json: JSON.stringify({ count: 10, kind: 'quiz', sources: [{ id: 's1', text: 'x'.repeat(95) }] }),
    emoji: 'ok 🙂🙂 done',
  };
  for (const [name, [chars, asUser, asSystem]] of Object.entries(measured)) {
    assert.equal(text[name].length, chars, `${name} fixture length`);
    assert.equal(estimate.dshUserTokens(text[name]), asUser, `${name} as a user message`);
    assert.equal(estimate.dshSystemTokens(text[name]), asSystem, `${name} as a system message`);
  }
});

test('a host token meter is used when present and the fallback otherwise', async () => {
  const estimate = await import('../lib/token-estimate.js');
  const seen = [];
  const meter = { estimateMessage: (message) => { seen.push(message.role); return message.content[0].text.length; } };
  const measure = estimate.createTextMeasure({ tokenMeter: meter });
  assert.equal(measure.dsh('system text', 'system'), 11);
  assert.equal(measure.dsh('user text', 'user'), 9);
  assert.deepEqual(seen, ['system', 'user']);
  const broken = estimate.createTextMeasure({ tokenMeter: { estimateMessage() { throw new Error('boom'); } } });
  assert.equal(broken.dsh('Hello world', 'user'), 11, 'a failing meter falls back to the mirrored rule');
  assert.equal(estimate.createTextMeasure({}).dsh('Hello world', 'user'), 11);
});

test('the upper bound counts Chinese by the character, the lower bound is DSH', async () => {
  const estimate = await import('../lib/token-estimate.js');
  const measure = estimate.createTextMeasure({});
  const english = measure.range('The quick brown fox jumps over the lazy dog. '.repeat(100), 'user');
  const chinese = measure.range('快速的棕色狐狸跳过了懒狗。'.repeat(100), 'user');
  assert.ok(english.low <= english.high && chinese.low <= chinese.high);
  assert.ok(chinese.high / chinese.low > english.high / english.low, 'Chinese is where the fixed heuristic is furthest off');
  assert.equal(measure.range('', 'user').low, 8);
});
