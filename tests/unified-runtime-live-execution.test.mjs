import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { StudyService } from '../lib/service.js';
import { dshJobExecutor } from '../lib/jobs/executor.js';
import { until } from './helpers/wait.mjs';

test('S1-2 live public operations and legacy status/wait/cancel delegate to one owned lifecycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 's12-live-')), ctx = new Context(), owner = Symbol('workbench');
  const agent = { id: 'real-identity-double' }; let hooks, port, context;
  const host = { get: key => key === 'agents' ? { get: () => agent } : { start(spec) { hooks = spec.run(); return 'host-1'; }, kill() { hooks.cancel(); } } };
  const held = Promise.withResolvers();
  t.after(async () => { held.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const services = { workOwner: owner, jobExecutor: dshJobExecutor(host, agent) };
  const service = new StudyService(root, services), runtime = service.runtime;
  runtime.register({ id: 'probe', operations: { submit: async (_args, context) => { port = context.jobs; return port.submit('probe', {}); } } });
  runtime.registerJob(ctx, 'probe.v1', { kind: 'probe', version: 1, run: async value => { context = value; await held.promise; return { refs: [] }; } });
  const job = await runtime.call('probe.submit', {}, services), legacy = job.runtime.legacyId;
  await until(() => context, 'runtime producer');
  const status = await service.call('job.status', { jobId: legacy });
  assert.equal(status.id, legacy); assert.equal(status.status, 'running'); assert.equal(status.contract, undefined);
  assert.equal((await service.call('job.status', {})).jobs.filter(j => j.id === legacy).length, 1);
  assert.deepEqual((await runtime.call('job.status', {}, { workOwner: Symbol('different') })).jobs, []);
  await assert.rejects(() => runtime.call('job.cancel', { jobId: legacy }, { workOwner: Symbol('different') }), /not found/i);
  await service.call('job.cancel', { jobId: legacy }); await service.call('job.cancel', { jobId: legacy });
  assert.equal(context.signal.aborted, true); assert.equal(port.status(job.jobId).status, 'cancelling');
  held.resolve();
  assert.equal((await service.call('job.wait', { jobId: legacy })).status, 'cancelled');
  assert.equal(port.status(job.jobId).events.filter(e => e.type === 'settled').length, 1);
  await runtime.dispose();
});

test('S1-2 tracked request-runtime scope cleanup returns the actual asynchronous drain', async t => {
  const { acquireContexts } = await import('../lib/runtime/lifecycle.js');
  const root = new Context(); const contexts = acquireContexts(root, []);
  t.after(() => root.fiber.dispose());
  const held = Promise.withResolvers(); t.after(() => held.resolve());
  let cleanup, disposed = false;
  const owner = { effect: install => { cleanup = install(); } };
  const runtime = { dispose: async () => { await held.promise; disposed = true; } };
  contexts.api.trackRequestRuntime(runtime, owner);
  const closing = cleanup();
  assert.equal(typeof closing?.then, 'function', 'scope must expose the outstanding runtime drain');
  assert.equal(disposed, false);
  held.resolve(); await closing; assert.equal(disposed, true);
});
