import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, isLimitError, clampCount, TEXT_CONCURRENCY } from '../lib/audio-pool.js';
import { finishTranscript } from '../lib/audio-import.js';

/* WP-AU #212 (owner decision): a refused call (429, "too many concurrent requests", sub-agent limit) lowers the effective
   concurrency for the rest of the run, the refused window is retried after a back-off (never failed), and the pool
   raises the limit again step by step once the provider accepts more. */

const limited = (message = 'too many concurrent requests') => Object.assign(new Error(message), { status: 429 });
const fast = () => 1;
/** A provider that refuses every call made while more than `capacity()` calls are open. */
function provider(capacity) {
  const stats = { active: 0, accepted: 0, refused: 0, peakAccepted: 0, calls: 0 };
  const call = async () => {
    stats.calls++; stats.active++;
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (stats.active > capacity()) { stats.refused++; throw limited(); }
      stats.accepted++; stats.peakAccepted = Math.max(stats.peakAccepted, stats.active);
      return stats.calls;
    } finally { stats.active--; }
  };
  return { call, stats };
}

test('what counts as a concurrency or rate refusal', () => {
  assert.ok(isLimitError(limited()));
  assert.ok(isLimitError(Object.assign(new Error('x'), { code: 'RATE_LIMIT' })));
  assert.ok(isLimitError(new Error('Too many concurrent requests for this account')));
  assert.ok(isLimitError(new Error('sub-agent limit reached: 4 running')));
  assert.ok(!isLimitError(new Error('invalid key')));
  assert.ok(!isLimitError(Object.assign(new Error('x'), { name: 'AbortError', status: 429 })));
  assert.equal(clampCount(7, TEXT_CONCURRENCY), 3);
  assert.equal(clampCount('4', TEXT_CONCURRENCY), 4);
});

test('a provider that only allows 2 at once: the run settles at 2 and no job fails', async () => {
  const { call, stats } = provider(() => 2), changes = [];
  const pool = createPool({ limit: 6, backoff: fast, probeAfter: 100, onChange: change => changes.push(change.effective) });
  const results = await Promise.all(Array.from({ length: 24 }, () => pool.run(call)));
  assert.equal(results.length, 24);
  assert.equal(stats.accepted, 24, 'every job got an answer');
  assert.ok(stats.refused >= 1, 'the provider did refuse at first');
  assert.equal(pool.state.effective, 2, 'the pool settled at what the provider accepts');
  assert.equal(pool.state.lowered, true);
  assert.equal(pool.state.limit, 6);
  assert.ok(stats.peakAccepted <= 2);
  assert.ok(changes.every((value, i) => i === 0 || value <= changes[i - 1]), 'only ever lowered while the limit holds');
});

test('when the provider limit lifts the pool climbs back to the configured value', async () => {
  let capacity = 2;
  const { call, stats } = provider(() => capacity), pool = createPool({ limit: 5, backoff: fast, probeAfter: 3 });
  await Promise.all(Array.from({ length: 12 }, () => pool.run(call)));
  assert.equal(pool.state.lowest, 2);
  capacity = 10;
  for (let round = 0; round < 12 && pool.state.effective < 5; round++) await Promise.all(Array.from({ length: 10 }, () => pool.run(call)));
  assert.equal(pool.state.effective, 5, 'raised one step at a time back to the ceiling');
  assert.equal(pool.state.lowered, true, 'the card can still say it was lowered once');
  assert.ok(stats.accepted >= 22);
});

test('a provider that refuses everything finally surfaces its error instead of looping', async () => {
  const pool = createPool({ limit: 3, backoff: fast, refusals: 3 });
  await assert.rejects(pool.run(async () => { throw limited(); }), /too many concurrent/);
});

test('other errors are not retried by the pool, and cancelling during a back-off stops at once', async () => {
  const pool = createPool({ limit: 3, backoff: () => 60_000 });
  let calls = 0;
  await assert.rejects(pool.run(async () => { calls++; throw new Error('invalid key'); }), /invalid key/);
  assert.equal(calls, 1);
  const controller = new AbortController();
  let refusedOnce = false;
  const waiting = pool.run(async () => { refusedOnce = true; throw limited(); }, { signal: controller.signal });
  waiting.catch(() => {});
  await import('./helpers/wait.mjs').then(({ until }) => until(() => refusedOnce, 'the first refusal'));
  controller.abort(new Error('stopped'));
  await assert.rejects(waiting, /stopped/);
});

test('proofreading and translating a recording survive a model that allows 2 at once', async () => {
  let active = 0, refused = 0, maximum = 0;
  const paragraphs = Array.from({ length: 12 }, (_, i) => `Window ${i + 1}: ` + 'lecture evidence '.repeat(260));
  const pool = createPool({ limit: 6, backoff: fast, probeAfter: 100 });
  const warnings = [];
  const complete = async (system, prompt, options) => {
    if (options.kind === 'title') return '{"titleEn":"Lecture"}';
    active++;
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (active > 2) { refused++; throw limited('429 Too Many Requests'); }
      maximum = Math.max(maximum, active);
      return options.kind === 'proofread' ? '{"corrections":[]}' : JSON.stringify({ titleEn: 'P', titleZh: '部分',
        paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: 'Translation' })) });
    } finally { active--; }
  };
  const result = await finishTranscript({ paragraphs, filename: 'lecture.wav', settings: { textConcurrency: 6 }, complete,
    saved: { get: async () => null, set: async () => {} }, keys: { raw: 'r', text: 't' }, pools: { text: pool }, warn: text => warnings.push(text) });
  assert.ok(refused >= 1);
  assert.equal(pool.state.effective, 2);
  assert.ok(maximum <= 2);
  assert.deepEqual(warnings, [], 'no window was given up on');
  assert.ok(result.documents.join('').includes('Window 12:'));
});
