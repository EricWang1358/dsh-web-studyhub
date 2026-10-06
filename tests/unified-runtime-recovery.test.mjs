import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { dshJobExecutor } from '../lib/jobs/executor.js';

test('executor inspection requires matching live owner and never treats lookup failure as death', () => {
  let value = { id: 'native-1', owner: 'original', status: 'running' }, thrown;
  const executor = dshJobExecutor({ get: key => key === 'jobs' ? { get: (id, caller) => {
    assert.equal(id, 'native-1'); assert.equal(caller, 'original'); if (thrown) throw thrown; return value;
  } } : undefined }, { id: 'new-owner' });
  const ref = { service: 'dsh-jobs', handleId: 'native-1', ownerAgentId: 'original' }, witness = executor.witness();
  assert.equal(executor.inspect(ref, witness).state, 'alive');
  value = { ...value, status: 'completed' }; assert.equal(executor.inspect(ref, witness).state, 'lost');
  value = { ...value, owner: 'another' }; assert.equal(executor.inspect(ref, witness).state, 'unknown');
  thrown = new Error('unknown job native-1'); assert.equal(executor.inspect(ref, witness).state, 'unknown');
  assert.equal(executor.inspect(ref, { ...witness, host: hostname() + '-foreign' }).state, 'unknown');
  assert.equal(executor.inspect(ref, { ...witness, instance: 'other-process-instance' }).state, 'unknown');
});

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { createManifestJobStore } from '../lib/jobs/store.js';
import { saveAudioBatch } from '../lib/audio-batch.js';

async function durableFixture(t, run, { recoveryMode = 'retry-from-start' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'durable-life-')), id = 'single-fixture-1';
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'audio-batches', id), { recursive: true });
  await saveAudioBatch(root, { id, kind: 'single', job: { id: 'legacy' } });
  const store = createManifestJobStore(join(root, 'audio-batches', id, 'manifest.json'));
  const inputRef = { id, hash: 'original-input', size: 42 };
  let starts = 0, state = 'lost', invalid;
  const executor = { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'test-process' }),
    inspect: () => ({ state, reason: 'controlled-fixture' }), start({ run, cancel }) { const id = `native-${++starts}`; void run(); return { id, ownerAgentId: 'actual-test-owner', stop: cancel, append() {} }; } };
  const ctx = new Context(), work = createRuntimeWork(), lifecycle = createJobLifecycle(root, work);
  const definition = { kind: 'persist', version: 1, capabilities: { retry: true, recoveryMode },
    persistence: { open: async input => ({ store, inputRef, input,
      validateInput: async () => { if (invalid) throw Object.assign(new Error(invalid), { code: invalid }); }, validateCheckpoint: async () => {}, reconcileCommit: async () => null }) }, run };
  lifecycle.register(ctx, 'persist.v1', definition);
  const owner = Symbol('owner'), port = lifecycle.scoped({ owner, domain: 'persist.v1', executor });
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  return { root, lifecycle, port, store, definition, ctx, executor, starts: () => starts, setState: value => { state = value; }, invalidate: value => { invalid = value; } };
}
test('durable lifecycle saves native binding before producer dispatch and terminal event before wait completes', async t => {
  let store, ran = 0;
  const f = await durableFixture(t, async context => {
    ran++; const disk = await store.load();
    assert.equal(disk.contract.runtime.activeAttemptId, context.attemptId);
    assert.equal(disk.contract.runtime.attempts.at(-1).executor.handleId, 'native-1');
    return { refs: [] };
  }); store = f.store;
  const submitted = await f.port.submit('persist', {});
  const ended = await f.port.wait(submitted.jobId);
  assert.equal(ended.status, 'complete'); assert.equal(ran, 1);
  const disk = await store.load(); assert.equal(disk.contract.status, 'complete'); assert.equal(disk.contract.events.length, 1);
  const next = createJobLifecycle(f.root, createRuntimeWork()), ctx = new Context();
  next.register(ctx, 'persist.v1', f.definition);
  const port = next.scoped({ owner: Symbol('new-owner'), domain: 'persist.v1', executor: f.executor });
  t.after(async () => { await next.dispose(); await ctx.fiber.dispose(); });
  const restored = await port.restore('persist', {});
  assert.equal(restored.jobId, ended.jobId); assert.equal(restored.events.length, 1); assert.equal(f.starts(), 1);
  assert.equal((await port.restore('persist', {})).events.length, 1);
});
test('explicit retry validates durable input before starting another physical Attempt', async t => {
  const f = await durableFixture(t, async () => { throw new Error('fixture failure'); });
  const submitted = await f.port.submit('persist', {}); await f.port.wait(submitted.jobId);
  f.invalidate('input-changed');
  await assert.rejects(f.port.control(submitted.jobId, 'retry'), { code: 'input-changed' });
  assert.equal(f.starts(), 1);
});
test('durable gateway writes intent before I/O and completed Call before the existing ledger sink', async t => {
  let store, calls = 0, ledgers = 0;
  const f = await durableFixture(t, async context => {
    const step = context.gateway.step('transcribe:1', { purpose: 'transcribe', feature: 'audio', requestedEffort: 'default', executionMode: 'direct', budget: null });
    await step.run(() => step.observe({ boundary: 'external-request', kind: 'transcribe',
      recordUsage: async event => { const disk = await store.load(); assert.equal(disk.contract.calls[0].callId, event.callId); assert.equal(disk.requestIntents[0].status, 'completed'); ledgers++; } }, async () => {
      const disk = await store.load(); assert.equal(disk.requestIntents.length, 1); assert.equal(disk.requestIntents[0].status, 'pending'); assert.equal(disk.contract.calls.length, 0); calls++;
      return { value: 'transcript', status: 200, ledgerEvent: { type: 'request', status: 200 } };
    }));
    return { refs: [] };
  }); store = f.store;
  const job = await f.port.submit('persist', {}), end = await f.port.wait(job.jobId);
  assert.equal(end.status, 'complete', end.error?.message); assert.equal(calls, 1); assert.equal(ledgers, 1);
});
test('artifact publication drains on cancellation before the durable terminal event', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let published = 0;
  const f = await durableFixture(t, async context => {
    await context.commitArtifact('artifact:1', async () => ({ id: 'source-1' }), {
      publish: async (prepared, { assertCurrent }) => { assertCurrent(); entered(); await held; published++; return { refs: [{ kind: 'source', id: prepared.id }] }; },
    });
    return { refs: [{ kind: 'source', id: 'source-1' }] };
  });
  const job = await f.port.submit('persist', {}); await Promise.race([started, f.port.wait(job.jobId).then(end => { throw new Error(end.error?.message || 'producer ended before commit admission'); })]);
  await f.port.control(job.jobId, 'cancel');
  assert.equal(f.port.status(job.jobId).status, 'cancelling'); release();
  const end = await f.port.wait(job.jobId); assert.equal(end.status, 'cancelled'); assert.equal(published, 1);
  const disk = await f.store.load(); assert.equal(disk.commits[0].status, 'complete'); assert.equal(disk.contract.events.length, 1);
});
test('concurrent retry cannot admit overlapping Attempts or corrupt the legacy facade', async t => {
  const f = await durableFixture(t, async () => { throw new Error('fixture failure'); });
  const job = await f.port.submit('persist', {}); await f.port.wait(job.jobId);
  const results = await Promise.allSettled([f.port.control(job.jobId, 'retry'), f.port.control(job.jobId, 'retry')]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.starts(), 2);
  const end = await f.port.wait(job.jobId);
  assert.equal(end.runtime.attempts.length, 2);
  assert.equal((await f.store.load()).contract.runtime.legacyId, end.runtime.legacyId);
});
test('a pending terminal write is not exposed as durable completion', async t => {
  const f = await durableFixture(t, async () => ({ refs: [] }));
  const held = Promise.withResolvers(), saving = Promise.withResolvers(), open = f.definition.persistence.open;
  f.definition.persistence.open = async input => { const port = await open(input); return { ...port, store: { ...port.store,
    save: async (value, options) => { if (value.contract.status === 'complete') { saving.resolve(); await held.promise; } return port.store.save(value, options); },
  } }; };
  const job = await f.port.submit('persist', {}); await saving.promise;
  try { assert.notEqual(f.port.status(job.jobId).status, 'complete'); }
  finally { held.resolve(); await f.port.wait(job.jobId); }
  assert.equal((await f.store.load()).contract.status, 'complete');
});
test('failed at-most-once notification preserves terminal outcome and is not resent on restore', async t => {
  let deliveries = 0;
  const f = await durableFixture(t, async () => ({ refs: [] })), open = f.definition.persistence.open;
  f.definition.persistence.open = async input => ({ ...await open(input), notifications: [{ channel: 'chat', idempotent: false, deliver: async () => { deliveries++; throw new Error('sink failed'); } }] });
  const job = await f.port.submit('persist', {}); assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  const { until } = await import('./helpers/wait.mjs');
  await until(async () => (await f.store.load()).deliveries[0]?.status === 'failed', 'failed delivery recorded');
  const next = createJobLifecycle(f.root, createRuntimeWork()), ctx = new Context(); next.register(ctx, 'persist.v1', f.definition);
  t.after(async () => { await next.dispose(); await ctx.fiber.dispose(); });
  const port = next.scoped({ owner: Symbol('next'), domain: 'persist.v1', executor: f.executor });
  const restored = await port.restore('persist', {});
  assert.equal(restored.status, 'complete'); assert.equal(restored.events.length, 1); assert.equal(deliveries, 1);
});
for (const reason of ['executor-alive', 'executor-unknown', 'input-unavailable', 'checkpoint-invalid', 'definition-version-mismatch']) test(`restore refuses ${reason} without new native admission`, async t => {
  const f = await durableFixture(t, async () => { throw new Error('fixture ended'); });
  const initial = await f.port.submit('persist', {}); await f.port.wait(initial.jobId);
  let saved = await f.store.load();
  if (reason.startsWith('executor-')) {
    saved.contract.status = 'running'; saved.contract.error = null; delete saved.contract.finishedAt;
    saved.contract.events = []; saved.contract.runtime.activeAttemptId = saved.contract.attemptId;
    const attempt = saved.contract.runtime.attempts.at(-1); attempt.status = 'running'; delete attempt.finishedAt;
    saved = await f.store.save(saved, { expectedRevision: saved.revision }); f.setState(reason === 'executor-alive' ? 'alive' : 'unknown');
  }
  if (reason === 'input-unavailable') f.invalidate(reason);
  if (reason === 'checkpoint-invalid') {
    saved.checkpoint = { version: 1, ref: 'checkpoint', digest: 'digest', stepKey: 'step' };
    await f.store.save(saved, { expectedRevision: saved.revision });
    const open = f.definition.persistence.open; f.definition.persistence.open = async input => ({ ...await open(input), validateCheckpoint: async () => { throw Object.assign(new Error(reason), { code: reason }); } });
  }
  const next = createJobLifecycle(f.root, createRuntimeWork()), ctx = new Context();
  next.register(ctx, 'persist.v1', { ...f.definition, version: reason === 'definition-version-mismatch' ? 2 : 1 });
  t.after(async () => { await next.dispose(); await ctx.fiber.dispose(); });
  const port = next.scoped({ owner: Symbol('restored'), domain: 'persist.v1', executor: f.executor });
  const job = await port.restore('persist', {});
  assert.equal(job.actions.retry.available, false); assert.equal(job.actions.retry.reason.code, reason);
  await assert.rejects(port.recover(job.jobId), { code: reason }); assert.equal(f.starts(), 1);
  if (reason.startsWith('executor-')) assert.equal(job.status, 'running', 'unconfirmed loss cannot become interrupted');
});
test('failed durable retry admission restores the same facade in memory and on disk', async t => {
  const f = await durableFixture(t, async () => { throw new Error('first failure'); });
  const job = await f.port.submit('persist', {}), before = await f.port.wait(job.jobId);
  f.executor.start = () => { throw new Error('native admission rejected'); };
  await assert.rejects(f.port.control(job.jobId, 'retry'), /native admission rejected/);
  assert.equal(f.port.status(job.jobId).runtime.legacyId, before.runtime.legacyId);
  assert.equal((await f.store.load()).contract.runtime.legacyId, before.runtime.legacyId);
});
test('failed initial durable admission leaves an explicitly retryable logical failure without a phantom executor', async t => {
  const f = await durableFixture(t, async () => ({ refs: [] }));
  f.executor.start = () => { throw new Error('native admission rejected'); };
  await assert.rejects(f.port.submit('persist', {}), /native admission rejected/);
  const disk = await f.store.load();
  assert.equal(disk.contract.status, 'failed'); assert.equal(disk.contract.runtime.activeAttemptId, null);
  assert.equal(disk.contract.runtime.attempts.length, 0);
});
test('failed native binding persistence drains the admitted handle without producer work and retains observed identity', async t => {
  let produced = 0, refused = false;
  const f = await durableFixture(t, async () => { produced++; return { refs: [] }; }), open = f.definition.persistence.open;
  f.definition.persistence.open = async input => { const port = await open(input); return { ...port, store: { ...port.store,
    save: async (value, options) => { if (!refused && value.contract.runtime.attempts.at(-1)?.executor) { refused = true; throw Object.assign(new Error('injected binding write failure'), { code: 'EIO' }); } return port.store.save(value, options); },
  } }; };
  await assert.rejects(f.port.submit('persist', {}), /binding write failure/);
  const disk = await f.store.load(); assert.equal(produced, 0); assert.equal(f.starts(), 1);
  assert.equal(disk.contract.status, 'failed'); assert.equal(disk.contract.runtime.activeAttemptId, null);
  assert.equal(disk.contract.runtime.attempts[0].executor.handleId, 'native-1'); assert.equal(disk.contract.events.length, 1);
});

test('persisted retry capability cannot bypass recoveryMode none after restore', async t => {
  const f = await durableFixture(t, async () => { throw new Error('fixture failed'); }, { recoveryMode: 'none' });
  const initial = await f.port.submit('persist', {}); await f.port.wait(initial.jobId);
  const next = createJobLifecycle(f.root, createRuntimeWork()), ctx = new Context(); next.register(ctx, 'persist.v1', f.definition);
  t.after(async () => { await next.dispose(); await ctx.fiber.dispose(); });
  const port = next.scoped({ owner: Symbol('next'), domain: 'persist.v1', executor: f.executor });
  const job = await port.restore('persist', {});
  assert.equal(job.actions.retry.reason.code, 'recovery-unsupported');
  await assert.rejects(port.control(job.jobId, 'retry'), { code: 'recovery-unsupported' }); assert.equal(f.starts(), 1);
});
