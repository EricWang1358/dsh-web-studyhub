import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_PROVIDERS, JEV_PROVIDER_IDS, isCustomEndpoint, isCustomModel, jevProvider, keyFromEnvironment } from '../lib/jev-providers.js';
import { jevMessage } from '../lib/jev.js';
import { jevGate, jevSettingsPath, publicJevSettings, readJevSettings, saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime } from '../lib/jev-runtime.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { FAKE_KEY, startFakeJev } from './helpers/fake-jev.mjs';

/* A custom endpoint preset: the same typed Jev API behind another gateway (OpenRouter, AIML, Netlify AI Gateway were reported to list Jev;
   their wire formats are NOT verified here). The learner enters the endpoint address, the model id and the NAME of the environment
   variable that holds the key. Its own key slot, its own privacy confirmation (bound to the address), never another service's key. */

const han = /[㐀-鿿]/;
const PASTED = 'gw_pasted_custom_key_000000000000000000GWPS';
async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-custom-'));
  const before = Object.fromEntries(['DSH_HOME', 'JEV_API_KEY', 'JEV_BASE_URL', 'OPENCODE_GO_API_KEY_2', 'JEV_CUSTOM_API_KEY', 'MY_GATEWAY_KEY'].map(name => [name, process.env[name]]));
  for (const name of Object.keys(before)) delete process.env[name];
  process.env.DSH_HOME = home;
  const fake = await startFakeJev();
  t.after(async () => { await fake.close(); for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value; await rm(home, { recursive: true, force: true }); });
  return { home, fake, endpoint: `${fake.baseUrl}/gw/v1/systemone` };
}

test('the preset exists as the last choice and has no address of its own', () => {
  assert.deepEqual(JEV_PROVIDER_IDS, ['typesafe', 'opencode-go', 'opencode-zen-free', 'opencode-zen', 'custom']);
  const custom = JEV_PROVIDERS.custom;
  assert.deepEqual([custom.family, custom.defaultKeyEnv, custom.baseUrl, custom.model], ['custom', 'JEV_CUSTOM_API_KEY', '', '']);
  assert.equal(jevProvider('custom').id, 'custom');
  assert.deepEqual(keyFromEnvironment('custom', '', { JEV_CUSTOM_API_KEY: ' k ' }), { name: 'JEV_CUSTOM_API_KEY', key: 'k', found: true });
});

test('an endpoint is an https address (http only for this machine), without credentials, a query or a fragment; a model id is a plain token', () => {
  for (const good of ['https://gateway.example.com/v1/systemone', 'https://gw.example.com:8443/jev/v1/systemone', 'http://127.0.0.1:8080/v1/systemone', 'http://localhost/v1/systemone', 'http://[::1]:9/x'])
    assert.equal(typeof isCustomEndpoint(good), 'string', good);
  for (const bad of ['http://gateway.example.com/v1/systemone', 'ftp://x.example.com/a', 'javascript:alert(1)', 'https://user:pass@gateway.example.com/x', 'https://gateway.example.com/x?key=1', 'https://gateway.example.com/x#frag',
    'not a url', '', 'https://', 'https://' + 'a'.repeat(400) + '.com', 7, null]) assert.equal(isCustomEndpoint(bad), null, String(bad));
  assert.equal(isCustomEndpoint('https://Gateway.Example.com/v1/systemone'), 'https://gateway.example.com/v1/systemone', 'normalised');
  for (const good of ['jev-1.13', 'vendor/jev:latest', 'jev_x-2']) assert.equal(isCustomModel(good), true, good);
  for (const bad of ['', 'two words', 'a'.repeat(101), 'x\ny', null, 7]) assert.equal(isCustomModel(bad), false, String(bad));
});

test('endpoint and model are saved with the provider, refused without echoing them, and cleared with an empty string', async t => {
  const { endpoint } = await withHome(t);
  let settings = await saveJevSettings({ provider: 'custom', customEndpoint: endpoint, customModel: 'my-jev-1' });
  assert.deepEqual([settings.provider, settings.customEndpoint, settings.customModel], ['custom', endpoint, 'my-jev-1']);
  const view = publicJevSettings(settings);
  assert.deepEqual([view.custom.endpoint, view.custom.model, view.custom.host], [endpoint, 'my-jev-1', new URL(endpoint).host]);
  await assert.rejects(saveJevSettings({ customEndpoint: 'http://evil.example.com/steal' }), error => /Jev/.test(error.message) && !error.message.includes('evil'));
  await assert.rejects(saveJevSettings({ customModel: 'two words' }), error => /Jev/.test(error.message) && !error.message.includes('two words'));
  assert.equal((await readJevSettings()).customEndpoint, endpoint, 'a refused change changes nothing');
  settings = await saveJevSettings({ customEndpoint: '', customModel: '' });
  assert.deepEqual([settings.customEndpoint, settings.customModel], ['', '']);
});

test('the gate says the endpoint or model is missing before it asks about the key', async t => {
  const { endpoint, fake } = await withHome(t);
  await saveJevSettings({ provider: 'custom', enabled: true, replace: { cardReview: true } });
  const gate = async () => jevGate(await readJevSettings(), 'cardReview');
  assert.deepEqual(await gate(), { ok: false, reason: 'no-endpoint' });
  await saveJevSettings({ customEndpoint: endpoint });
  assert.deepEqual(await gate(), { ok: false, reason: 'no-endpoint' }, 'the model id is needed too');
  await saveJevSettings({ customModel: 'my-jev-1' });
  assert.deepEqual(await gate(), { ok: false, reason: 'no-key' });
  process.env.JEV_CUSTOM_API_KEY = fake.key;
  assert.deepEqual(await gate(), { ok: false, reason: 'not-confirmed' });
  await saveJevSettings({ confirm: true });
  assert.deepEqual(await gate(), { ok: true });
  assert.match(jevMessage('no-endpoint', 'zh', 'custom'), /端点/);
  assert.match(jevMessage('no-endpoint', 'en', 'custom'), /endpoint/i);
  assert.ok(!han.test(jevMessage('no-endpoint', 'en', 'custom')));
});

test('keys: its own pasted slot, the variable it names (JEV_CUSTOM_API_KEY by default); no other service’s key is ever used', async t => {
  const { endpoint } = await withHome(t);
  process.env.JEV_API_KEY = 'tsk_from_JEV_API_KEY_00000000000000ENVA'; process.env.OPENCODE_GO_API_KEY_2 = 'zen_from_variable_0000000000000000ZENV';
  await saveJevSettings({ key: 'tsk_pasted_typesafe_key_0000000000000000PSTD' });
  let settings = await saveJevSettings({ provider: 'custom', customEndpoint: endpoint, customModel: 'my-jev-1' });
  assert.equal(settings.key, '', 'neither a TypeSafe nor an OpenCode key is a gateway key');
  process.env.MY_GATEWAY_KEY = 'gw_from_variable_000000000000000000GWEN';
  settings = await saveJevSettings({ keyEnv: 'MY_GATEWAY_KEY' });
  assert.deepEqual([settings.key, settings.keySource, settings.keyFromVariable], ['gw_from_variable_000000000000000000GWEN', 'env', 'MY_GATEWAY_KEY']);
  settings = await saveJevSettings({ key: PASTED });
  assert.deepEqual([settings.key, settings.keySource], [PASTED, 'file']);
  const file = JSON.parse(await readFile(jevSettingsPath(), 'utf8'));
  assert.equal(file.customKey, PASTED);
  assert.equal(file.key, 'tsk_pasted_typesafe_key_0000000000000000PSTD', 'the TypeSafe slot is untouched');
  await assert.rejects(saveJevSettings({ key: 'bad key with spaces' }), error => /Jev/.test(error.message) && !error.message.includes('bad key'));
  assert.deepEqual(publicJevSettings(await saveJevSettings({ key: '' })).key, { set: true, hint: '', source: 'env', envName: 'MY_GATEWAY_KEY', envFound: true });
});

test('the confirmation is bound to the address: another endpoint asks again, going back finds the old confirmation', async t => {
  const { endpoint } = await withHome(t);
  await saveJevSettings({ provider: 'custom', customEndpoint: endpoint, customModel: 'my-jev-1', confirm: true });
  assert.ok((await readJevSettings()).confirmedAt);
  let settings = await saveJevSettings({ customEndpoint: 'https://other-gateway.example.com/v1/systemone' });
  assert.equal(settings.confirmedAt, '', 'a new address is a new recipient of the learner’s text');
  settings = await saveJevSettings({ customEndpoint: endpoint });
  assert.equal(settings.confirmedAt, '', 'the confirmation named one address; it does not come back by itself');
  await saveJevSettings({ confirm: true });
  assert.ok((await readJevSettings()).confirmedAt);
  settings = await saveJevSettings({ customModel: 'another-model' });
  assert.ok(settings.confirmedAt, 'a model id on the same address does not change who receives the text');
  assert.equal((await saveJevSettings({ provider: 'typesafe' })).confirmedAt, '', 'and TypeSafe has its own');
});

test('requests: the learner’s address and model, the bearer key from the variable, the same typed body; the seam base URL still redirects it', async t => {
  const { endpoint, fake } = await withHome(t);
  process.env.JEV_CUSTOM_API_KEY = fake.key;
  await saveJevSettings({ provider: 'custom', customEndpoint: endpoint, customModel: 'my-jev-1', confirm: true, enabled: true, replace: { cardReview: true } });
  const runtime = createJevRuntime({ sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  const tested = await runtime.test({});
  assert.equal(tested.ok, true, JSON.stringify(tested));
  const request = fake.requests[0];
  assert.equal(request.path, '/gw/v1/systemone');
  assert.equal(request.payload.model, 'my-jev-1');
  assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.deepEqual(Object.keys(request.payload).sort(), ['model', 'questions', 'state']);
  // The seam (previews, tests) moves the origin but keeps the path of the endpoint the learner wrote.
  await saveJevSettings({ customEndpoint: 'https://gateway.example.com/gw/v1/systemone' });
  await saveJevSettings({ confirm: true });
  const seam = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  assert.equal((await seam.test({})).ok, true);
  assert.equal(fake.requests.at(-1).path, '/gw/v1/systemone');
});

test('failures name the custom endpoint, in both languages, and never hold the key, the address or a response body', async t => {
  const { endpoint, fake } = await withHome(t);
  process.env.JEV_CUSTOM_API_KEY = 'a_wrong_gateway_key_00000000000000WRNG';
  await saveJevSettings({ provider: 'custom', customEndpoint: endpoint, customModel: 'my-jev-1', confirm: true });
  const runtime = createJevRuntime({ sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  for (const [language, pattern] of [['zh', /自定义 Jev 端点/], ['en', /custom Jev endpoint/i]]) {
    const result = await runtime.test({ language });
    assert.equal(result.reason, 'invalid-key');
    assert.match(result.message, pattern);
    assert.ok(!result.message.includes('WRNG') && !result.message.includes(endpoint) && !result.message.includes('127.0.0.1'));
    if (language === 'en') assert.ok(!han.test(result.message), result.message);
  }
  for (const code of ['network', 'timeout', 'rate-limited', 'insufficient-balance', 'unavailable', 'bad-response']) {
    assert.match(jevMessage(code, 'zh', 'custom'), /自定义 Jev 端点/, code);
    assert.match(jevMessage(code, 'en', 'custom'), /custom Jev endpoint/i, code);
  }
  assert.equal(fake.requests.length, 2);
});
