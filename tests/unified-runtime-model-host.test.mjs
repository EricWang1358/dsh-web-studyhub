import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { preparedModelHost } from '../lib/runtime/models.js';
import { languageSystem } from '../lib/language.js';

const executor = { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'model-host' }), inspect: () => ({ state: 'lost' }),
  start({ run, cancel }) { void run(); return { id: 'native-1', ownerAgentId: 'owner', stop: cancel, append() {} }; } };
const policy = { purpose: 'probe', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null };

function runtime(t, definition, modelHost) {
  const ctx = new Context(), lifecycle = createJobLifecycle('/private-library', createRuntimeWork());
  lifecycle.register(ctx, 'probe.v1', { kind: 'probe', version: 1, capabilities: { executionModes: ['direct'] }, ...definition });
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  return lifecycle.scoped({ owner: Symbol('owner'), domain: 'probe.v1', executor, modelHost });
}

test('the gateway host is prepared like every model call: UI language once, local images omitted', async () => {
  const seen = [], raw = async (system, prompt) => { seen.push({ system, prompt }); return 'ok'; };
  const host = preparedModelHost({ language: 'en', jobModelHost: { ctx: {}, route: { provider: 'p', model: 'm' }, complete: raw } });
  await host.complete(languageSystem('You help.', 'en'), 'Look ![x](data:image/png;base64,AAAA) here');
  assert.equal(seen[0].system.split('Application language preference').length, 2, 'one preference even when the family added it already');
  assert.ok(!seen[0].prompt.includes('base64,AAAA'), 'local image bytes are omitted');
  assert.equal(preparedModelHost({}), undefined, 'no session model, no host');
  assert.equal(await preparedModelHost({ jobModelHost: { complete: raw }, complete: async () => 'swapped' }).complete('s', 'p'), 'swapped', 'the own complete of the service (its `complete` seam) is the one in use');
  const given = await preparedModelHost({ jobModelHost: { complete: raw }, light: async () => 'given' }).light('s', 'p');
  assert.equal(given, 'given', 'a light model the service was given (its `light` seam) is the light lane');
});

test('a step asks for the light lane explicitly, and only for direct execution', async t => {
  const used = [];
  const modelHost = { ctx: {}, route: { provider: 'p', model: 'm' },
    complete: async () => { used.push('complete'); return 'full'; }, light: async () => { used.push('light'); return 'quick'; } };
  const port = runtime(t, { run: async context => {
    const quick = await context.gateway.step('quick', policy, { model: 'light' }).complete('s', 'p');
    const full = await context.gateway.step('full', policy).complete('s', 'p');
    assert.throws(() => context.gateway.step('bad', { ...policy, executionMode: 'agent-preferred' }, { model: 'light' }), { code: 'invalid-model-lane' });
    assert.throws(() => context.gateway.step('bad2', policy, { model: 'turbo' }), { code: 'invalid-model-lane' });
    return { refs: [], completeness: quick === 'quick' && full === 'full' ? 'complete' : 'partial' };
  } }, modelHost);
  const job = await port.submit('probe', {}), done = await port.wait(job.jobId);
  assert.equal(done.status, 'complete', done.error?.message);
  assert.equal(done.result.completeness, 'complete');
  assert.deepEqual(used, ['light', 'complete']);
});

test('the light lane gets a raised reasoning preference by name and nothing for the base levels', async t => {
  const asked = [], modelHost = { ctx: {}, route: { provider: 'p', model: 'm' }, complete: async () => 'full', light: async (_s, _p, request) => { asked.push(request.reasoningEffort); return 'quick'; } };
  const port = runtime(t, { run: async context => {
    for (const requestedEffort of ['lowest', 'default', 'high']) await context.gateway.step(requestedEffort, { ...policy, requestedEffort }, { model: 'light' }).complete('s', 'p');
    return { refs: [] };
  } }, modelHost);
  await port.wait((await port.submit('probe', {})).jobId);
  assert.deepEqual(asked, [undefined, undefined, 'high']);
});

test('a definition without persistence announces settlement once before observers resume; a failed sink keeps the outcome', async t => {
  const delivered = [];
  const port = runtime(t, { run: async () => ({ refs: [] }), notifications: [
    { channel: 'inbox', async deliver(event, view) { await new Promise(resolve => setTimeout(resolve, 20)); delivered.push([event.type, view.status]); } },
    { channel: 'broken', deliver() { throw new Error('sink down'); } },
  ] });
  const job = await port.submit('probe', {}), done = await port.wait(job.jobId);
  assert.deepEqual(delivered, [['settled', 'complete']], 'delivered once, before wait returned');
  assert.equal(done.status, 'complete');
  assert.equal(port.status(job.jobId).detail.notificationError, 'delivery-failed');
});

test('notification sinks are validated, and durable definitions keep theirs on the persistence port', () => {
  const lifecycle = createJobLifecycle('/private-library', createRuntimeWork()), ctx = new Context();
  for (const notifications of [{}, [{ channel: '', deliver() {} }], [{ channel: 'x' }]]) {
    assert.throws(() => lifecycle.register(ctx, 'bad.v1', { kind: 'bad', version: 1, run: async () => ({}), notifications }), /notification/);
  }
  assert.throws(() => lifecycle.register(ctx, 'bad.v1', { kind: 'bad', version: 1, run: async () => ({}),
    persistence: { open: async () => ({}) }, notifications: [{ channel: 'x', deliver() {} }] }), /notification/);
});
