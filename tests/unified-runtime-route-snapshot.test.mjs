import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';

// An Attempt keeps the model route the session had when the Attempt was created: changing the session's model while a job
// is queued or running never changes which model its calls use. A new Attempt (retry) takes the route in force then.
const executor = { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'route' }), inspect: () => ({ state: 'lost' }),
  start({ run, cancel }) { void run(); return { id: 'native-route', ownerAgentId: 'owner', stop: cancel, append() {} }; } };
const policy = { purpose: 'probe', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null };

test('calls of one Attempt use the route fixed when the Attempt was created; a retry takes the current one', async t => {
  let current = { provider: 'p', model: 'first' }, attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; }), used = [];
  const modelHost = { ctx: {}, route: () => current, complete: async (_s, _p, request) => { used.push(request.route.model); return 'ok'; } };
  const ctx = new Context(), lifecycle = createJobLifecycle('/private-library', createRuntimeWork());
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  lifecycle.register(ctx, 'probe.v1', { kind: 'probe', version: 1, capabilities: { retry: true, executionModes: ['direct'] }, run: async context => {
    attempts++;
    await context.gateway.step('before', policy).complete('s', 'p');
    if (attempts === 1) await gate;
    await context.gateway.step('after', policy).complete('s', 'p');
    if (attempts === 1) throw new Error('first attempt fails');
    return { refs: [] };
  } });
  const port = lifecycle.scoped({ owner: Symbol('owner'), domain: 'probe.v1', executor, modelHost });
  const job = await port.submit('probe', {});
  current = { provider: 'p', model: 'second' };
  release();
  assert.equal((await port.wait(job.jobId)).status, 'failed');
  await port.control(job.jobId, 'retry');
  assert.equal((await port.wait(job.jobId)).status, 'complete');
  assert.deepEqual(used, ['first', 'first', 'second', 'second']);
});
