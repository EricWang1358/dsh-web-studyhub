import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobContract } from '../lib/job-contract.js';
import { Context } from '@deepseek-ai/cordis';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { dshJobExecutor } from '../lib/jobs/executor.js';
import { until } from './helpers/wait.mjs';

const deferred = () => Promise.withResolvers();
// Controlled host double: unit tests do not claim actual DSH validation.
function fixture(t, definition = {}) {
  const ctx = new Context(), work = createRuntimeWork(), owner = Symbol('plugin');
  const agent = { id: 'live-agent' }, handles = new Map();
  let starts = 0, kills = 0;
  const jobs = { start(spec) {
    assert.equal(spec.owner, agent.id); const id = `host-${++starts}`;
    const hooks = spec.run({ id }); handles.set(id, hooks); return id;
  }, kill(id) { kills++; handles.get(id).cancel('stopped by host'); }, readAt() { return { chunks: [] }; } };
  const host = { get: key => key === 'agents' ? { get: id => id === agent.id ? agent : undefined } : key === 'jobs' ? jobs : undefined };
  const lifecycle = createJobLifecycle('/private-library', work);
  const registration = lifecycle.register(ctx, 'probe.v1', { kind: 'probe', version: 1, run: async () => ({ refs: [] }), ...definition });
  const port = lifecycle.scoped({ owner, domain: 'probe.v1', executor: dshJobExecutor(host, agent) });
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  return { ctx, work, owner, agent, lifecycle, port, registration, host, starts: () => starts, kills: () => kills };
}

test('S1-2 uses the existing work.jobs, validates real owner identity and rejects absent controller admission', async t => {
  const f = fixture(t);
  assert.throws(() => dshJobExecutor(f.host, { id: f.agent.id }).assertAvailable(), /live/i);
  assert.throws(() => dshJobExecutor(f.host).assertAvailable(), /live/i);
  const port = f.lifecycle.scoped({ owner: f.owner, domain: 'probe.v1', executor: { assertAvailable() {}, start() { throw new Error('no controller'); } } });
  await assert.rejects(() => port.submit('probe', {}), /controller/);
  assert.equal(f.work.jobs.size, 0);
  const job = await f.port.submit('probe', {});
  assert.equal(f.work.jobs.size, 1);
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  assert.equal(f.port.status(job.jobId).events.filter(e => e.type === 'settled').length, 1);
});

test('S1-2 stop is idempotent and waits for physical cleanup; observer timeout never stops execution', async t => {
  const release = deferred(), started = deferred();
  const f = fixture(t, { run: async context => { started.resolve(context); await release.promise; return { refs: [{ kind: 'source', id: 'late' }] }; } });
  t.after(() => release.resolve());
  const job = await f.port.submit('probe', {}), context = await started.promise;
  assert.equal((await f.port.wait(job.jobId, { timeoutMs: 0 })).status, 'running');
  assert.equal(context.signal.aborted, false);
  await f.port.control(job.jobId, 'cancel'); await f.port.control(job.jobId, 'cancel');
  assert.equal(f.kills(), 1); assert.equal(context.signal.aborted, true);
  assert.equal(f.port.status(job.jobId).status, 'cancelling');
  assert.equal(f.work.settled.size, 1);
  assert.throws(() => context.progress({ done: 3 }), /stale|stopp/i);
  release.resolve();
  const ended = await f.port.wait(job.jobId);
  assert.equal(ended.status, 'cancelled'); assert.deepEqual(ended.result.refs, []);
  assert.equal(f.work.settled.size, 0);
});

test('S1-2 scope unload rejects admissions and waits for producer cleanup', async t => {
  const held = deferred(), started = deferred();
  const f = fixture(t, { capabilities: { retry: true }, run: async context => { started.resolve(context); await held.promise; return { refs: [] }; } });
  t.after(() => held.resolve());
  const job = await f.port.submit('probe', {}); await started.promise;
  let released = false;
  const closing = f.registration().then(() => { released = true; });
  await until(() => f.port.status(job.jobId).status === 'cancelling', 'scope cancellation');
  assert.equal(released, false);
  await assert.rejects(() => f.port.submit('probe', {}), /unavailable|unloaded/);
  held.resolve(); await closing;
  assert.equal(f.port.status(job.jobId).status, 'cancelled');
  assert.equal(f.port.status(job.jobId).actions.retry.available, false);
  assert.equal(f.port.status(job.jobId).actions.retry.reason.code, 'scope-unloaded');
});

test('S1-2 checkpoint pause keeps logical wait open, resumes with a new Attempt and fences late publication', async t => {
  const checkpoint = deferred(), prepared = deferred(), contexts = [];
  const f = fixture(t, { capabilities: { pauseMode: 'checkpoint', retry: true }, run: async context => {
    contexts.push(context);
    if (!context.checkpointRef) { await checkpoint.promise; context.checkpoint('saved:one'); }
    return { refs: [{ kind: 'source', id: 'accepted' }] };
  } });
  const job = await f.port.submit('probe', {}); await until(() => contexts.length, 'first attempt');
  let writes = 0;
  const late = contexts[0].commit(async () => { await prepared.promise; return 'late'; }, () => { writes++; });
  const rejected = assert.rejects(late, /stale|stopp/i);
  await f.port.control(job.jobId, 'pause'); checkpoint.resolve();
  await until(() => f.port.status(job.jobId).status === 'paused', 'checkpoint pause');
  assert.equal((await f.port.wait(job.jobId, { timeoutMs: 0 })).status, 'paused');
  await f.port.control(job.jobId, 'resume');
  const ended = await f.port.wait(job.jobId);
  assert.equal(ended.status, 'complete'); assert.equal(ended.runtime.attempts.length, 2);
  assert.equal(ended.runtime.legacyId, job.runtime.legacyId);
  assert.equal(ended.events.filter(e => e.type === 'settled').length, 1);
  prepared.resolve(); await rejected; assert.equal(writes, 0);
});

test('S1-2 owner/domain fences and queued cancel; all timeout classes stop work, not observer wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const held = deferred(), started = deferred();
  const f = fixture(t, { run: async context => { started.resolve(context); await held.promise; return { refs: [] }; } });
  t.after(() => held.resolve());
  const job = await f.port.submit('probe', {}, { executionTimeoutMs: 20 });
  t.mock.timers.tick(0);
  const context = await started.promise;
  const other = f.lifecycle.scoped({ owner: Symbol('other'), domain: 'probe.v1' });
  assert.throws(() => other.status(job.jobId), /not found/i);
  t.mock.timers.tick(20);
  assert.equal(context.signal.aborted, true);
  assert.equal(f.port.status(job.jobId).status, 'cancelling');
  held.resolve(); assert.equal((await f.port.wait(job.jobId)).status, 'cancelled');
  const queued = await f.port.submit('probe', {});
  await f.port.control(queued.jobId, 'cancel'); t.mock.timers.tick(0);
  assert.equal((await f.port.wait(queued.jobId)).status, 'cancelled');
});

test('S1-2 queued cancellation and queued-only pause never invoke a producer; queue deadline is distinct', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let runs = 0;
  const f = fixture(t, { capabilities: { pauseMode: 'queued-only' }, run: async () => { runs++; return { refs: [] }; } });
  const cancelled = await f.port.submit('probe', {});
  await f.port.control(cancelled.jobId, 'cancel'); t.mock.timers.tick(0);
  assert.equal((await f.port.wait(cancelled.jobId)).status, 'cancelled'); assert.equal(runs, 0);
  const paused = await f.port.submit('probe', {});
  await f.port.control(paused.jobId, 'pause'); t.mock.timers.tick(0);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.port.status(paused.jobId).status, 'paused'); assert.equal(runs, 0);
  await f.port.control(paused.jobId, 'resume'); t.mock.timers.tick(0);
  assert.equal((await f.port.wait(paused.jobId)).status, 'complete'); assert.equal(runs, 1);
  const expired = await f.port.submit('probe', {}, { queueTimeoutMs: 0 }); t.mock.timers.tick(0);
  assert.equal((await f.port.wait(expired.jobId)).detail.stopReason, 'queue-timeout'); assert.equal(runs, 1);
});

test('S1-2 request timeout waits for actual request cleanup and explicitly retains unknown stop confirmation', async t => {
  const held = deferred(), started = deferred();
  const f = fixture(t, { run: context => context.request(async signal => { started.resolve(signal); await held.promise; return { refs: [] }; }, { timeoutMs: 0 }) });
  t.after(() => held.resolve());
  const job = await f.port.submit('probe', {}), signal = await started.promise;
  await until(() => signal.aborted, 'request timeout');
  assert.equal(f.port.status(job.jobId).status, 'cancelling'); assert.equal(f.work.settled.size, 1);
  held.resolve(); assert.equal((await f.port.wait(job.jobId)).detail.stopReason, 'request-timeout');
});

test('S1-2 retry changes only the legacy facade ID, rejects old capability writes and failed native admission is atomic', async t => {
  const contexts = [];
  const f = fixture(t, { capabilities: { retry: true }, run: async context => { contexts.push(context); if (contexts.length === 1) throw new Error('controlled'); return { refs: [] }; } });
  const job = await f.port.submit('probe', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'failed');
  await f.port.control(job.jobId, 'retry');
  const ended = await f.port.wait(job.jobId);
  assert.equal(ended.status, 'complete'); assert.equal(ended.jobId, job.jobId);
  assert.notEqual(ended.runtime.legacyId, job.runtime.legacyId);
  assert.equal(f.work.jobs.has(job.runtime.legacyId), false);
  assert.throws(() => contexts[0].progress({ done: 3 }), /stale|stopp/i);
});

test('S1-2 failed retry admission keeps the ended Attempt and facade unchanged', async t => {
  const f = fixture(t, { capabilities: { retry: true }, run: async () => { throw new Error('first failure'); } });
  const job = await f.port.submit('probe', {}), before = await f.port.wait(job.jobId);
  f.host.get('jobs').start = () => { throw new Error('controller removed'); };
  await assert.rejects(() => f.port.control(job.jobId, 'retry'), /controller removed/);
  assert.deepEqual(f.port.status(job.jobId), before);
  assert.equal(f.work.settled.size, 0);
});

test('S1-2 queued-only paused cancellation does not rewrite a completed Attempt or emit twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: 1000 });
  const f = fixture(t, { capabilities: { pauseMode: 'queued-only' } });
  const job = await f.port.submit('probe', {});
  await f.port.control(job.jobId, 'pause'); t.mock.timers.tick(0);
  await Promise.resolve(); await Promise.resolve();
  const paused = f.port.status(job.jobId);
  assert.equal(paused.status, 'paused');
  await f.port.control(job.jobId, 'cancel');
  const ended = await f.port.wait(job.jobId);
  assert.deepEqual(ended.runtime.attempts, paused.runtime.attempts);
  assert.equal(ended.events.filter(e => e.type === 'settled').length, 1);
});

test('S1-2 unknown host stop remains unknown until the real producer returns', async t => {
  const held = deferred(), started = deferred(); t.after(() => held.resolve());
  const f = fixture(t, { run: async context => { started.resolve(context); await held.promise; return { refs: [] }; } });
  const job = await f.port.submit('probe', {}); await started.promise;
  f.host.get('jobs').kill = () => { throw new Error('transport lost'); };
  await f.port.control(job.jobId, 'cancel');
  assert.equal(f.port.status(job.jobId).detail.stopConfirmation, 'unknown');
  assert.equal(f.port.status(job.jobId).status, 'cancelling');
  held.resolve(); assert.equal((await f.port.wait(job.jobId)).status, 'cancelled');
});


test('S1-2 running raw snapshots refresh the queued-only action matrix without a prior status call', async t => {
  const held = deferred(), started = deferred(); t.after(() => held.resolve());
  const f = fixture(t, { capabilities: { pauseMode: 'queued-only' }, run: async () => { started.resolve(); await held.promise; return { refs: [] }; } });
  const job = await f.port.submit('probe', {}); await started.promise;
  const projected = jobContract(f.work.jobs.get(job.runtime.legacyId));
  assert.equal(projected.status, 'running'); assert.equal(projected.actions.pause.available, false);
  held.resolve(); await f.port.wait(job.jobId);
});

test('S1-2 cancellation fences a real artifact publication after async preparation; current publication succeeds', async t => {
  const directory = await mkdtemp(join(tmpdir(), 's12-commit-'));
  const file = join(directory, 'artifact.txt'), held = deferred(), started = deferred();
  t.after(async () => { held.resolve(); await rm(directory, { recursive: true, force: true }); });
  const f = fixture(t, { run: async (context, input) => {
    await context.commit(async () => { started.resolve(); if (input.hold) await held.promise; return 'approved'; }, text => writeFileSync(file, text));
    return { refs: [{ kind: 'source', id: 'artifact' }] };
  } });
  const stopped = await f.port.submit('probe', { hold: true }); await started.promise;
  await f.port.control(stopped.jobId, 'cancel'); held.resolve();
  assert.equal((await f.port.wait(stopped.jobId)).status, 'cancelled'); assert.equal(existsSync(file), false);
  const accepted = await f.port.submit('probe', { hold: false });
  assert.equal((await f.port.wait(accepted.jobId)).status, 'complete'); assert.equal(readFileSync(file, 'utf8'), 'approved');
});
