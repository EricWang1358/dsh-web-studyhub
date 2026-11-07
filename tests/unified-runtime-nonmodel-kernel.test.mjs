import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { StudyRuntime } from '../lib/runtime.js';
import { validateRuntimeContract } from '../lib/jobs/contract.js';
import { dshJobExecutor, hostJobExecutor } from '../lib/jobs/executor.js';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// Kernel additions for non-model jobs (S5-1 and #766 hostExecutor). Each test names the gap it closes.
const nonModel = { purpose: 'install', feature: 'marker', budget: null };
const finished = async (t, run) => {
  const f = await durableFixture(t, run), job = await f.port.submit('persist', {});
  return { f, job, end: await f.port.wait(job.jobId) };
};

test('G-3: a local child process is observed without claiming a request count', async t => {
  const { f, end } = await finished(t, async context => {
    const step = context.gateway.step('venv:1', nonModel);
    await step.run(() => step.observe({ boundary: 'local-process', kind: 'venv' }, async () => ({ value: 'created' })));
    return { refs: [] };
  });
  assert.equal(end.status, 'complete', end.error?.message);
  assert.deepEqual(end.calls[0].observation, { boundary: 'local-process', requestCount: null });
  assert.equal(end.calls[0].modelRequest, false);
  assert.deepEqual(end.usage, { tokens: null, tokenUsage: null, calls: 0 }, 'a process is not a model request and invents no usage');
  const stored = (await f.store.load()).contract;
  assert.deepEqual(stored.calls[0].observation, { boundary: 'local-process', requestCount: null }, 'the stored record validates and round-trips');
  const forged = structuredClone(stored); forged.calls[0].observation.requestCount = 1;
  assert.throws(() => validateRuntimeContract(forged), { code: 'invalid-call-observation' });
});

test('G-2/G-7: a non-model step carries no model policy and cannot start a model call', async t => {
  const refused = [];
  const { end } = await finished(t, async context => {
    const step = context.gateway.step('venv:1', nonModel);
    await step.run(() => step.observe({ boundary: 'local-process', kind: 'venv' }, async () => ({ value: 'created' })));
    await context.gateway.step('ask:1', nonModel).complete('system', 'prompt').catch(error => refused.push(error.code));
    for (const partial of [{ requestedEffort: 'default' }, { executionMode: 'direct' }]) {
      try { context.gateway.step('partial', { ...nonModel, ...partial }); } catch (error) { refused.push(error.code); }
    }
    return { refs: [] };
  });
  assert.equal(end.status, 'complete', end.error?.message);
  assert.deepEqual(refused, ['model-policy-required', 'invalid-gateway-policy', 'invalid-gateway-policy']);
  for (const field of ['requestedEffort', 'executionMode']) assert.equal(Object.hasOwn(end.calls[0], field), false, `${field} would be invented data on a process Call`);
  assert.equal(end.calls[0].purpose, 'install');
});

test('G-7: execution mode describes model calls only, so a process never makes a job "direct"', async t => {
  const observe = (context, meta) => { const step = context.gateway.step(`s:${meta.kind}`, nonModel); return step.run(() => step.observe(meta, async () => ({ value: 1 }))); };
  const onlyProcess = await finished(t, async context => { await observe(context, { boundary: 'local-process', kind: 'venv' }); return { refs: [] }; });
  assert.equal(onlyProcess.end.execution.mode, null);
  const mixed = await finished(t, async context => {
    await observe(context, { boundary: 'local-process', kind: 'venv' });
    await observe(context, { boundary: 'external-request', kind: 'ask', modelRequest: true, runner: 'subagent' });
    return { refs: [] };
  });
  assert.equal(mixed.end.execution.mode, 'subagent', 'the one model call decides; the process Call does not make it mixed');
});

test('G-1: a panel without a live Agent is refused with a code for model definitions, before any job or process exists', async t => {
  let ran = 0;
  const f = await durableFixture(t, async () => { ran++; return { refs: [] }; });
  const agents = { get: () => undefined };
  const executors = [dshJobExecutor({ get: key => key === 'agents' ? agents : { start() {} } }, { id: 'gone' }),
    dshJobExecutor({ get: key => key === 'agents' ? { get: id => ({ id }) } : undefined }, { id: 'live' })];
  for (const executor of executors) {
    const port = f.lifecycle.scoped({ owner: Symbol('panel'), domain: 'persist.v1', executor });
    await assert.rejects(port.submit('persist', {}), { code: 'executor-unavailable' });
    assert.deepEqual(port.list(), []);
  }
  assert.equal(ran, 0);
});

test('hostExecutor opt-in runs on study-host when no live Agent is resumed, and still prefers dsh-jobs when one is live', async t => {
  const f = await durableFixture(t, async () => ({ refs: [] }));
  assert.throws(() => f.lifecycle.register(f.ctx, 'host.v1', { kind: 'bad', version: 1, hostExecutor: 'yes', run: async () => ({ refs: [] }) }), /host executor/i);
  f.lifecycle.register(f.ctx, 'host.v1', {
    kind: 'local-tool', version: 1, hostExecutor: true,
    run: async () => ({ refs: [] }),
  });

  const coldExecutors = [
    dshJobExecutor({}, undefined),
    dshJobExecutor({ get: key => key === 'agents' ? { get: () => undefined } : { start() {} } }, { id: 'stale-agent' }),
    dshJobExecutor({ get: key => key === 'agents' ? { get: id => id === 'live' ? liveAgent : undefined } : undefined }, { id: 'no-jobs' }),
  ];
  var liveAgent = { id: 'live-agent' };
  for (const executor of coldExecutors) {
    const port = f.lifecycle.scoped({ owner: Symbol('panel'), domain: 'host.v1', executor });
    const submitted = await port.submit('local-tool', {});
    const done = await port.wait(submitted.jobId);
    assert.equal(done.status, 'complete');
    validateRuntimeContract(done);
    const [attempt] = done.runtime.attempts;
    assert.equal(attempt.executor.service, 'study-host');
    assert.equal(typeof attempt.executor.handleId, 'string');
    assert.equal(Object.hasOwn(attempt.executor, 'ownerAgentId'), false);
  }

  let nativeStarts = 0;
  const nativeHost = {
    get: key => key === 'agents'
      ? { get: id => id === liveAgent.id ? liveAgent : undefined }
      : key === 'jobs'
        ? { start(spec) { nativeStarts++; spec.run({ append() {} }); return `dsh-${nativeStarts}`; }, kill() {}, readAt: () => ({ chunks: [] }) }
        : undefined,
  };
  const warmPort = f.lifecycle.scoped({ owner: Symbol('panel'), domain: 'host.v1', executor: dshJobExecutor(nativeHost, liveAgent) });
  const warmJob = await warmPort.submit('local-tool', {});
  const warmDone = await warmPort.wait(warmJob.jobId);
  assert.equal(warmDone.status, 'complete');
  assert.deepEqual(warmDone.runtime.attempts[0].executor, { service: 'dsh-jobs', handleId: 'dsh-1', ownerAgentId: liveAgent.id });
});

test('hostJobExecutor tracks alive/stopping/settled handles, idempotent cancellation, output cursors and processWitness inspection', async t => {
  const host = hostJobExecutor(), viaDsh = dshJobExecutor({}, undefined);
  assert.deepEqual(host.witness(), viaDsh.witness(), 'hostJobExecutor and dshJobExecutor share the exact processWitness');

  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  let cancels = 0;
  const handle = host.start({
    kind: 'index',
    title: 'Index OS',
    run: async () => { entered.resolve(); await release.promise; return { status: 'killed' }; },
    cancel: reason => { cancels++; return reason; },
  });
  await entered.promise;
  handle.append('page 1\n');
  handle.append('page 2\n');
  const firstRead = handle.output(0);
  assert.equal(firstRead.text, 'page 1\npage 2\n');
  assert.deepEqual(handle.output(firstRead.cursor), { text: '', cursor: firstRead.cursor });

  const ref = { service: 'study-host', handleId: handle.id }, witness = host.witness();
  assert.deepEqual(host.inspect(ref, witness), { state: 'alive', reason: 'host-executor-active' });
  assert.deepEqual(viaDsh.inspect(ref, witness), { state: 'alive', reason: 'host-executor-active' });

  assert.equal(handle.stop('user-cancel'), 'user-cancel');
  assert.equal(handle.stop('again'), undefined, 'stop is idempotent');
  assert.equal(cancels, 1);
  assert.deepEqual(host.inspect(ref, witness), { state: 'alive', reason: 'host-executor-active' }, 'stopping stays alive until run settles');

  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(host.inspect(ref, witness), { state: 'lost', reason: 'host-executor-settled' });
  assert.deepEqual(viaDsh.inspect(ref, witness), { state: 'lost', reason: 'host-executor-settled' });

  assert.deepEqual(host.inspect({ service: 'study-host', handleId: 'missing' }, witness), { state: 'unknown', reason: 'executor-lookup-unconfirmed' });
  assert.deepEqual(host.inspect(ref, { ...witness, host: 'foreign:host' }), { state: 'unknown', reason: 'incompatible-executor-witness' });
  assert.deepEqual(host.inspect(ref, { ...witness, instance: 'previous-instance' }), { state: 'unknown', reason: 'executor-process-unconfirmed' });

  let deadPid = 0;
  for (let candidate = 999_996; candidate > 999_700; candidate -= 4) {
    try { process.kill(candidate, 0); }
    catch (error) { if (error.code === 'ESRCH') { deadPid = candidate; break; } }
  }
  assert.ok(deadPid > 0, 'found an unused PID without spawning a child process');
  assert.deepEqual(host.inspect(ref, { ...witness, pid: deadPid, instance: 'exited-instance' }), { state: 'lost', reason: 'executor-process-exited' });
});

test('StudyRuntime defaults to host-only admission when jobExecutor is absent and drains study-host jobs on cancelOwner(workOwner)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-only-runtime-')), ctx = new Context(), workOwner = Symbol('study-host-owner');
  const running = Promise.withResolvers(), releaseCleanup = Promise.withResolvers();
  let cleaned = false;
  const runtime = new StudyRuntime(root, { workOwner });
  t.after(async () => { releaseCleanup.resolve(); await runtime.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });

  runtime.register({
    id: 'tools',
    operations: {
      modelJob: (_args, context) => context.jobs.submit('needs-agent', {}),
      localJob: (_args, context) => context.jobs.submit('local-work', {}),
      status: (args, context) => context.jobs.status(args.jobId),
    },
  });
  runtime.registerJob(ctx, 'tools.v1', { kind: 'needs-agent', version: 1, run: async () => ({ refs: [] }) });
  runtime.registerJob(ctx, 'tools.v1', {
    kind: 'local-work', version: 1, hostExecutor: true,
    run: async context => {
      running.resolve();
      await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
      await releaseCleanup.promise;
      cleaned = true;
      return { refs: [] };
    },
  });

  await assert.rejects(runtime.call('tools.modelJob', {}), { code: 'executor-unavailable' });
  const started = await runtime.call('tools.localJob', {});
  assert.equal(started.runtime.attempts[0].executor.service, 'study-host');
  await running.promise;

  let unloaded = false;
  const unloading = Promise.resolve(runtime.cancelOwner(workOwner)).then(() => { unloaded = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(unloaded, false, 'cancelOwner waits for physical cleanup of study-host jobs');
  releaseCleanup.resolve();
  await unloading;
  assert.equal(cleaned, true);
  assert.equal(runtime.work.jobs.get(started.runtime.legacyId).status, 'cancelled');
});
