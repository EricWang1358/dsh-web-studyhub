import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobControl, generationControl } from '../lib/job-control.js';
import { FOLLOW_MODEL, modelKey, modelOfKey, isModelValue } from '../lib/job-model.js';
import { EFFORT_PREFERENCE, routeOnModel, withEffortPreference } from '../lib/reasoning-effort.js';
import { hostOffersModel } from '../lib/host-capabilities.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { createHostHandler } from '../lib/host.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';

/* 「仅本任务生效」: the model of ONE running question run, a live value of its control (lib/job-model.js). The key, the rule that validates it,
   the route a call is sent on, the gateway's step option, the host completion of the legacy executor and the levels the box asks for. */

const A = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, B = { provider: 'siliconflow', model: 'Qwen/Qwen3-235B-A22B' };
const levels = (...ids) => ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
const ctxWith = (byModel = {}, providers) => ({ llm: {
  resolveModelInfo: async (_provider, model) => ({ reasoning: { efforts: byModel[model] ?? [] } }),
  ...(providers ? { listProviders: () => providers.map((id) => ({ id, name: id })) } : {}) } });

test('a model key is the pair Settings already uses; anything else is not one', () => {
  assert.equal(modelKey(A), JSON.stringify(['deepseek', 'deepseek-v4.1-flash']));
  assert.deepEqual(modelOfKey(modelKey(B)), B, 'a model id with a slash survives');
  assert.equal(modelOfKey(FOLLOW_MODEL), null);
  for (const bad of ['', '[]', '["only"]', '["a",""]', '[" ","m"]', 'deepseek/m', '{"provider":"a"}', '[1,2]', `["a","${'x'.repeat(201)}"]`, null, 3])
    assert.equal(isModelValue(bad), false, JSON.stringify(bad));
  assert.equal(isModelValue(FOLLOW_MODEL), true);
  assert.equal(isModelValue(modelKey(A)), true);
  assert.equal(modelKey({ provider: 'p' }), '');
});

test('the model rule refuses a malformed value and whatever the control does not accept, and a refused patch changes nothing', () => {
  const job = {}, asked = [];
  const control = createJobControl({ job, spec: { count: { type: 'int', min: 1, max: 4 }, model: { type: 'model' } }, values: { count: 2, model: FOLLOW_MODEL },
    accepts: (key, value) => { asked.push([key, value]); return value !== modelKey(B); } });
  assert.deepEqual(job.control.limits.model, { type: 'model' });
  assert.deepEqual(control.patch({ model: modelKey(A) }).applied, { model: modelKey(A) });
  assert.equal(job.control.values.model, modelKey(A), 'the job shows the model in force');
  assert.throws(() => control.patch({ model: 'gpt' }), /Invalid value for control model/);
  assert.throws(() => control.patch({ count: 3, model: modelKey(B) }), /Invalid value for control model/, 'a model the host does not offer');
  assert.equal(control.values.count, 2, 'not even the valid half of the patch');
  assert.deepEqual(control.patch({ model: FOLLOW_MODEL }).changed, { model: FOLLOW_MODEL });
  assert.ok(asked.some(([key]) => key === 'model'));
});

test('a question run follows the host model until the learner picks one; the host is asked whether it offers it', () => {
  const offered = new Set(['deepseek']);
  const job = {}, control = generationControl({ job, request: { performance: { concurrency: 2 } }, offers: (route) => offered.has(route.provider) });
  assert.equal(control.values.model, FOLLOW_MODEL);
  assert.deepEqual(Object.keys(control.spec), ['concurrency', 'model', 'effortPlanning', 'effortReview', 'effortWriting', 'effortRepair', 'applySuggestions'],
    'the model sits with the other choices of the run, before the levels it decides');
  control.patch({ model: modelKey(A) });
  assert.throws(() => control.patch({ model: modelKey(B) }), /model/, 'a provider the host does not register');
  assert.equal(control.values.model, modelKey(A));
  // A host that cannot say (the preview, an older DSH) is permissive, as the model status is.
  const open = generationControl({ job: {}, request: { performance: {} }, offers: () => undefined });
  assert.equal(open.patch({ model: modelKey(B) }).values.model, modelKey(B));
  assert.equal(generationControl({ job: {}, request: {} }).patch({ model: modelKey(B) }).values.model, modelKey(B));
});

test('the host offers a model when it registers its provider; a host without a registry cannot say', () => {
  assert.equal(hostOffersModel(ctxWith({}, ['deepseek']), A), true);
  assert.equal(hostOffersModel(ctxWith({}, ['deepseek']), B), false);
  assert.equal(hostOffersModel(ctxWith({}), A), undefined);
  assert.equal(hostOffersModel({ llm: { listProviders: () => { throw new Error('busy'); } } }, A), undefined);
});

test('the route of a call: the chosen model, the Settings level marker on it, the session level only when this model has it', async () => {
  const ctx = ctxWith({ [A.model]: levels('off', 'high'), [B.model]: levels('low', 'medium', 'high') });
  const base = withEffortPreference({ ...A, reasoningEffort: 'off' }, 'high');
  assert.equal(await routeOnModel(ctx, base, null), base, 'following: the host route as it is');
  assert.equal(await routeOnModel(ctx, base, A), base, 'the same model: the same route');
  const other = await routeOnModel(ctx, base, B);
  assert.deepEqual(JSON.parse(JSON.stringify(other)), B, 'the session level "off" belongs to the other model and is dropped');
  assert.equal(other[EFFORT_PREFERENCE], 'high', 'the learner level of Settings still rides on it');
  const kept = await routeOnModel(ctx, { ...A, reasoningEffort: 'high' }, B);
  assert.deepEqual(kept, { ...B, reasoningEffort: 'high' }, 'a level the chosen model also offers is kept');
});

// ---- the unified runtime's gateway ----

function gatewayWith(ctx, route = A) {
  const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
  const controller = new AbortController(), seen = [];
  const host = { ctx, sessionId: 'fixture', route: () => route, complete: async (_system, _prompt, options) => { seen.push(options.route); return 'ok'; } };
  const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); } };
  return { record, seen, gateway: createModelGateway({ context, record, host }) };
}
const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'high', executionMode: 'direct', budget: null };

test('a gateway step sent on the run model: the call uses it and its levels; without the option the host route as before', async () => {
  const ctx = ctxWith({ [A.model]: levels('off', 'max'), [B.model]: levels('low', 'medium', 'high') }, ['deepseek', 'siliconflow']);
  const { gateway, seen } = gatewayWith(ctx);
  await gateway.step('author:1', policy, { route: B }).complete('system', 'prompt');
  await gateway.step('author:2', policy).complete('system', 'prompt');
  assert.deepEqual(seen[0], { ...B, reasoningEffort: 'high' }, 'the level is chosen among the levels of the chosen model');
  assert.deepEqual(seen[1], { ...A, reasoningEffort: 'max' }, 'a step without the option is unchanged');
  assert.throws(() => gateway.step('x', policy, { route: { provider: 'p' } }), { code: 'invalid-model-route' });
  assert.throws(() => gateway.step('x', policy, { route: 'deepseek' }), { code: 'invalid-model-route' });
});

test('a run model the host no longer offers fails the call with the words of a missing provider', async () => {
  const { gateway, seen, record } = gatewayWith(ctxWith({}, ['deepseek']));
  await assert.rejects(gateway.step('author:1', policy, { route: B }).complete('system', 'prompt'), (error) => error.code === 'NO_ADAPTER' && /siliconflow/.test(error.message));
  assert.equal(seen.length, 0, 'nothing was sent');
  assert.equal(record.runtime.steps[0].status, 'failed');
});

// ---- the legacy executor's host completion ----

let plugin;
try { plugin = await import('../lib/index.js'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const needsSdk = (t) => { if (plugin?.modelCompletion) return false; t.skip('Host SDK absent'); return true; };

test('a generation phase of the legacy executor runs on the model its execution names, with that model levels', async (t) => {
  if (needsSdk(t)) return;
  const configs = [];
  const llm = { ...ctxWith({ [A.model]: levels('off', 'max'), [B.model]: levels('low', 'medium', 'high') }, ['deepseek', 'siliconflow']).llm,
    resolveCallConfig: async (config) => (configs.push(config), config), async *stream() { yield { type: 'text-delta', text: '{}' }; } };
  const complete = plugin.modelCompletion({ get: () => undefined, llm }, () => ({ ...A, reasoningEffort: 'off' }), 's');
  const execution = (extra) => ({ jobId: 'job1234', stage: 'Reviewing ambiguity and source support', stageEffort: { review: 'high' }, signal: new AbortController().signal, onEvent() {}, ...extra });
  await complete('sys', 'prompt', execution({ model: B }));
  await complete('sys', 'prompt', execution({}));
  assert.deepEqual([configs[0].provider, configs[0].model, String(configs[0].reasoningEffort)], [B.provider, B.model, 'high']);
  assert.deepEqual([configs[1].provider, configs[1].model, String(configs[1].reasoningEffort)], [A.provider, A.model, 'max'], 'without one, the host route');
  await assert.rejects(complete('sys', 'prompt', execution({ model: { provider: 'gone', model: 'm' } })), (error) => error.code === 'NO_ADAPTER');
});

// ---- the levels the box asks the host for ----

test('model.efforts: the levels the host reports for one model, null when it cannot describe models', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'study-model-efforts-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const sessions = new Map([['s1', { header: { cwd } }]]);
  const ask = (ctx, args) => createHostHandler({ sessions, ...ctx }, {}, undefined)('call', { sessionId: 's1', action: 'model.efforts', args });
  const described = await ask(ctxWith({ [B.model]: levels('low', 'high') }), B);
  assert.deepEqual(described, { ok: true, value: { options: levels('low', 'high') } });
  assert.deepEqual(await ask(ctxWith({}), A), { ok: true, value: { options: [] } }, 'a model without levels');
  assert.deepEqual(await ask({}, A), { ok: true, value: { options: null } }, 'a host that cannot say');
  assert.equal((await ask(ctxWith({}), { provider: 'p' })).ok, false, 'a provider and a model are both needed');
});
