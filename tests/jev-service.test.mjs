import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { FAKE_KEY, startFakeJev } from './helpers/fake-jev.mjs';

/* The jev.* operations of a running service: settings, the key test, the usage page. The key never leaves the DSH home. */

const han = /[㐀-鿿]/;
async function harness(t, serverOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-service-home-'));
  const root = await mkdtemp(join(tmpdir(), 'study-jev-service-lib-'));
  const before = { DSH_HOME: process.env.DSH_HOME, JEV_API_KEY: process.env.JEV_API_KEY, JEV_BASE_URL: process.env.JEV_BASE_URL };
  process.env.DSH_HOME = home; delete process.env.JEV_API_KEY; delete process.env.JEV_BASE_URL;
  const fake = await startFakeJev(serverOptions);
  const service = new StudyService(root, { jev: { baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0 } });
  t.after(async () => {
    service.dispose(); await fake.close();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  });
  return { home, root, fake, service, call: (action, args) => service.call(action, args) };
}
async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path)); else found.push(path);
  }
  return found;
}

test('everything is off by default and the view never carries the key', async t => {
  const h = await harness(t);
  const view = await h.call('jev.settings.get');
  assert.deepEqual([view.key.set, view.confirmed, view.enabled], [false, false, false]);
  assert.deepEqual(Object.values(view.features), [false, false, false, false]);
  assert.equal(view.threshold, 0.8);
  const saved = await h.call('jev.settings.set', { key: h.fake.key, confirm: true, enabled: true, features: { courseSuggest: true }, threshold: 0.9 });
  assert.deepEqual([saved.key.set, saved.confirmed, saved.enabled, saved.features.courseSuggest, saved.threshold], [true, true, true, true, 0.9]);
  assert.equal(saved.key.hint, `••••${FAKE_KEY.slice(-4)}`);
  assert.ok(!JSON.stringify(saved).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(await h.call('jev.settings.get')).includes(FAKE_KEY));
  await assert.rejects(h.call('jev.settings.set', { key: 'no spaces allowed here!' }), error => !error.message.includes('no spaces'));
});

test('the key reaches neither the snapshot, nor an export, nor any file of the library', async t => {
  const h = await harness(t);
  await h.call('jev.settings.set', { key: h.fake.key, confirm: true, enabled: true, features: { courseSuggest: true } });
  await h.call('jev.test');
  const everything = [JSON.stringify(await h.call('snapshot')), JSON.stringify(await h.call('export')), JSON.stringify(await h.call('jev.usage'))].join('\n');
  assert.ok(!everything.includes(FAKE_KEY));
  for (const file of await filesUnder(h.root)) assert.ok(!(await readFile(file, 'utf8').catch(() => '')).includes(FAKE_KEY), `${file} holds no key`);
  assert.ok((await filesUnder(h.home)).some(file => file.endsWith('jev.json')), 'the key is in the DSH home');
});

test('the public settings operation retains custom endpoint and model, with validation and recipient confirmation intact', async t => {
  const h = await harness(t);
  const endpoint = `${h.fake.baseUrl}/gw/v1/systemone`;
  const saved = await h.call('jev.settings.set', { provider: 'custom', customEndpoint: endpoint,
    customModel: 'gateway/jev-1', key: h.fake.key, confirm: true, enabled: true,
    features: { preReview: true }, replace: { cardReview: true }, threshold: 0.9 });
  assert.deepEqual(saved.custom, { endpoint, model: 'gateway/jev-1', host: new URL(endpoint).host });
  assert.deepEqual([saved.provider, saved.confirmed, saved.enabled, saved.features.preReview, saved.replace.cardReview, saved.threshold],
    ['custom', true, true, true, true, 0.9]);
  assert.ok(!JSON.stringify(saved).includes(h.fake.key));
  assert.deepEqual((await h.call('jev.settings.get')).custom, saved.custom);
  const tested = await h.call('jev.test');
  assert.equal(tested.ok, true);
  assert.equal(h.fake.requests[0].path, '/gw/v1/systemone');
  assert.equal(h.fake.requests[0].payload.model, 'gateway/jev-1');
  for (const customEndpoint of ['http://remote.example.com/jev', 'https://user:password@example.com/jev', 'https://example.com/jev?key=secret'])
    await assert.rejects(h.call('jev.settings.set', { customEndpoint }), error => /Jev/.test(error.message) && !error.message.includes(customEndpoint));
  await assert.rejects(h.call('jev.settings.set', { customModel: 'two words' }), /Jev/);
  assert.deepEqual((await h.call('jev.settings.get')).custom, saved.custom, 'a refused change keeps the previous settings');
  const changed = await h.call('jev.settings.set', { customEndpoint: `${h.fake.baseUrl}/new/v1/systemone` });
  assert.equal(changed.confirmed, false, 'a different recipient needs a new confirmation');
  assert.equal((await h.call('jev.test')).state, 'not-confirmed');
  assert.equal(h.fake.requests.length, 1);
  const cleared = await h.call('jev.settings.set', { customEndpoint: '', customModel: '' });
  assert.deepEqual(cleared.custom, { endpoint: '', model: '', host: '' });
});

test('the key test needs the confirmation, makes one tiny call, and reports the state in plain words', async t => {
  const h = await harness(t);
  let result = await h.call('jev.test');
  assert.deepEqual([result.ok, result.state], [false, 'no-key']);
  await h.call('jev.settings.set', { key: h.fake.key });
  result = await h.call('jev.test');
  assert.deepEqual([result.ok, result.state], [false, 'not-confirmed']);
  assert.equal(h.fake.requests.length, 0, 'nothing is sent before the privacy note is confirmed');
  await h.call('jev.settings.set', { confirm: true });
  result = await h.call('jev.test');
  assert.deepEqual([result.ok, result.state], [true, 'valid']);
  assert.ok(han.test(result.message));
  assert.equal(h.fake.requests.length, 1);
  const english = await h.call('jev.test', { uiLanguage: 'en' });
  assert.ok(!han.test(english.message), english.message);
  await h.call('jev.settings.set', { key: 'a_different_wrong_key_000000' });
  result = await h.call('jev.test', { uiLanguage: 'en' });
  assert.deepEqual([result.ok, result.state], [false, 'invalid-key']);
  assert.ok(!han.test(result.message));
});

test('the usage page shows tokens and calls (today and total), the last failure, and no money', async t => {
  const h = await harness(t, { usage: () => ({ input_tokens: 250, output_tokens: 10 }) });
  await h.call('jev.settings.set', { key: h.fake.key, confirm: true });
  await h.call('jev.test');
  await h.call('jev.test');
  let page = await h.call('jev.usage');
  assert.deepEqual(page.usage.today, { calls: 2, inputTokens: 500, outputTokens: 20 });
  assert.deepEqual(page.usage.total, { calls: 2, inputTokens: 500, outputTokens: 20 });
  assert.equal(page.failure, null);
  assert.equal(page.settings.key.set, true);
  await h.call('jev.settings.set', { key: 'a_different_wrong_key_000000' });
  await h.call('jev.test');
  page = await h.call('jev.usage');
  assert.equal(page.failure.reason, 'invalid-key');
  assert.ok(!/price|cost|\$|¥|usd/i.test(JSON.stringify(page)));
});

test('the settings operations are available without any other context', async t => {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-standalone-'));
  const root = await mkdtemp(join(tmpdir(), 'study-jev-standalone-lib-'));
  const before = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const service = new StudyService(root, { contexts: ['system'] });
  t.after(async () => { service.dispose(); if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  assert.equal((await service.call('jev.settings.get')).enabled, false);
});
