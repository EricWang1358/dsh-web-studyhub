import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WP16 item 1: a reasoning-effort preference for question generation.
// The binding stores it, the route applies it only when the effective model
// offers it, and Settings gets the list of levels the model offers.
const effort = await import('../lib/reasoning-effort.js');
const host = await import('../lib/host.js');

const LEVELS = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
const fakeLlm = (efforts = LEVELS, counter = { calls: 0 }) => ({
  resolveModelInfo: async () => { counter.calls++; return { reasoning: { efforts } }; },
});
const plain = (route) => JSON.parse(JSON.stringify(route));
const tmp = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wp16-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('a stored preference is trimmed, bounded and never invented', () => {
  assert.equal(effort.cleanEffortPreference('  high '), 'high');
  assert.equal(effort.cleanEffortPreference(''), '');
  assert.equal(effort.cleanEffortPreference(undefined), '');
  assert.equal(effort.cleanEffortPreference(null), '');
  assert.equal(effort.cleanEffortPreference(42), '42');
  assert.equal(effort.cleanEffortPreference('x'.repeat(200)).length, 64);
});

test('efforts come from the model info, lowest first, and are cached per exact model', async () => {
  const counter = { calls: 0 };
  const ctx = { llm: fakeLlm(LEVELS, counter) };
  assert.deepEqual(await effort.modelEfforts(ctx, 'p', 'm'), LEVELS);
  assert.deepEqual(await effort.modelEfforts(ctx, 'p', 'm'), LEVELS);
  assert.equal(counter.calls, 1, 'one lookup serves a polling burst');
  await effort.modelEfforts(ctx, 'p', 'other');
  assert.equal(counter.calls, 2, 'another model is looked up on its own');
  assert.deepEqual(await effort.modelEfforts({}, 'p', 'm'), [], 'a host without a model registry offers nothing');
});

test('effort entries are normalised to {id, name} and junk is dropped', async () => {
  const ctx = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 7, name: 'Seven' }, null, { name: 'no id' }, 'bad'] } }) } };
  assert.deepEqual(await effort.modelEfforts(ctx, 'p', 'norm'), [{ id: 'low', name: 'low' }, { id: '7', name: 'Seven' }]);
});

test('a slow or failing lookup yields an empty list instead of an error, and is not retried in a burst', async () => {
  const slow = { calls: 0 };
  const ctx = { llm: { resolveModelInfo: (_p, _m, signal) => { slow.calls++; return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))); } } };
  const started = Date.now();
  assert.deepEqual(await effort.modelEfforts(ctx, 'p', 'slow', undefined, { timeoutMs: 40 }), []);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await effort.modelEfforts(ctx, 'p', 'slow', undefined, { timeoutMs: 40 }), []);
  assert.equal(slow.calls, 1, 'the failure is remembered briefly');
  const failing = { llm: { resolveModelInfo: async () => { throw new Error('boom'); } } };
  assert.deepEqual(await effort.modelEfforts(failing, 'p', 'broken'), []);
});

test('the preference is applied when the model offers it and dropped silently otherwise', async () => {
  const ctx = { llm: fakeLlm() };
  const route = (reasoningEffort) => effort.withEffortPreference({ provider: 'p', model: 'm', ...(reasoningEffort ? { reasoningEffort } : {}) }, 'high');
  assert.deepEqual(await effort.effortRoute(ctx, route('low')), { provider: 'p', model: 'm', reasoningEffort: 'high' }, 'overrides the followed session value');
  assert.deepEqual(await effort.effortRoute(ctx, route()), { provider: 'p', model: 'm', reasoningEffort: 'high' }, 'also on a custom model with no value');
  const unsupported = effort.withEffortPreference({ provider: 'p', model: 'm', reasoningEffort: 'low' }, 'max');
  assert.deepEqual(await effort.effortRoute(ctx, unsupported), { provider: 'p', model: 'm', reasoningEffort: 'low' }, 'unknown id falls back to the route own value');
  assert.deepEqual(await effort.effortRoute({ llm: fakeLlm([]) }, route('low')), { provider: 'p', model: 'm', reasoningEffort: 'low' }, 'a model without levels keeps the route');
  assert.deepEqual(await effort.effortRoute({}, route('low')), { provider: 'p', model: 'm', reasoningEffort: 'low' }, 'a host without model info keeps the route');
});

test('an empty preference follows the route untouched', async () => {
  const ctx = { llm: fakeLlm() };
  const plain = { provider: 'p', model: 'm', reasoningEffort: 'medium' };
  assert.equal(effort.withEffortPreference(plain, ''), plain);
  assert.equal(await effort.effortRoute(ctx, plain), plain);
  assert.equal(await effort.effortRoute(ctx, null), null);
});

test('the resolved route carries no hidden preference into other consumers', async () => {
  const marked = effort.withEffortPreference({ provider: 'p', model: 'm' }, 'high');
  assert.equal(JSON.stringify(marked), '{"provider":"p","model":"m"}', 'the marker never serialises');
  const resolved = await effort.effortRoute({ llm: fakeLlm() }, marked);
  assert.deepEqual(Object.getOwnPropertySymbols(resolved), []);
});

test('effort state tells Settings what is offered, what is in effect and why', async () => {
  const ctx = { llm: fakeLlm() };
  const followed = { provider: 'p', model: 'm', reasoningEffort: 'medium' };
  assert.deepEqual(await effort.effortState(ctx, followed, ''), { options: LEVELS, current: 'medium', followed: 'medium', source: 'session', applied: false });
  assert.deepEqual(await effort.effortState(ctx, followed, 'high'), { options: LEVELS, current: 'high', followed: 'medium', source: 'binding', applied: true });
  assert.deepEqual(await effort.effortState(ctx, { provider: 'p', model: 'm' }, ''), { options: LEVELS, current: '', followed: '', source: 'default', applied: false });
  assert.deepEqual(await effort.effortState(ctx, followed, 'max'), { options: LEVELS, current: 'medium', followed: 'medium', source: 'session', applied: false, stale: true },
    'a saved level the model does not offer is reported, not hidden');
  assert.deepEqual(await effort.effortState({ llm: fakeLlm([]) }, followed, 'high'), { options: [], current: '', followed: '', source: 'default', applied: false, stale: true });
  assert.deepEqual(await effort.effortState(ctx, null, ''), { options: [], current: '', followed: '', source: 'default', applied: false });
});

test('a model default level counts as what following gives when the session names none', async () => {
  const withDefault = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: LEVELS, defaultEffort: 'high' } }) } };
  assert.deepEqual(await effort.effortState(withDefault, { provider: 'p', model: 'd' }, ''), { options: LEVELS, current: 'high', followed: 'high', source: 'default', applied: false });
  assert.deepEqual(await effort.effortState(withDefault, { provider: 'p', model: 'd', reasoningEffort: 'low' }, ''), { options: LEVELS, current: 'low', followed: 'low', source: 'session', applied: false });
  assert.deepEqual(await effort.effortState(withDefault, { provider: 'p', model: 'd' }, 'medium'), { options: LEVELS, current: 'medium', followed: 'high', source: 'binding', applied: true });
  const unknownDefault = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: LEVELS, defaultEffort: 'turbo' } }) } };
  assert.equal((await effort.effortState(unknownDefault, { provider: 'p', model: 'u' }, '')).followed, '', 'a default the list does not contain is ignored');
});

test('binding.set stores the preference beside root and model, and an omitted value keeps it', async (t) => {
  const cwd = await tmp(t);
  assert.deepEqual(await host.saveBinding(cwd, { reasoningEffort: ' high ' }), { root: '', provider: '', model: '', reasoningEffort: 'high' });
  const saved = JSON.parse(await readFile(join(cwd, '.dsh-study-binding.json'), 'utf8'));
  assert.equal(saved.reasoningEffort, 'high');
  const kept = await host.saveBinding(cwd, { provider: 'p', model: 'm' });
  assert.equal(kept.reasoningEffort, 'high', 'older callers that only send root/model do not wipe the preference');
  const cleared = await host.saveBinding(cwd, { provider: 'p', model: 'm', reasoningEffort: '' });
  assert.equal(cleared.reasoningEffort, '', 'an explicit empty string follows the session again');
  const unknown = await host.saveBinding(cwd, { reasoningEffort: 'turbo-ultra' });
  assert.equal(unknown.reasoningEffort, 'turbo-ultra', 'unknown ids are stored; only the route decides whether to apply them');
  await assert.rejects(host.saveBinding(cwd, { reasoningEffort: { id: 'high' } }), /reasoning effort/i);
});

test('binding() exposes the preference and marks the route it applies to', async (t) => {
  const cwd = await tmp(t);
  const none = await host.binding(cwd, {}, { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.equal(none.reasoningEffort, '');
  assert.equal(effort.preferenceOf(none.route), '');
  await writeFile(join(cwd, '.dsh-study-binding.json'), JSON.stringify({ root: '', provider: 'c', model: 'cm', reasoningEffort: 'high' }));
  const custom = await host.binding(cwd, {}, { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.equal(custom.reasoningEffort, 'high');
  assert.deepEqual(plain(custom.route), { provider: 'c', model: 'cm' });
  assert.equal(effort.preferenceOf(custom.route), 'high', 'custom model + preference');
  await writeFile(join(cwd, '.dsh-study-binding.json'), JSON.stringify({ root: '', provider: '', model: '', reasoningEffort: 'high' }));
  const following = await host.binding(cwd, {}, { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.deepEqual(plain(following.route), { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.equal(effort.preferenceOf(following.route), 'high', 'followed session + preference');
});

const sessionCtx = (config, efforts = LEVELS) => ({
  sessions: { get: () => ({ header: { cwd: SESSION_CWD.value }, requestHeader: () => ({ config }) }) },
  get: () => undefined,
  llm: fakeLlm(efforts),
});
const SESSION_CWD = { value: '' };
const call = (ctx, action, args = {}) => host.createHostHandler(ctx, {}, undefined)('call', { sessionId: 's', action, args });

test('binding.get tells the panel which levels the model in effect offers', async (t) => {
  SESSION_CWD.value = await tmp(t);
  const ctx = sessionCtx({ provider: 'p', model: 'm', reasoningEffort: 'medium' });
  const first = await call(ctx, 'binding.get');
  assert.equal(first.ok, true);
  assert.deepEqual(first.value.effort, { options: LEVELS, current: 'medium', followed: 'medium', source: 'session', applied: false });
  const saved = await call(ctx, 'binding.set', { reasoningEffort: 'high' });
  assert.equal(saved.value.reasoningEffort, 'high');
  assert.deepEqual(saved.value.effort, { options: LEVELS, current: 'high', followed: 'medium', source: 'binding', applied: true });
  const none = await call(sessionCtx({ provider: 'p', model: 'plain' }, []), 'binding.get');
  assert.deepEqual(none.value.effort.options, [], 'a model without levels offers nothing');
  assert.equal(none.value.effort.stale, true, 'and the saved preference is reported as stale');
});

test('binding.get never fails because the model catalogue does', async (t) => {
  SESSION_CWD.value = await tmp(t);
  const ctx = sessionCtx({ provider: 'p', model: 'm' });
  ctx.llm = { resolveModelInfo: async () => { throw new Error('catalog down'); } };
  const response = await call(ctx, 'binding.get');
  assert.equal(response.ok, true);
  assert.deepEqual(response.value.effort.options, []);
});

test('the preview model can offer levels so Settings can be exercised without a provider', async (t) => {
  const { createPreviewServer, previewCall, previewOptions } = await import('../scripts/preview-server.mjs');
  assert.deepEqual(previewOptions([], { STUDY_FAKE_EFFORTS: ' low, medium ,high,' }).efforts, ['low', 'medium', 'high']);
  const dir = await tmp(t);
  const preview = await createPreviewServer({ libraryRoot: join(dir, 'lib'), home: join(dir, 'home'), port: 0, model: 'fake', efforts: ['low', 'medium', 'high'] });
  t.after(() => preview.close());
  const first = await previewCall(preview, 'binding.get');
  assert.deepEqual(first.effort.options.map((item) => item.id), ['low', 'medium', 'high']);
  assert.equal(first.effort.current, 'medium');
  const saved = await previewCall(preview, 'binding.set', { reasoningEffort: 'high' });
  assert.deepEqual([saved.reasoningEffort, saved.effort.current, saved.effort.source], ['high', 'high', 'binding']);
  const kept = await previewCall(preview, 'binding.set', { root: '' });
  assert.equal(kept.reasoningEffort, 'high', 'omitting the level keeps it');
});

// -- call sites ------------------------------------------------------------
let plugin;
try { plugin = await import('../lib/index.js'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const needsSdk = (t) => { if (plugin?.modelCompletion) return false; t.skip('Host SDK absent'); return true; };
const completionCtx = (efforts = LEVELS) => {
  const configs = [];
  return { configs, ctx: { get: () => undefined, llm: { ...fakeLlm(efforts),
    resolveCallConfig: async (config) => (configs.push(config), config),
    async *stream() { yield { type: 'text-delta', text: '{}' }; } } } };
};

test('question generation sends the preferred level to the model call', async (t) => {
  if (needsSdk(t)) return;
  const { ctx, configs } = completionCtx();
  const followed = effort.withEffortPreference({ provider: 'p', model: 'm', reasoningEffort: 'low' }, 'high');
  await plugin.modelCompletion(ctx, () => followed, 's')('sys', 'prompt');
  assert.equal(String(configs[0].reasoningEffort), 'high');
  const unsupported = effort.withEffortPreference({ provider: 'p', model: 'm', reasoningEffort: 'low' }, 'max');
  await plugin.modelCompletion(ctx, () => unsupported, 's')('sys', 'prompt');
  assert.equal(String(configs[1].reasoningEffort), 'low', 'ignored when the model does not offer it');
  await plugin.modelCompletion(ctx, () => ({ provider: 'p', model: 'm', reasoningEffort: 'medium' }), 's')('sys', 'prompt');
  assert.equal(String(configs[2].reasoningEffort), 'medium', 'an empty preference follows the session');
});

test('assist improve and generation phases share the preference; 陪学 stays at the lowest level', async (t) => {
  if (needsSdk(t)) return;
  const { ctx, configs } = completionCtx([{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }, { id: 'off', name: 'Off' }]);
  const marked = effort.withEffortPreference({ provider: 'p', model: 'm', reasoningEffort: 'high' }, 'high');
  const heavy = plugin.modelCompletion(ctx, () => marked, 's');
  await heavy('sys', 'prompt', { task: 'assist', signal: new AbortController().signal, route: marked });
  assert.equal(String(configs[0].reasoningEffort), 'high', 'assist (improve) call');
  const events = [];
  await heavy('sys', 'prompt', { jobId: 'job1234', stage: 'Writing', signal: new AbortController().signal, onEvent: (event) => events.push(event) });
  assert.equal(String(configs[1].reasoningEffort), 'high', 'a generation phase on the direct path');
  assert.ok(events.some((event) => event.reasoningEffort === 'high'), 'the generation step records the level it used');
  const light = plugin.modelCompletion(ctx, () => marked, 's', { light: true });
  await light('sys', 'prompt', { maxTokens: 300 }).catch(() => {});
  assert.equal(String(configs[2].reasoningEffort), 'off', '陪学 forces the cheapest level whatever the preference');
});

test('a native generation child runs on the preferred level', async (t) => {
  if (needsSdk(t)) return;
  const { ctx } = completionCtx();
  const started = [];
  const parent = { id: 's' };
  const subagents = {
    getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }),
    start: async (_provider, spec) => { started.push(spec); return { id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: '{}' }] }), dispose() {} }; },
  };
  const nativeCtx = { ...ctx, get: (name) => name === 'subagents' ? subagents : name === 'agents' ? { get: () => parent } : undefined };
  const marked = effort.withEffortPreference({ provider: 'p', model: 'm', reasoningEffort: 'low' }, 'high');
  await plugin.modelCompletion(nativeCtx, () => marked, 's')('sys', 'prompt', { jobId: 'job1234', stage: 'Writing', onEvent() {}, signal: new AbortController().signal });
  assert.equal(started[0].agentOptions.reasoningEffort, 'high');
  assert.deepEqual(Object.getOwnPropertySymbols(started[0].agentOptions), [], 'the child never sees the marker');
});
