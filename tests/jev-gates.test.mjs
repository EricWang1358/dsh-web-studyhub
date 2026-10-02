import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_MESSAGES, JEV_MESSAGES_EN, noul, choice } from '../lib/jev.js';
import { saveJevSettings } from '../lib/jev-settings.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { createJevRuntime, mapLimit } from '../lib/jev-runtime.js';
import { FAKE_KEY, startFakeJev } from './helpers/fake-jev.mjs';

/* The gate every Jev call goes through: nothing is sent without the master switch, the feature switch, a key and the confirmation,
   and an unavailable Jev never breaks the flow that asked: the answer is { ok: false, reason } and the caller carries on as before. */

async function harness(t, serverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-gate-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev(serverOptions);
  const waits = [];
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async ms => { waits.push(ms); }, random: () => 0, usage: createJevUsage() });
  t.after(async () => {
    await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  const open = async (features = ['courseSuggest']) => saveJevSettings({ key: fake.key, confirm: true, enabled: true, features: Object.fromEntries(features.map(name => [name, true])) });
  return { home, fake, runtime, waits, open };
}
const ask = (runtime, feature = 'courseSuggest', extra = {}) => runtime.run(feature, 'a source', { q: noul('Is it a source?') }, extra);

test('nothing is sent without the master switch, the feature switch, a key and the confirmation', async t => {
  const h = await harness(t);
  assert.deepEqual((await ask(h.runtime)).reason, 'off');
  await saveJevSettings({ enabled: true });
  assert.equal((await ask(h.runtime)).reason, 'feature-off');
  await saveJevSettings({ features: { courseSuggest: true } });
  assert.equal((await ask(h.runtime)).reason, 'no-key');
  await saveJevSettings({ key: h.fake.key });
  assert.equal((await ask(h.runtime)).reason, 'not-confirmed');
  assert.equal(h.fake.requests.length, 0, 'Jev was never contacted');
  await saveJevSettings({ confirm: true });
  const result = await ask(h.runtime);
  assert.equal(result.ok, true);
  assert.equal(h.fake.requests.length, 1);
  assert.equal(h.fake.requests[0].headers.authorization, `Bearer ${FAKE_KEY}`);
});

test('a refused call explains itself in the learner’s language', async t => {
  const h = await harness(t);
  const zh = await ask(h.runtime, 'courseSuggest', { language: 'zh' }), en = await ask(h.runtime, 'courseSuggest', { language: 'en' });
  assert.equal(zh.message, JEV_MESSAGES.off);
  assert.equal(en.message, JEV_MESSAGES_EN.off);
  assert.ok(!/[㐀-鿿]/.test(en.message));
});

test('the kill switch and the feature switch are read again on every call', async t => {
  const h = await harness(t, {});
  await h.open(['courseSuggest', 'preReview']);
  assert.equal((await ask(h.runtime)).ok, true);
  await saveJevSettings({ enabled: false });
  assert.equal((await ask(h.runtime)).reason, 'off');
  await saveJevSettings({ enabled: true, features: { courseSuggest: false } });
  assert.equal((await ask(h.runtime)).reason, 'feature-off');
  assert.equal((await ask(h.runtime, 'preReview')).ok, true);
  assert.equal(h.fake.requests.length, 2);
});

test('every failure falls back: the answer says why and nothing is thrown', async t => {
  const cases = [[401, 'invalid-key'], [422, 'invalid-request'], [429, 'rate-limited'], [529, 'overloaded'], [500, 'unavailable']];
  for (const [status, reason] of cases) {
    const h = await harness(t, { failures: [status, status, status] });
    await h.open();
    const result = await ask(h.runtime);
    assert.deepEqual([result.ok, result.reason], [false, reason], String(status));
    assert.ok(result.message.includes('Jev'));
    assert.deepEqual(h.waits.length, [429, 529, 500].includes(status) ? 2 : 0, `${status} retried only when it can help`);
  }
  const bad = await harness(t, { answer: () => ({ type: 'noul', noul: 7 }) });
  await bad.open();
  assert.equal((await ask(bad.runtime)).reason, 'bad-response');
  const slow = await harness(t, { delayMs: 300 });
  slow.runtime = createJevRuntime({ baseUrl: slow.fake.baseUrl, timeoutMs: 40, maxRetries: 0, usage: createJevUsage() });
  await slow.open();
  assert.equal((await ask(slow.runtime)).reason, 'timeout');
  const gone = await startFakeJev(); const baseUrl = gone.baseUrl; await gone.close();
  const offline = await harness(t);
  offline.runtime = createJevRuntime({ baseUrl, maxRetries: 0, usage: createJevUsage() });
  await offline.open();
  assert.equal((await ask(offline.runtime)).reason, 'network');
});

test('a failure is remembered for the settings page and cleared by the next success', async t => {
  const h = await harness(t, { failures: [401] });
  await h.open();
  assert.equal(h.runtime.lastFailure(), null);
  await ask(h.runtime);
  assert.deepEqual({ ...h.runtime.lastFailure(), at: undefined }, { feature: 'courseSuggest', reason: 'invalid-key', at: undefined });
  assert.ok(h.runtime.lastFailure().at);
  await ask(h.runtime);
  assert.equal(h.runtime.lastFailure(), null);
});

test('a cancelled job stays cancelled: the abort is not swallowed as a fallback', async t => {
  const h = await harness(t, { delayMs: 100 });
  await h.open();
  const controller = new AbortController();
  const pending = ask(h.runtime, 'courseSuggest', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('job cancelled')), 20);
  await assert.rejects(pending, error => error.message === 'job cancelled');
});

test('tokens are counted per feature on success only, and the key test is counted apart', async t => {
  const h = await harness(t, { failures: [], usage: () => ({ input_tokens: 120, output_tokens: 8 }) });
  await h.open();
  await ask(h.runtime);
  h.fake.fail(401);
  await ask(h.runtime);
  const test1 = await h.runtime.test();
  assert.equal(test1.ok, true);
  const summary = await createJevUsage().summary();
  assert.deepEqual(summary.byFeature.courseSuggest, { calls: 1, inputTokens: 120, outputTokens: 8 });
  assert.deepEqual(summary.byFeature.test, { calls: 1, inputTokens: 120, outputTokens: 8 });
});

test('the key test needs a key and the confirmation but not a feature; it reports a bad key without throwing', async t => {
  const h = await harness(t);
  assert.equal((await h.runtime.test()).reason, 'no-key');
  await saveJevSettings({ key: 'wrong_key_0000000000000000' });
  assert.equal((await h.runtime.test()).reason, 'not-confirmed');
  await saveJevSettings({ confirm: true });
  const result = await h.runtime.test();
  assert.deepEqual([result.ok, result.reason], [false, 'invalid-key']);
  assert.equal(h.fake.requests.length, 1);
  await saveJevSettings({ key: h.fake.key });
  const good = await h.runtime.test();
  assert.equal(good.ok, true);
  assert.ok(good.model);
});

test('nothing the learner wrote or the key reaches the console', async t => {
  const h = await harness(t, { failures: [401, 429, 429, 429] });
  await h.open();
  const seen = [];
  const originals = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(name => [name, console[name]]));
  for (const name of Object.keys(originals)) console[name] = (...args) => seen.push(args.join(' '));
  try { await h.runtime.run('courseSuggest', 'private learner sentence', { q: noul('x?') }); await h.runtime.run('courseSuggest', 'private learner sentence', { q: noul('x?') }); }
  finally { for (const [name, fn] of Object.entries(originals)) console[name] = fn; }
  assert.deepEqual(seen, []);
});

test('mapLimit runs at most N at a time, keeps the order and stops when asked', async () => {
  let active = 0, peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async value => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return value * 2; });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
  const started = [];
  const stopped = await mapLimit([1, 2, 3, 4, 5, 6], 1, async value => { started.push(value); return value; }, { stop: () => started.length >= 3 });
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(stopped.slice(0, 3), [1, 2, 3]);
  assert.deepEqual(stopped.slice(3), [undefined, undefined, undefined]);
});

test('JEV_BASE_URL points the default runtime at the fake server', async t => {
  const h = await harness(t);
  await h.open();
  process.env.JEV_BASE_URL = h.fake.baseUrl;
  const runtime = createJevRuntime({ usage: createJevUsage() });
  assert.equal((await ask(runtime)).ok, true);
  assert.equal(h.fake.requests.length, 1);
});

test('a choice question round-trips through the gate with its probabilities', async t => {
  const h = await harness(t, { answer: () => ({ type: 'choice', choice: 'b', confidence: 0.5, probabilities: { a: 0.1, b: 0.75, c: 0.15 } }) });
  await h.open();
  const result = await h.runtime.run('courseSuggest', 'x', { pick: choice('which?', { a: '1', b: '2', c: '3' }) });
  assert.equal(result.answers.pick.choice, 'b');
  assert.deepEqual(result.usage, { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
});
