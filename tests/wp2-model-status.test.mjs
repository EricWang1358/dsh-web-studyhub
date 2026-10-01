import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelStatus, createHostHandler } from '../lib/host.js';

const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
const SILICONFLOW = { provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct' };

/* A DSH 0.2 host as the plugin sees it: the llm registry and configurable
   provider directory (@deepseek-ai/dsh-llm), the settings forms that hold each
   provider profile (@deepseek-ai/dsh-settings), and the credentials seam
   (@deepseek-ai/dsh-credentials). Secret values are never available here. */
function host({ registered = ['deepseek-official', 'siliconflow'], configured = new Set(), accountModels = [], extra = {} } = {}) {
  const calls = { describeSettings: 0, describeRefs: [], resolve: 0 };
  const llm = {
    listProviders: () => registered.map(id => ({ id, name: { 'deepseek-official': 'DeepSeek', siliconflow: 'SiliconFlow', 'deepseek-account': 'DeepSeek Account', gateway: 'Gateway' }[id] || id })),
    listConfigurableProviders: () => [
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek-api-key', settingsPath: [] },
      { provider: 'siliconflow', displayName: 'SiliconFlow', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'siliconflow'] },
      { provider: 'gateway', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway'] },
      { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
    ],
    listModels: async provider => provider === 'deepseek-account' ? accountModels : [],
  };
  const settings = { describe(options) {
    calls.describeSettings++;
    assert.equal(options?.redactSecrets, true, 'settings must be read redacted');
    return [
      { ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' } },
      { ns: 'llm-pi-ai', value: { providers: { siliconflow: { apiKeyEnv: 'SILICONFLOW_API_KEY', api: 'openai-completions' }, gateway: { api: 'openai-completions' } } } },
    ];
  } };
  const credentials = {
    describe: async ref => { calls.describeRefs.push(ref); return configured.has(ref) ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }; },
    resolve: async () => { calls.resolve++; throw new Error('a readiness check must never read a secret value'); },
  };
  const services = { llm, settings, credentials, ...extra };
  return { ctx: { get: name => services[name] }, calls, services };
}

test('no selected route reports no-route and is never ready', async () => {
  for (const route of [null, undefined, {}, { provider: 'deepseek-official' }])
    assert.deepEqual(await modelStatus(host().ctx, route), { ready: false, reason: 'no-route', label: '', provider: '', model: '' });
});

test('a route whose provider is not registered in this host is no-route', async () => {
  const status = await modelStatus(host({ registered: ['deepseek-official'] }).ctx, { provider: 'kimi', model: 'k2' });
  assert.deepEqual(status, { ready: false, reason: 'no-route', label: 'kimi · k2', provider: 'kimi', model: 'k2' });
});

test('the default DeepSeek route without a stored key is no-credential, without a model call', async () => {
  const { ctx, calls } = host();
  const status = await modelStatus(ctx, DEEPSEEK);
  assert.deepEqual(status, { ready: false, reason: 'no-credential', label: 'DeepSeek · deepseek-v4-flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  assert.deepEqual(calls.describeRefs, ['DEEPSEEK_API_KEY']);
  assert.equal(calls.resolve, 0);
});

test('a stored key for the resolved profile makes the route ready', async () => {
  assert.deepEqual(await modelStatus(host({ configured: new Set(['DEEPSEEK_API_KEY']) }).ctx, DEEPSEEK),
    { ready: true, reason: 'ok', label: 'DeepSeek · deepseek-v4-flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  const sf = host({ configured: new Set(['SILICONFLOW_API_KEY']) });
  assert.equal((await modelStatus(sf.ctx, SILICONFLOW)).reason, 'ok');
  assert.deepEqual(sf.calls.describeRefs, ['SILICONFLOW_API_KEY'], 'nested pi-ai profiles name their own reference');
  assert.equal((await modelStatus(host().ctx, SILICONFLOW)).reason, 'no-credential');
});

test('profiles that name no key, and live routes outside the directory, authenticate themselves', async () => {
  const { ctx, calls } = host({ registered: ['gateway', 'local-only'] });
  assert.equal((await modelStatus(ctx, { provider: 'gateway', model: 'm' })).reason, 'ok');
  assert.equal((await modelStatus(ctx, { provider: 'local-only', model: 'm' })).reason, 'ok');
  assert.deepEqual(calls.describeRefs, []);
});

test('the DeepSeek account route is ready only while signed in', async () => {
  const signedOut = host({ registered: ['deepseek-account'] });
  assert.equal((await modelStatus(signedOut.ctx, { provider: 'deepseek-account', model: 'deepseek-v4-pro' })).reason, 'no-credential');
  const signedIn = host({ registered: ['deepseek-account'], accountModels: [{ id: 'deepseek-v4-pro' }] });
  assert.equal((await modelStatus(signedIn.ctx, { provider: 'deepseek-account', model: 'deepseek-v4-pro' })).reason, 'ok');
});

test('hosts that cannot answer keep the previous permissive behaviour as unknown', async () => {
  const route = { provider: 'p', model: 'm' };
  assert.deepEqual(await modelStatus({ get: () => undefined }, route), { ready: true, reason: 'unknown', label: 'p · m', provider: 'p', model: 'm' });
  const noCredentials = host({ extra: { credentials: undefined } });
  assert.equal((await modelStatus(noCredentials.ctx, DEEPSEEK)).reason, 'unknown');
  const brokenSettings = host({ extra: { settings: { describe() { throw new Error('settings unavailable'); } } } });
  assert.deepEqual(await modelStatus(brokenSettings.ctx, DEEPSEEK), { ready: true, reason: 'unknown', label: 'DeepSeek · deepseek-v4-flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
});

test('settings are described at most once per short window while keys are re-checked every time', async () => {
  const configured = new Set();
  const { ctx, calls } = host({ configured });
  assert.equal((await modelStatus(ctx, DEEPSEEK)).ready, false);
  configured.add('DEEPSEEK_API_KEY');
  assert.equal((await modelStatus(ctx, DEEPSEEK)).ready, true, 'adding a key in Models settings applies on the next poll');
  assert.equal(calls.describeSettings, 1);
});

test('binding.get and the panel snapshot carry the model contract and keep modelReady consistent', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'study-model-status-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configured = new Set();
  const { services } = host({ configured });
  const session = { header: { cwd }, requestHeader: () => ({ config: DEEPSEEK }) };
  const ctx = { sessions: { get: id => id === 's' ? session : undefined }, get: name => services[name] };
  const handler = createHostHandler(ctx, {}, () => async () => '{}');
  const run = async (action, args) => {
    const response = await handler('call', { sessionId: 's', action, args });
    assert.equal(response.ok, true, response.error?.message);
    return response.value;
  };
  const bound = await run('binding.get');
  // binding.model stays the custom model id that Settings saves back through binding.set.
  assert.equal(bound.model, '');
  assert.deepEqual(bound.modelStatus, { ready: false, reason: 'no-credential', label: 'DeepSeek · deepseek-v4-flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' });
  const blocked = await run('snapshot');
  assert.equal(blocked.modelReady, false, 'Generate must not be offered for a route without a key');
  assert.deepEqual(blocked.model, bound.modelStatus);
  configured.add('DEEPSEEK_API_KEY');
  const ready = await run('snapshot', { since: blocked.fingerprint });
  assert.equal(ready.unchanged, undefined, 'a newly stored key must refresh an otherwise unchanged library');
  assert.equal(ready.modelReady, true);
  assert.deepEqual(ready.model, { ...bound.modelStatus, ready: true, reason: 'ok' });
  assert.equal((await run('snapshot', { since: ready.fingerprint })).unchanged, true);
});

test('a snapshot without a model capability is never reported ready', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'study-model-status-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { services } = host({ configured: new Set(['DEEPSEEK_API_KEY']) });
  const session = { header: { cwd }, requestHeader: () => ({ config: DEEPSEEK }) };
  // No completion factory: the host cannot run model work for this panel.
  const handler = createHostHandler({ sessions: { get: () => session }, get: name => services[name] }, {});
  const value = (await handler('call', { sessionId: 's', action: 'snapshot' })).value;
  assert.equal(value.modelReady, false);
  assert.equal(value.model.ready, false);
  assert.equal(value.model.reason, 'unknown');
});

test('the study_workspace tool reports the same model contract to the agent', async t => {
  let plugin;
  try { plugin = await import('../lib/index.js'); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai')) { t.skip('DSH SDK absent'); return; }
    throw error;
  }
  const cwd = await mkdtemp(join(tmpdir(), 'study-model-tool-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { services } = host();
  const tools = [];
  const ctx = {
    tools: { register: tool => tools.push(tool) }, commands: { register() {} }, systemPrompt: { section() {} },
    sessions: { get: () => undefined }, llm: services.llm,
    get: name => name === 'connection' ? { fetch: { register: () => () => {} } } : services[name],
    inject: (_deps, fn) => fn(ctx), effect: fn => fn(),
  };
  plugin.apply(ctx, {});
  const agent = { id: 'a', session: { header: { cwd }, requestHeader: () => ({ config: DEEPSEEK }) } };
  const tool = tools.find(item => item.name === 'study_workspace');
  const bound = await tool.execute({ action: 'binding.get' }, { agent });
  assert.equal(bound.modelStatus.reason, 'no-credential');
  const snapshot = await tool.execute({ action: 'snapshot' }, { agent });
  assert.equal(snapshot.modelReady, false);
  assert.equal(snapshot.model.reason, 'no-credential');
});
