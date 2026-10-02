import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_JEV_PROVIDER, JEV_PROVIDERS, JEV_PROVIDER_IDS, isKeyEnvName, jevProvider, keyFromEnvironment } from '../lib/jev-providers.js';
import { JEV, JEV_MESSAGES, JEV_MESSAGES_EN, JevError, createJevClient, jevMessage, mapJevStatus, noul } from '../lib/jev.js';
import { JEV_NOTICE_VERSION, jevGate, jevSettingsPath, publicJevSettings, readJevSettings, saveJevSettings } from '../lib/jev-settings.js';
import { createJevRuntime, createBreaker } from '../lib/jev-runtime.js';
import { createJevUsage } from '../lib/jev-usage.js';
import { StudyService } from '../lib/service.js';
import { FAKE_KEY, FAKE_PATHS, startFakeJev } from './helpers/fake-jev.mjs';

/* Provider presets of the experimental Jev layer: TypeSafe's own API (the default, unchanged) and OpenCode Zen's two Jev models. The
   key may come from an environment variable (DSH's "OpenCode 2" account keeps its key in OPENCODE_GO_API_KEY_2) and is then never
   stored, shown or logged. Everything here meets only the local fake server. */

const han = /[㐀-鿿]/;
const PASTED = 'tsk_pasted_typesafe_key_0000000000000000PSTD';
const ENV_KEY = FAKE_KEY;
const WATCHED = ['JEV_API_KEY', 'JEV_BASE_URL', 'OPENCODE_GO_API_KEY_2', 'MY_ZEN_KEY', 'DSH_HOME'];

async function withHome(t, { serverOptions } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'study-jev-providers-'));
  const before = Object.fromEntries(WATCHED.map(name => [name, process.env[name]]));
  for (const name of WATCHED) delete process.env[name];
  process.env.DSH_HOME = home;
  const fake = serverOptions === false ? null : await startFakeJev(serverOptions);
  t.after(async () => {
    await fake?.close();
    for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await rm(home, { recursive: true, force: true });
  });
  return { home, fake };
}
const quiet = fake => createJevRuntime({ baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0, usage: createJevUsage() });
const open = (extra = {}) => saveJevSettings({ confirm: true, enabled: true, features: { courseSuggest: true }, ...extra });

/* ---- the preset table ------------------------------------------------------------------------------------------------- */

test('the preset table: TypeSafe stays the default and the two OpenCode Zen presets point at the Zen endpoint with their model ids', () => {
  assert.deepEqual(JEV_PROVIDER_IDS, ['typesafe', 'opencode-zen-free', 'opencode-zen']);
  assert.equal(DEFAULT_JEV_PROVIDER, 'typesafe');
  const typesafe = JEV_PROVIDERS.typesafe, free = JEV_PROVIDERS['opencode-zen-free'], paid = JEV_PROVIDERS['opencode-zen'];
  assert.deepEqual([typesafe.baseUrl, typesafe.path, typesafe.model, typesafe.defaultKeyEnv], [JEV.baseUrl, JEV.path, JEV.model, 'JEV_API_KEY']);
  assert.equal(`${free.baseUrl}${free.path}`, 'https://opencode.ai/zen/v1/systemone');
  assert.equal(`${paid.baseUrl}${paid.path}`, 'https://opencode.ai/zen/v1/systemone');
  assert.deepEqual([free.model, paid.model], ['jev-1.13-free', 'jev-1.13']);
  assert.deepEqual([free.defaultKeyEnv, paid.defaultKeyEnv], ['OPENCODE_GO_API_KEY_2', 'OPENCODE_GO_API_KEY_2']);
  assert.deepEqual([typesafe.family, free.family, paid.family], ['typesafe', 'opencode', 'opencode']);
  assert.ok(Object.isFrozen(JEV_PROVIDERS));
  for (const id of JEV_PROVIDER_IDS) assert.equal(JEV_PROVIDERS[id].id, id);
  assert.equal(jevProvider('nope').id, 'typesafe', 'an unknown id is the default');
  assert.equal(jevProvider(undefined).id, 'typesafe');
  assert.ok(!JSON.stringify(JEV_PROVIDERS).match(/\$|price|usd/i), 'no price in the table the UI reads');
});

test('an environment variable name is a plain identifier; anything else is refused', () => {
  for (const good of ['OPENCODE_GO_API_KEY_2', 'MY_ZEN_KEY', '_x1']) assert.equal(isKeyEnvName(good), true, good);
  for (const bad of ['', 'two words', '1ABC', 'A=B', 'a-b', 'x'.repeat(130), 'KEY\nX', null, 7]) assert.equal(isKeyEnvName(bad), false, String(bad));
  assert.deepEqual(keyFromEnvironment('opencode-zen', '', { OPENCODE_GO_API_KEY_2: ` ${ENV_KEY} ` }), { name: 'OPENCODE_GO_API_KEY_2', key: ENV_KEY, found: true });
  assert.deepEqual(keyFromEnvironment('opencode-zen', '', {}), { name: 'OPENCODE_GO_API_KEY_2', key: '', found: false });
  assert.deepEqual(keyFromEnvironment('opencode-zen', 'MY_ZEN_KEY', { MY_ZEN_KEY: ENV_KEY, OPENCODE_GO_API_KEY_2: 'other' }).name, 'MY_ZEN_KEY');
});

/* ---- settings: provider, key source, migration ------------------------------------------------------------------------ */

test('a jev.json from before the presets (no provider field) is TypeSafe, key, switches and confirmation intact', async t => {
  await withHome(t, { serverOptions: false });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(jevSettingsPath(), '..'), { recursive: true });
  await writeFile(jevSettingsPath(), JSON.stringify({ version: 1, key: PASTED, enabled: true, features: { courseSuggest: true }, threshold: 0.9, confirmedAt: '2026-10-01T00:00:00.000Z', noticeVersion: JEV_NOTICE_VERSION }));
  const settings = await readJevSettings();
  assert.equal(settings.provider, 'typesafe');
  assert.equal(settings.key, PASTED);
  assert.equal(settings.keySource, 'file');
  assert.equal(settings.confirmedAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(jevGate(settings, 'courseSuggest'), { ok: true });
  const view = publicJevSettings(settings);
  assert.equal(view.provider, 'typesafe');
  assert.equal(view.confirmed, true);
  assert.deepEqual(view.key, { set: true, hint: `••••${PASTED.slice(-4)}`, source: 'file', envName: 'JEV_API_KEY', envFound: false });
  assert.deepEqual(view.providers.map(item => item.id), JEV_PROVIDER_IDS);
  assert.equal(view.privacyUrl, JEV.privacyUrl);
  // Saving something unrelated writes no provider-specific surprise and keeps the typesafe fields as they were.
  await saveJevSettings({ threshold: 0.7 });
  const file = JSON.parse(await readFile(jevSettingsPath(), 'utf8'));
  assert.equal(file.key, PASTED);
  assert.equal(file.confirmedAt, '2026-10-01T00:00:00.000Z');
});

test('the provider is chosen by id; an unknown id is refused without echoing it; the default keyEnv follows the preset', async t => {
  await withHome(t, { serverOptions: false });
  assert.equal((await readJevSettings()).keyEnvName, 'JEV_API_KEY');
  let settings = await saveJevSettings({ provider: 'opencode-zen-free' });
  assert.equal(settings.provider, 'opencode-zen-free');
  assert.equal(settings.keyEnvName, 'OPENCODE_GO_API_KEY_2');
  assert.equal(publicJevSettings(settings).provider, 'opencode-zen-free');
  await assert.rejects(saveJevSettings({ provider: 'surprise-provider' }), error => /Jev/.test(error.message) && !error.message.includes('surprise'));
  assert.equal((await readJevSettings()).provider, 'opencode-zen-free', 'a refused change changes nothing');
  settings = await saveJevSettings({ provider: 'opencode-zen' });
  assert.equal(settings.provider, 'opencode-zen');
  settings = await saveJevSettings({ provider: 'typesafe' });
  assert.equal(settings.keyEnvName, 'JEV_API_KEY');
});

test('keyEnv names the variable that holds the key; it is validated, can be reset, and only the NAME is stored', async t => {
  await withHome(t, { serverOptions: false });
  process.env.MY_ZEN_KEY = ENV_KEY;
  let settings = await saveJevSettings({ provider: 'opencode-zen', keyEnv: 'MY_ZEN_KEY' });
  assert.equal(settings.keyEnvName, 'MY_ZEN_KEY');
  assert.equal(settings.key, ENV_KEY);
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).keyEnv, 'MY_ZEN_KEY');
  await assert.rejects(saveJevSettings({ keyEnv: 'has spaces' }), error => /环境变量/.test(error.message) && !error.message.includes('has spaces'));
  await assert.rejects(saveJevSettings({ keyEnv: 5 }), /环境变量/);
  settings = await saveJevSettings({ keyEnv: '' });
  assert.equal(settings.keyEnvName, 'OPENCODE_GO_API_KEY_2', 'an empty name goes back to the preset default');
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).keyEnv, undefined);
});

test('key resolution: a pasted key beats the environment variable named by keyEnv, which beats JEV_API_KEY (TypeSafe only)', async t => {
  await withHome(t, { serverOptions: false });
  process.env.JEV_API_KEY = 'tsk_from_JEV_API_KEY_00000000000000ENVA';
  // TypeSafe: JEV_API_KEY is both the default keyEnv and the fallback.
  let settings = await readJevSettings();
  assert.deepEqual([settings.key, settings.keySource, settings.keyFromVariable], ['tsk_from_JEV_API_KEY_00000000000000ENVA', 'env', 'JEV_API_KEY']);
  process.env.MY_ZEN_KEY = 'tsk_from_custom_variable_0000000000ENVB';
  settings = await saveJevSettings({ keyEnv: 'MY_ZEN_KEY' });
  assert.deepEqual([settings.key, settings.keyFromVariable], ['tsk_from_custom_variable_0000000000ENVB', 'MY_ZEN_KEY'], 'keyEnv beats JEV_API_KEY');
  delete process.env.MY_ZEN_KEY;
  settings = await readJevSettings();
  assert.deepEqual([settings.key, settings.keyFromVariable], ['tsk_from_JEV_API_KEY_00000000000000ENVA', 'JEV_API_KEY'], 'a keyEnv that is not set falls back to JEV_API_KEY');
  settings = await saveJevSettings({ key: PASTED });
  assert.deepEqual([settings.key, settings.keySource], [PASTED, 'file'], 'a pasted key wins');
  settings = await saveJevSettings({ key: '' });
  assert.equal(settings.keySource, 'env');
});

test('OpenCode presets read OPENCODE_GO_API_KEY_2 by default; a TypeSafe key is never sent to OpenCode, and a pasted OpenCode key is kept apart from the TypeSafe one', async t => {
  await withHome(t, { serverOptions: false });
  process.env.JEV_API_KEY = 'tsk_from_JEV_API_KEY_00000000000000ENVA';
  await saveJevSettings({ key: PASTED });
  let settings = await saveJevSettings({ provider: 'opencode-zen-free' });
  assert.equal(settings.key, '', 'neither the pasted TypeSafe key nor JEV_API_KEY is an OpenCode key');
  assert.equal(settings.keySource, '');
  assert.equal(publicJevSettings(settings).key.envFound, false);
  process.env.OPENCODE_GO_API_KEY_2 = ENV_KEY;
  settings = await readJevSettings();
  assert.deepEqual([settings.key, settings.keySource, settings.keyFromVariable, settings.keyEnvFound], [ENV_KEY, 'env', 'OPENCODE_GO_API_KEY_2', true]);
  const pastedZen = 'zen_pasted_opencode_key_00000000000000ZENP';
  settings = await saveJevSettings({ key: pastedZen });
  assert.deepEqual([settings.key, settings.keySource], [pastedZen, 'file'], 'pasted beats the variable');
  settings = await saveJevSettings({ provider: 'opencode-zen' });
  assert.equal(settings.key, pastedZen, 'the two OpenCode presets share one OpenCode key');
  settings = await saveJevSettings({ provider: 'typesafe' });
  assert.equal(settings.key, PASTED, 'switching back finds the TypeSafe key where it was');
  const file = JSON.parse(await readFile(jevSettingsPath(), 'utf8'));
  assert.equal(file.key, PASTED, 'the TypeSafe key stays in the field the previous version wrote');
  await saveJevSettings({ provider: 'opencode-zen-free' });
  settings = await saveJevSettings({ key: '' });
  assert.equal(settings.keySource, 'env', 'clearing the pasted OpenCode key leaves the TypeSafe one alone and falls to the variable');
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).key, PASTED);
});

test('a key that comes from an environment variable is never stored, never shown (not even its last four characters), never in the public view', async t => {
  const { home } = await withHome(t, { serverOptions: false });
  process.env.OPENCODE_GO_API_KEY_2 = ENV_KEY;
  await saveJevSettings({ provider: 'opencode-zen-free', confirm: true, enabled: true, features: { courseSuggest: true }, threshold: 0.9 });
  const view = publicJevSettings(await readJevSettings());
  assert.deepEqual(view.key, { set: true, hint: '', source: 'env', envName: 'OPENCODE_GO_API_KEY_2', envFound: true });
  const shown = JSON.stringify(view);
  assert.ok(!shown.includes(ENV_KEY) && !shown.includes(ENV_KEY.slice(-4)) && !shown.includes(ENV_KEY.slice(0, 12)));
  async function everyFile(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) { const path = join(directory, entry.name); if (entry.isDirectory()) found.push(...await everyFile(path)); else found.push(path); }
    return found;
  }
  const files = await everyFile(home);
  assert.ok(files.length >= 1);
  for (const file of files) assert.ok(!(await readFile(file, 'utf8')).includes(ENV_KEY), `${file} holds no key`);
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).key, undefined);
});

test('a malformed pasted key for OpenCode is refused with a message about OpenCode that does not echo it', async t => {
  await withHome(t, { serverOptions: false });
  await saveJevSettings({ provider: 'opencode-zen' });
  await assert.rejects(saveJevSettings({ key: 'bad key with spaces' }), error => /OpenCode/.test(error.message) && !error.message.includes('bad key'));
  assert.equal((await readJevSettings()).key, '');
});

test('a variable that is not visible to the process is reported as not found, with the key absent and the gate saying no-key', async t => {
  await withHome(t, { serverOptions: false });
  await saveJevSettings({ provider: 'opencode-zen', confirm: true, enabled: true, features: { courseSuggest: true } });
  const settings = await readJevSettings();
  const view = publicJevSettings(settings);
  assert.deepEqual([view.key.set, view.key.envName, view.key.envFound], [false, 'OPENCODE_GO_API_KEY_2', false]);
  assert.deepEqual(jevGate(settings, 'courseSuggest'), { ok: false, reason: 'no-key' });
});

/* ---- the confirmation belongs to one provider ------------------------------------------------------------------------- */

test('the privacy confirmation is per provider: changing provider asks again, going back finds the old confirmation, a new notice version voids it', async t => {
  await withHome(t, { serverOptions: false });
  process.env.OPENCODE_GO_API_KEY_2 = ENV_KEY;
  let settings = await saveJevSettings({ key: PASTED, confirm: true });
  assert.ok(settings.confirmedAt);
  const typesafeAt = settings.confirmedAt;
  settings = await saveJevSettings({ provider: 'opencode-zen-free' });
  assert.equal(settings.confirmedAt, '', 'the TypeSafe confirmation does not carry over');
  assert.equal(publicJevSettings(settings).confirmed, false);
  assert.deepEqual(jevGate(settings, null), { ok: false, reason: 'not-confirmed' });
  settings = await saveJevSettings({ confirm: true });
  assert.ok(settings.confirmedAt && settings.confirmedAt !== '');
  assert.deepEqual(jevGate(settings, null), { ok: true });
  settings = await saveJevSettings({ provider: 'opencode-zen' });
  assert.equal(settings.confirmedAt, '', 'free and paid are two providers with two notes');
  settings = await saveJevSettings({ provider: 'typesafe' });
  assert.equal(settings.confirmedAt, typesafeAt, 'the TypeSafe confirmation is still there');
  settings = await saveJevSettings({ provider: 'opencode-zen-free' });
  assert.ok(settings.confirmedAt, 'and so is the free one');
  const file = JSON.parse(await readFile(jevSettingsPath(), 'utf8'));
  assert.equal(file.confirmedAt, typesafeAt, 'the TypeSafe confirmation stays in the legacy fields');
  assert.equal(file.providers['opencode-zen-free'].noticeVersion, JEV_NOTICE_VERSION);
  // An older notice version for one provider voids only that provider.
  file.providers['opencode-zen-free'].noticeVersion = JEV_NOTICE_VERSION - 1;
  await writeFile(jevSettingsPath(), JSON.stringify(file));
  assert.equal((await readJevSettings()).confirmedAt, '');
  assert.equal((await saveJevSettings({ provider: 'typesafe' })).confirmedAt, typesafeAt);
  // Withdrawing is per provider too.
  await saveJevSettings({ provider: 'opencode-zen-free', confirm: true });
  await saveJevSettings({ confirm: false });
  assert.equal((await readJevSettings()).confirmedAt, '');
  assert.equal((await saveJevSettings({ provider: 'typesafe' })).confirmedAt, typesafeAt, 'withdrawing one leaves the others');
});

test('confirming and choosing a provider can happen in one change, and the confirmation lands on the chosen provider', async t => {
  await withHome(t, { serverOptions: false });
  const settings = await saveJevSettings({ provider: 'opencode-zen', confirm: true });
  assert.ok(settings.confirmedAt);
  assert.equal((await saveJevSettings({ provider: 'typesafe' })).confirmedAt, '');
});

/* ---- requests against the fake server --------------------------------------------------------------------------------- */

test('TypeSafe is unchanged: /v1/systemone, model jev-latest, the pasted key in the Authorization header', async t => {
  const { fake } = await withHome(t);
  await open({ key: fake.key });
  const result = await quiet(fake).run('courseSuggest', 'a source', { q: noul('Is it a source?') });
  assert.equal(result.ok, true);
  const request = fake.requests[0];
  assert.equal(request.path, FAKE_PATHS.typesafe);
  assert.equal(request.payload.model, 'jev-latest');
  assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(request.payload.questions.q.instructions, 'Is it a source?');
});

for (const [provider, model] of [['opencode-zen-free', 'jev-1.13-free'], ['opencode-zen', 'jev-1.13']]) {
  test(`${provider}: POST /zen/v1/systemone with model ${model} and the key from OPENCODE_GO_API_KEY_2, the test button and a feature call alike`, async t => {
    const { fake } = await withHome(t);
    process.env.OPENCODE_GO_API_KEY_2 = fake.key;
    await open({ provider });
    const runtime = quiet(fake);
    const tested = await runtime.test({});
    assert.equal(tested.ok, true, JSON.stringify(tested));
    const asked = await runtime.run('courseSuggest', 'a source', { q: noul('Is it a source?') });
    assert.equal(asked.ok, true);
    assert.equal(fake.requests.length, 2);
    for (const request of fake.requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.path, FAKE_PATHS.opencode);
      assert.equal(request.payload.model, model);
      assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`);
      assert.match(request.headers['content-type'], /application\/json/);
      assert.ok(Object.values(request.payload.questions).every(question => typeof question.instructions === 'string' && question.instructions));
    }
    assert.ok(!JSON.stringify(asked).includes(FAKE_KEY));
  });
}

test('JEV_BASE_URL still redirects every provider (the seam of previews and tests), and the preset path is kept', async t => {
  const { fake } = await withHome(t);
  process.env.JEV_BASE_URL = fake.baseUrl;
  process.env.OPENCODE_GO_API_KEY_2 = fake.key;
  await open({ provider: 'opencode-zen-free' });
  const runtime = createJevRuntime({ sleep: async () => {}, random: () => 0, usage: createJevUsage() });
  assert.equal((await runtime.test({})).ok, true);
  assert.equal(fake.requests[0].path, FAKE_PATHS.opencode);
});

test('the Zen path of the fake refuses an unknown model, so a client that asks for the wrong id fails here too', async t => {
  const { fake } = await withHome(t);
  const client = createJevClient({ apiKey: fake.key, baseUrl: fake.baseUrl, provider: 'opencode-zen', model: 'jev-latest', sleep: async () => {}, maxRetries: 0 });
  await assert.rejects(client.decide('state', { q: noul('Is it?') }), error => error.code === 'invalid-request');
});

test('a missing or wrong key is refused by the fake with 401 and mapped to invalid-key, naming the provider and never the key', async t => {
  const { fake } = await withHome(t);
  process.env.OPENCODE_GO_API_KEY_2 = 'a_wrong_zen_key_0000000000000000WRNG';
  await open({ provider: 'opencode-zen' });
  const result = await quiet(fake).test({ language: 'zh' });
  assert.deepEqual([result.ok, result.reason], [false, 'invalid-key']);
  assert.match(result.message, /OpenCode Zen/);
  assert.ok(!result.message.includes('WRNG'));
  const english = await quiet(fake).test({ language: 'en' });
  assert.match(english.message, /OpenCode Zen/);
  assert.ok(!han.test(english.message), english.message);
});

/* ---- error mapping ---------------------------------------------------------------------------------------------------- */

test('HTTP statuses map onto typed errors; 402 is its own insufficient-balance code and is neither retried nor mistaken for a bad key', () => {
  const code = (status, provider) => mapJevStatus(status, undefined, provider).code;
  for (const provider of ['typesafe', 'opencode-zen', 'opencode-zen-free']) {
    assert.deepEqual([401, 403, 402, 429, 500, 502, 503, 529, 422, 408].map(status => code(status, provider)),
      ['invalid-key', 'invalid-key', 'insufficient-balance', 'rate-limited', 'unavailable', 'unavailable', 'unavailable', 'overloaded', 'invalid-request', 'timeout'], provider);
  }
  assert.equal(mapJevStatus(402).retryable, false);
  assert.equal(mapJevStatus(429).retryable, true);
  assert.equal(mapJevStatus(503, undefined, 'opencode-zen').provider, 'opencode-zen');
  assert.ok(mapJevStatus(401, undefined, 'opencode-zen-free') instanceof JevError);
  const fatal = createBreaker({ limit: 5 });
  fatal.note({ ok: false, reason: 'insufficient-balance' });
  assert.equal(fatal.open, true, 'no retry can fix a missing balance');
});

test('every OpenCode failure is a plain sentence in both languages that names OpenCode Zen and holds no key, no state and no response body', async t => {
  const { fake } = await withHome(t);
  process.env.OPENCODE_GO_API_KEY_2 = fake.key;
  await open({ provider: 'opencode-zen-free' });
  const bodyText = 'SECRET_RESPONSE_BODY sk-live-should-not-show';
  const cases = [[401, 'invalid-key'], [402, 'insufficient-balance'], [429, 'rate-limited'], [500, 'unavailable'], [503, 'unavailable'], [529, 'overloaded']];
  for (const [status, reason] of cases) {
    fake.clearFailures();
    fake.fail(...Array(5).fill({ status, body: { error: bodyText, detail: bodyText } }));
    for (const language of ['zh', 'en']) {
      const result = await quiet(fake).test({ language });
      assert.deepEqual([result.ok, result.reason], [false, reason], `${status}/${language}`);
      assert.match(result.message, /OpenCode Zen/, `${status}/${language}`);
      assert.ok(!result.message.includes(fake.key) && !result.message.includes('SECRET_RESPONSE_BODY') && !result.message.includes('sk-live'));
      if (language === 'en') assert.ok(!han.test(result.message), result.message);
    }
  }
  fake.clearFailures();
  // Transient failures are retried exactly as before (429 and 5xx), a 402 is not.
  const waits = [];
  const runtime = createJevRuntime({ baseUrl: fake.baseUrl, sleep: async ms => { waits.push(ms); }, random: () => 0, usage: createJevUsage() });
  fake.requests.length = 0; fake.fail(429, 503);
  assert.equal((await runtime.test({})).ok, true);
  assert.equal(fake.requests.length, 3);
  fake.requests.length = 0; fake.fail(402);
  assert.equal((await runtime.test({})).reason, 'insufficient-balance');
  assert.equal(fake.requests.length, 1, 'a 402 is not retried');
});

test('network failure and timeout name the provider too; TypeSafe messages keep their exact wording', async () => {
  for (const code of ['network', 'timeout', 'bad-response', 'unexpected', 'insufficient-balance', 'invalid-key', 'rate-limited', 'overloaded', 'unavailable', 'invalid-request']) {
    for (const provider of ['opencode-zen', 'opencode-zen-free']) {
      assert.match(jevMessage(code, 'zh', provider), /OpenCode Zen/, `${code}/zh`);
      assert.match(jevMessage(code, 'en', provider), /OpenCode Zen/, `${code}/en`);
      assert.ok(!han.test(jevMessage(code, 'en', provider)), `${code}/en has no Han`);
    }
    assert.equal(jevMessage(code, 'zh', 'typesafe'), jevMessage(code, 'zh'), `${code}: TypeSafe is the default wording`);
    assert.equal(jevMessage(code, 'en', undefined), jevMessage(code, 'en', 'typesafe'));
  }
  assert.equal(JEV_MESSAGES['invalid-key'], 'Jev 密钥无效或已被撤销：请到「设置 › 实验性 · Jev 判断服务」重新填写一个有效的密钥。', 'the TypeSafe sentence is unchanged');
  assert.ok(JEV_MESSAGES['insufficient-balance'] && JEV_MESSAGES_EN['insufficient-balance']);
  assert.match(jevMessage('no-key', 'zh', 'opencode-zen'), /环境变量/);
  assert.match(jevMessage('no-key', 'en', 'opencode-zen'), /environment variable/);
});

test('a refused gate on an OpenCode preset explains where the key can come from, in both languages', async t => {
  const { fake } = await withHome(t);
  await open({ provider: 'opencode-zen' });
  const runtime = quiet(fake);
  const zh = await runtime.test({ language: 'zh' }), en = await runtime.test({ language: 'en' });
  assert.equal(zh.reason, 'no-key');
  assert.match(zh.message, /OpenCode Zen/);
  assert.match(en.message, /OpenCode Zen/);
  assert.ok(!han.test(en.message));
  assert.equal(fake.requests.length, 0);
});

test('the last failure the settings page shows remembers which provider it came from', async t => {
  const { fake } = await withHome(t);
  process.env.OPENCODE_GO_API_KEY_2 = 'a_wrong_zen_key_0000000000000000WRNG';
  await open({ provider: 'opencode-zen' });
  const runtime = quiet(fake);
  await runtime.test({});
  assert.deepEqual(runtime.lastFailure() && [runtime.lastFailure().reason, runtime.lastFailure().provider], ['invalid-key', 'opencode-zen']);
});

/* ---- a running service: operations, no leak ---------------------------------------------------------------------------- */

test('through the service: provider and keyEnv are set by jev.settings.set, the test works for the chosen provider, and no key reaches a file, a snapshot, an export, the usage page or the console', async t => {
  const { home, fake } = await withHome(t);
  const root = await mkdtemp(join(tmpdir(), 'study-jev-providers-lib-'));
  process.env.MY_ZEN_KEY = fake.key;
  const logs = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) { originals[level] = console[level]; console[level] = (...args) => { logs.push(args.map(String).join(' ')); }; }
  const service = new StudyService(root, { jev: { baseUrl: fake.baseUrl, sleep: async () => {}, random: () => 0 } });
  t.after(async () => { for (const [level, fn] of Object.entries(originals)) console[level] = fn; service.dispose(); await rm(root, { recursive: true, force: true }); });
  const call = (action, args) => service.call(action, args);
  const saved = await call('jev.settings.set', { provider: 'opencode-zen-free', keyEnv: 'MY_ZEN_KEY', confirm: true, enabled: true, features: { courseSuggest: true } });
  assert.deepEqual([saved.provider, saved.key.set, saved.key.source, saved.key.envName, saved.key.envFound, saved.confirmed], ['opencode-zen-free', true, 'env', 'MY_ZEN_KEY', true, true]);
  const tested = await call('jev.test', {});
  assert.deepEqual([tested.ok, tested.state], [true, 'valid']);
  assert.equal(fake.requests[0].path, FAKE_PATHS.opencode);
  assert.equal(fake.requests[0].payload.model, 'jev-1.13-free');
  await assert.rejects(call('jev.settings.set', { provider: 'surprise' }), error => !error.message.includes('surprise'));
  // Pasting a key for this provider is still possible and is stored.
  await call('jev.settings.set', { key: 'zen_pasted_opencode_key_00000000000000ZENP' });
  const everything = [JSON.stringify(await call('snapshot')), JSON.stringify(await call('export')), JSON.stringify(await call('jev.usage')), JSON.stringify(await call('jev.settings.get')), logs.join('\n')].join('\n');
  assert.ok(!everything.includes(FAKE_KEY), 'the environment key is nowhere');
  async function everyFile(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) { const path = join(directory, entry.name); if (entry.isDirectory()) found.push(...await everyFile(path)); else found.push(path); }
    return found;
  }
  for (const file of [...await everyFile(home), ...await everyFile(root)]) assert.ok(!(await readFile(file, 'utf8').catch(() => '')).includes(FAKE_KEY), `${file} holds no environment key`);
});
