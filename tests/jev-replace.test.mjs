import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noul } from '../lib/jev.js';
import { JEV_REPLACE_SITES, isReplaceSite } from '../lib/jev-sites.js';
import { JEV_FEATURES, jevGate, jevSettingsPath, publicJevSettings, readJevSettings, saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { createJevUsage, JEV_USAGE_FEATURES } from '../lib/jev-usage.js';
import { replaceWithJev } from '../lib/jev-decide.js';
import { startFakeJev } from './helpers/fake-jev.mjs';

/* The seam: `replaceWithJev` routes a decision-shaped model call to Jev for the sites the learner switched on, and falls back to exactly the
   current model path, automatically and once per run, for anything Jev cannot settle. With every switch off nothing about Jev runs. */

const han = /[㐀-鿿]/;
const SITE = JEV_REPLACE_SITES[0];

async function harness(t, serverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-replace-'));
  const before = Object.fromEntries(['DSH_HOME', 'JEV_API_KEY', 'JEV_BASE_URL', 'OPENCODE_GO_API_KEY_2'].map(name => [name, process.env[name]]));
  process.env.DSH_HOME = home; for (const name of ['JEV_API_KEY', 'JEV_BASE_URL', 'OPENCODE_GO_API_KEY_2']) delete process.env[name];
  // The fake answers by the text of the item: "p=0.97 ..." is a 97% yes.
  const fake = await startFakeJev({ answer: (name, question, state) => ({ type: 'noul', noul: Number(/p=([0-9.]+)/.exec(state.text)?.[1] ?? 0.5) }), ...serverOptions });
  const meter = createJevUsage();
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: meter });
  t.after(async () => {
    await fake.close();
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(home, { recursive: true, force: true });
  });
  const open = (extra = {}) => saveJevSettings({ key: fake.key, confirm: true, enabled: true, replace: { [SITE]: true }, ...extra });
  return { home, fake, runtime, meter, open };
}
const item = (id, p, extra = {}) => ({ id, text: `item ${id} p=${p}`, ...extra });
const build = it => ({ state: { text: it.text }, questions: { thing: noul('Is it a thing?') } });
const read = (answers, it) => (it.unsupported ? null : { value: answers.thing.noul >= 0.5 ? 'yes' : 'no', confidence: Math.max(answers.thing.noul, 1 - answers.thing.noul) });
const modelAnswers = calls => async items => { calls.push(items.map(entry => entry.id)); return items.map(entry => `model:${entry.id}`); };
const route = (h, items, extra = {}) => { const calls = []; return replaceWithJev({ runtime: h.runtime, site: SITE, items, build, read, threshold: 0.8, language: 'en', fallback: modelAnswers(calls), ...extra }).then(result => ({ ...result, calls })); };

/* ---- the sites and the switches --------------------------------------------------------------------------------------- */

test('the replaceable sites are listed in one place; none of them is an extra-signal experiment, and tokens are counted per site', () => {
  assert.deepEqual(JEV_REPLACE_SITES.slice(0, 2), ['cardReview', 'courseOrganize']);
  for (const site of JEV_REPLACE_SITES) { assert.equal(isReplaceSite(site), true); assert.ok(!JEV_FEATURES.includes(site), `${site} is not a feature`); assert.ok(JEV_USAGE_FEATURES.includes(site), `${site} has its own usage row`); }
  assert.equal(isReplaceSite('courseSuggest'), false);
  assert.ok(Object.isFrozen(JEV_REPLACE_SITES));
});

test('every replace switch is off by default, is toggled one by one, survives the master switch and a file from before it existed', async t => {
  await harness(t);
  let settings = await readJevSettings();
  for (const site of JEV_REPLACE_SITES) assert.equal(settings.replace[site], false, site);
  settings = await saveJevSettings({ replace: { [SITE]: true } });
  assert.deepEqual(JEV_REPLACE_SITES.filter(site => settings.replace[site]), [SITE]);
  assert.deepEqual(publicJevSettings(settings).replace, settings.replace);
  settings = await saveJevSettings({ enabled: true });
  assert.equal(settings.replace[SITE], true, 'the choice is remembered under the master switch');
  await assert.rejects(saveJevSettings({ replace: { surprise: true } }), error => /Jev/.test(error.message) && !error.message.includes('surprise'));
  await assert.rejects(saveJevSettings({ replace: { [SITE]: 'yes' } }), /true 或 false/);
  await assert.rejects(saveJevSettings({ replace: [] }), /对象/);
  assert.equal((await readJevSettings()).replace[SITE], true, 'a refused change changes nothing');
  // A file written before replace existed reads as all off.
  await writeFile(jevSettingsPath(), JSON.stringify({ version: 1, enabled: true, features: { courseSuggest: true } }));
  settings = await readJevSettings();
  assert.deepEqual(Object.values(settings.replace), JEV_REPLACE_SITES.map(() => false));
  assert.equal(settings.features.courseSuggest, true);
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).replace, undefined, 'reading writes nothing');
});

test('the gate of a replace site opens only with the master switch, the site switch, a key and the confirmation, in that order of reasons', async t => {
  const h = await harness(t);
  const gate = async () => jevGate(await readJevSettings(), SITE);
  assert.deepEqual(await gate(), { ok: false, reason: 'off' });
  await saveJevSettings({ enabled: true });
  assert.deepEqual(await gate(), { ok: false, reason: 'feature-off' });
  await saveJevSettings({ replace: { [SITE]: true } });
  assert.deepEqual(await gate(), { ok: false, reason: 'no-key' });
  await saveJevSettings({ key: h.fake.key });
  assert.deepEqual(await gate(), { ok: false, reason: 'not-confirmed' });
  await saveJevSettings({ confirm: true });
  assert.deepEqual(await gate(), { ok: true });
  await saveJevSettings({ provider: 'opencode-zen' });
  assert.equal((await gate()).reason, 'no-key', 'a TypeSafe key is not an OpenCode key');
  await saveJevSettings({ provider: 'typesafe', enabled: false });
  assert.deepEqual(await gate(), { ok: false, reason: 'off' }, 'the kill switch closes it');
  await assert.rejects(async () => jevGate(await readJevSettings(), 'nope'), /feature/i);
});

test('the runtime answers "is this site open" without sending anything', async t => {
  const h = await harness(t);
  const gate = async () => { const { provider, ...rest } = await h.runtime.gate(SITE); assert.equal(provider, 'typesafe'); return rest; };
  assert.deepEqual(await gate(), { ok: false, reason: 'off' });
  await h.open();
  assert.deepEqual(await gate(), { ok: true });
  assert.equal(h.fake.requests.length, 0);
});

/* ---- routing and fallback --------------------------------------------------------------------------------------------- */

test('everything off: the model path runs exactly once, over all items in order, and Jev is never contacted nor mentioned', async t => {
  const h = await harness(t);
  const items = [item('a', 0.99), item('b', 0.5), item('c', 0.01)];
  for (const setup of [async () => {}, async () => saveJevSettings({ enabled: true }), async () => saveJevSettings({ key: h.fake.key, confirm: true, replace: { [SITE]: false } })]) {
    await setup();
    const result = await route(h, items);
    assert.deepEqual(result.calls, [['a', 'b', 'c']]);
    assert.deepEqual(result.results.map(entry => [entry.item.id, entry.by, entry.value]), items.map(entry => [entry.id, 'model', `model:${entry.id}`]));
    assert.deepEqual(result.summary, { site: SITE, enabled: false, jev: 0, model: 3, usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, fallback: null });
  }
  assert.equal(h.fake.requests.length, 0);
});

test('switched on: Jev decides the confident items, ONE model call takes the rest in their original order, the results keep the item order', async t => {
  const h = await harness(t);
  await h.open();
  const items = [item('a', 0.99), item('b', 0.55), item('c', 0.02), item('d', 0.7), item('e', 0.95)];
  const result = await route(h, items);
  assert.deepEqual(result.calls, [['b', 'd']], 'one fallback call, only the items Jev could not settle');
  assert.deepEqual(result.results.map(entry => [entry.item.id, entry.by, entry.value]),
    [['a', 'jev', 'yes'], ['b', 'model', 'model:b'], ['c', 'jev', 'no'], ['d', 'model', 'model:d'], ['e', 'jev', 'yes']]);
  assert.equal(h.fake.requests.length, 5, 'one tiny request per item');
  assert.deepEqual([result.summary.enabled, result.summary.jev, result.summary.model], [true, 3, 2]);
  assert.deepEqual(result.summary.fallback, { reason: 'low-confidence', count: 2, message: result.summary.fallback.message });
  assert.ok(!han.test(result.summary.fallback.message) && /Jev/.test(result.summary.fallback.message) && /2/.test(result.summary.fallback.message), result.summary.fallback.message);
  assert.deepEqual(result.summary.usage.calls, 5);
  assert.ok(result.summary.usage.inputTokens > 0);
});

test('all confident: the model is not called at all', async t => {
  const h = await harness(t);
  await h.open();
  const result = await route(h, [item('a', 0.99), item('b', 0.01)]);
  assert.deepEqual(result.calls, []);
  assert.deepEqual([result.summary.jev, result.summary.model, result.summary.fallback], [2, 0, null]);
});

test('the learner’s threshold decides what counts as confident, boundary included', async t => {
  const h = await harness(t);
  await h.open();
  const items = [item('a', 0.8), item('b', 0.79), item('c', 0.91)];
  assert.deepEqual((await route(h, items, { threshold: 0.8 })).calls, [['b']]);
  assert.deepEqual((await route(h, items, { threshold: 0.9 })).calls, [['a', 'b']]);
  assert.deepEqual((await route(h, items, { threshold: 0.5 })).calls, []);
});

test('an input Jev cannot take (read says so) goes to the model, with its own reason', async t => {
  const h = await harness(t);
  await h.open();
  const result = await route(h, [item('a', 0.99), item('b', 0.99, { unsupported: true })]);
  assert.deepEqual(result.calls, [['b']]);
  assert.equal(result.summary.fallback.reason, 'unsupported');
  assert.equal(result.summary.jev, 1);
});

test('a failing Jev (bad key, rate limit, overload, outage, network) falls back for everything, once, with the typed reason and no key in the message', async t => {
  const h = await harness(t);
  await h.open();
  const items = [item('a', 0.99), item('b', 0.99), item('c', 0.99)];
  for (const [status, reason] of [[401, 'invalid-key'], [429, 'rate-limited'], [529, 'overloaded'], [503, 'unavailable']]) {
    h.fake.clearFailures(); h.fake.requests.length = 0;
    h.fake.fail(...Array(30).fill({ status, body: { detail: 'SECRET_BODY' } }));
    const result = await route(h, items, { concurrency: 1 });
    assert.deepEqual(result.calls, [['a', 'b', 'c']], `${status}: one model call over everything`);
    assert.equal(result.summary.fallback.reason, reason, String(status));
    assert.equal(result.summary.jev, 0);
    assert.ok(!result.summary.fallback.message.includes(h.fake.key) && !result.summary.fallback.message.includes('SECRET_BODY'));
    if (status === 401) assert.equal(h.fake.requests.length, 1, 'a rejected key stops the run after one request (no retry can fix it)');
  }
  h.fake.clearFailures(); await h.fake.close();
  const unreachable = await route(h, items);
  assert.deepEqual(unreachable.calls, [['a', 'b', 'c']]);
  assert.equal(unreachable.summary.fallback.reason, 'network');
});

test('a Jev failure in the middle only sends the unanswered items to the model; the notice is one object per run, never one per item', async t => {
  const h = await harness(t);
  await h.open();
  h.fake.fail(...Array(3).fill(503));   // the first item exhausts its retries
  const items = [item('a', 0.99), item('b', 0.99), item('c', 0.01), item('d', 0.99)];
  const result = await route(h, items, { concurrency: 1 });
  assert.equal(result.calls.length, 1, 'one fallback call');
  assert.deepEqual(result.calls[0], ['a']);
  assert.deepEqual(result.results.map(entry => entry.by), ['model', 'jev', 'jev', 'jev']);
  assert.equal(result.summary.fallback.count, 1);
  assert.equal(result.summary.fallback.reason, 'unavailable');
});

test('a missing key or confirmation while the switch is on is reported (once) and the model path runs; nothing is sent', async t => {
  const h = await harness(t);
  await saveJevSettings({ enabled: true, replace: { [SITE]: true } });
  let result = await route(h, [item('a', 0.99)]);
  assert.deepEqual([result.calls, result.summary.fallback.reason, result.summary.enabled], [[['a']], 'no-key', true]);
  await saveJevSettings({ key: h.fake.key });
  result = await route(h, [item('a', 0.99)]);
  assert.equal(result.summary.fallback.reason, 'not-confirmed');
  assert.equal(h.fake.requests.length, 0);
});

test('the model path keeps its own errors: a failing fallback rejects as it would today; a cancelled signal rejects as well', async t => {
  const h = await harness(t);
  await h.open();
  await assert.rejects(route(h, [item('a', 0.5)], { fallback: async () => { throw new Error('model down'); } }), /model down/);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(route(h, [item('a', 0.99)], { signal: controller.signal }), /cancelled/);
});

test('it never sends more than the concurrency in flight and keeps tokens apart, per site, from the study model', async t => {
  let inFlight = 0, peak = 0;
  const h = await harness(t, { delayMs: 15, onRequest: () => { inFlight++; peak = Math.max(peak, inFlight); setTimeout(() => { inFlight--; }, 14); } });
  await h.open();
  await route(h, Array.from({ length: 9 }, (_, index) => item(`i${index}`, 0.99)), { concurrency: 3 });
  assert.ok(peak <= 3, `peak ${peak}`);
  const summary = await h.meter.summary();
  assert.equal(summary.byFeature[SITE].calls, 9);
  assert.equal(summary.byFeature.preReview, undefined);
});

test('the request is the typed one: instructions, the preset model, and nothing but the state the site built', async t => {
  const h = await harness(t);
  await h.open();
  await route(h, [item('a', 0.99)]);
  const request = h.fake.requests[0];
  assert.equal(request.payload.model, 'jev-latest');
  assert.deepEqual(Object.keys(request.payload).sort(), ['model', 'questions', 'state']);
  assert.equal(request.payload.questions.thing.type, 'noul');
});
