import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { until } from './helpers/wait.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, definition) {
  const ctx = new Context(), work = createRuntimeWork(), lifecycle = createJobLifecycle('synthetic-no-storage', work);
  const owner = Symbol('owned'); let starts = 0;
  const executor = { assertAvailable() {}, start({ run, cancel }) { void run(); return { id: `native-${++starts}`, ownerAgentId: 'controlled-owner', stop: cancel, append() {} }; } };
  lifecycle.register(ctx, 'probe.v1', { kind: 'probe', version: 1, ...definition });
  const port = lifecycle.scoped({ owner, domain: 'probe.v1', executor });
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  return { work, port, lifecycle, owner, executor, starts: () => starts };
}
test('trusted admission retains queued status and one legacy view until the existing gate releases it', async t => {
  const admitted = deferred(), release = deferred(), running = deferred(), complete = deferred(); let finishes = 0, admissionSeen = false;
  const bindings = { privateCredential: 'not-public', phase: 'queued' };
  const f = fixture(t, { legacyFields: ['filename', 'phase'],
    admit: async (context, input, actual) => {
      assert.equal(actual, bindings);
      context.present(({ status }) => ({ title: 'Lecture', stage: { code: actual.phase }, detail: { filename: 'lecture.wav' },
        legacy: { filename: 'lecture.wav', phase: status === 'complete' ? 'done' : actual.phase } }));
      admissionSeen = true; admitted.resolve(context); await release.promise;
      return { release() {}, async finish() { finishes++; } };
    }, run: async (context, input, actual) => { assert.equal(actual, bindings); actual.phase = 'proofread'; running.resolve(); await complete.promise; return { refs: [] }; } });
  try {
    const job = await f.port.submit('probe', { id: 'domain-input' }, {}, bindings);
    await until(() => admissionSeen || ['failed', 'complete'].includes(f.port.status(job.jobId).status), 'admission hook or outcome');
    assert.equal(admissionSeen, true, 'trusted admission must precede producer');
    await admitted.promise;
    assert.equal(f.port.status(job.jobId).status, 'queued');
    assert.equal(f.work.jobs.get(job.runtime.legacyId).filename, 'lecture.wav');
    assert.equal(JSON.stringify(f.port.status(job.jobId)).includes('not-public'), false);
    release.resolve(); await running.promise;
    assert.equal(f.port.status(job.jobId).status, 'running');
    assert.equal(f.port.status(job.jobId).stage.code, 'proofread');
    complete.resolve(); const ended = await f.port.wait(job.jobId);
    assert.equal(ended.status, 'complete'); assert.equal(finishes, 1);
    assert.equal(f.work.jobs.get(job.runtime.legacyId).phase, 'done');
    assert.equal(f.work.jobs.size, 1);
  } finally { release.resolve(); complete.resolve(); }
});
test('set control delegates validated settings to one adapter and cannot write lifecycle through presentation', async t => {
  const held = deferred(), entered = deferred(); let value = 2, patches = 0;
  const f = fixture(t, { capabilities: { set: true }, run: async context => {
    context.controls({ settings: () => [{ key: 'concurrency', type: 'int', min: 1, max: 4, value }],
      patch(input) { if (Object.keys(input).some(k => k !== 'concurrency') || !Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) throw new Error('invalid patch'); value = input.concurrency; patches++; return { applied: input }; } });
    assert.throws(() => context.present(() => ({ status: 'complete' })), /presentation/);
    entered.resolve(); await held.promise; return { refs: [] };
  } });
  try {
    const job = await f.port.submit('probe', {}); await entered.promise;
    assert.equal(f.port.status(job.jobId).actions.set.settings[0].value, 2);
    await assert.rejects(f.port.control(job.jobId, 'set', { concurrency: 9 }), /invalid patch/);
    assert.equal(patches, 0);
    await f.port.control(job.jobId, 'set', { concurrency: 3 });
    assert.equal(f.port.status(job.jobId).actions.set.settings[0].value, 3);
    await assert.rejects(f.port.control(job.jobId, 'set', { paused: true }), /setting/);
    assert.equal(patches, 1);
    held.resolve(); const ended = await f.port.wait(job.jobId);
    assert.equal(ended.actions.set.available, false);
  } finally { held.resolve(); }
});
test('queued checkpoint pause withdraws existing admission without starting producer and resume opens a new native Attempt', async t => {
  let produced = 0, first = true, admissionSeen = false; const entered = deferred();
  const f = fixture(t, { capabilities: { pauseMode: 'checkpoint' },
    admit: async context => {
      if (first) { first = false; admissionSeen = true; entered.resolve(); await new Promise(resolve => context.pauseSignal.addEventListener('abort', resolve, { once: true })); context.checkpoint('controlled:queued'); }
      return { finish: async () => {} };
    }, run: async () => { produced++; return { refs: [] }; } });
  const job = await f.port.submit('probe', {});
  await until(() => admissionSeen || ['failed', 'complete'].includes(f.port.status(job.jobId).status), 'queued hook or outcome');
  assert.equal(admissionSeen, true, 'pause must observe admission'); await entered.promise;
  await f.port.control(job.jobId, 'pause');
  await until(() => f.port.status(job.jobId).status === 'paused', 'queued checkpoint pause');
  assert.equal(produced, 0);
  await f.port.control(job.jobId, 'resume'); const ended = await f.port.wait(job.jobId);
  assert.equal(ended.status, 'complete'); assert.equal(produced, 1); assert.equal(f.starts(), 2);
  assert.equal(ended.runtime.legacyId, job.runtime.legacyId);
});

test('public snapshot reads a bounded output preview without putting model text into the durable contract', async t => {
  const { createJobServices } = await import('../lib/runtime/jobs.js');
  const f = fixture(t, { run: async () => ({ refs: [] }) });
  const submitted = await f.port.submit('probe', {}); await f.port.wait(submitted.jobId);
  const job = f.work.jobs.get(submitted.runtime.legacyId), contract = job.contract;
  contract.calls.push({ callId: 'preview-call', jobId: contract.jobId, attemptId: contract.attemptId, stepKey: 'preview', kind: 'proofread',
    status: 'ok', runner: 'direct', tokens: null, startedAt: null, endedAt: null, observation: { boundary: 'host-attempt', requestCount: null } });
  f.work.jobOutputs.open(job.id, 'preview-call'); f.work.jobOutputs.append(job.id, 'preview-call', 'Private model output for a bounded preview.'); f.work.jobOutputs.close(job.id, 'preview-call');
  const snapshot = createJobServices(f.work).snapshotJob(job);
  assert.equal(snapshot.contract.calls[0].outputPreview, 'Private model output for a bounded preview.');
  assert.equal(JSON.stringify(contract).includes('Private model output'), false);
});

for (const hook of ['presentation', 'admission-finish', 'control-close']) test(`a failed ${hook} adapter cannot strand terminal settlement`, { timeout: 2000 }, async t => {
  const f = fixture(t, {
    capabilities: { set: true },
    admit: async () => ({ finish() { if (hook === 'admission-finish') throw new Error('broken admission cleanup'); } }),
    run: async context => {
      context.present(({ status }) => { if (hook === 'presentation' && status === 'complete') throw new Error('broken terminal display'); return { title: 'Adapter failure probe' }; });
      context.controls({ settings: () => [], patch() {}, close() { if (hook === 'control-close') throw new Error('broken control cleanup'); } });
      return { refs: [] };
    },
  });
  const submitted = await f.port.submit('probe', {});
  const ended = await f.port.wait(submitted.jobId, { timeoutMs: 1000 });
  assert.equal(ended.status, 'failed');
  assert.equal(ended.runtime.activeAttemptId, null);
  assert.equal(ended.events.filter(event => event.type === 'settled').length, 1);
  assert.equal(f.work.settled.size, 0);
});
