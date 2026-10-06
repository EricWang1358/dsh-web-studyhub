import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { gate, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* S3-1: generate / fill / supplement are jobs of the unified runtime behind `runtime.pilot.generation`, waiting in the library's ONE queue
   (work.queues), their lifecycle owned by the kernel and every model call a step of the gateway. */

const text = 'Architecture sets principles that guide how a system is designed and changed.';
const request = { sourceIds: ['s'], count: 1, kind: 'flashcard' };

async function library(t, { holdAt } = {}) {
  const hold = gate(), staged = stagedModel({ holdAt, hold });
  const root = await mkdtemp(join(tmpdir(), 'study-s31-'));
  const runtime = createStudyRuntime(root, { complete: staged.complete });
  t.after(async () => { hold.open(); await runtime.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await runtime.call('source.add', { id: 's', title: 'Notes', text });
  const owners = { a: 'a', b: 'b' };
  const services = (name, on = true) => {
    const owner = owners[name];
    const { starts: _starts, ...options } = managedRuntimeOptions({ complete: staged.complete, paths: on ? ['generation'] : [], owner });
    return { complete: staged.complete, ...options };
  };
  return { root, runtime, staged, hold, services };
}
const snapshotOf = async (runtime, jobId, services) => (await runtime.call('snapshot', {}, services)).jobs.find(job => job.id === jobId);

test('a generation job on the runtime waits in the library queue behind a legacy entry and its lifecycle is the kernel\'s', async t => {
  const { runtime, staged, hold, services } = await library(t, { holdAt: 'plan' });
  const first = await runtime.call('generate', request, services('a', false));
  await soon(() => hold.entered, 'the legacy job to be at the model');
  const queued = await runtime.call('generate', request, services('a'));
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queuedBehind, 1);
  const record = await snapshotOf(runtime, queued.jobId, services('a'));
  assert.equal(record.contract.contractVersion, 2, 'a job of the runtime, not a legacy record');
  assert.equal(record.contract.kind, 'generation');
  assert.equal(record.status, 'queued');
  assert.deepEqual(staged.log, ['plan'], 'only the legacy job is at the model: the executor of the queued one has not started');
  assert.equal(runtime.work.queues.size, 1, 'one chain per library, shared by both');
  hold.open();
  for (const jobId of [first.jobId, queued.jobId]) assert.equal((await runtime.call('job.wait', { jobId, timeoutSeconds: 30 }, services('a'))).status, 'complete');
  assert.equal(runtime.work.queues.size, 0, 'the library queue is empty again');
});

test('a queued job that is cancelled never starts its executor and does not hold the queue', async t => {
  const { runtime, root, staged, services } = await library(t);
  let release;
  runtime.work.queues.set(root, new Promise(resolve => { release = resolve; }));
  const cancelled = await runtime.call('generate', request, services('a'));
  const behind = await runtime.call('generate', request, services('b'));
  await runtime.call('job.cancel', { jobId: cancelled.jobId }, services('a'));
  release();
  assert.equal((await runtime.call('job.wait', { jobId: cancelled.jobId, timeoutSeconds: 30 }, services('a'))).status, 'cancelled');
  assert.equal((await runtime.call('job.wait', { jobId: behind.jobId, timeoutSeconds: 30 }, services('b'))).status, 'complete');
  assert.equal(staged.log.filter(stage => stage === 'plan').length, 1, 'only the job that was not cancelled asked the model');
});

test('an observer\'s wait that times out does not cancel the job', async t => {
  const { runtime, staged, hold, services } = await library(t, { holdAt: 'plan' });
  const started = await runtime.call('generate', request, services('a'));
  await soon(() => hold.entered, 'the job to be at the model');
  const waited = await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 1 }, services('a'));
  assert.equal(waited.status, 'running', 'the wait gave up, the job did not');
  hold.open();
  assert.equal((await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 }, services('a'))).status, 'complete');
  assert.ok(staged.log.includes('review'));
});

test('every model call is a gateway step; the level, the mode and the usage are the call\'s own, per stage', async t => {
  const { runtime, services } = await library(t);
  await runtime.call('settings', { generation: { effortReview: 'highest', effortWriting: 'lowest' } });
  const started = await runtime.call('generate', request, services('a'));
  assert.equal((await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 }, services('a'))).status, 'complete');
  const { calls } = (await snapshotOf(runtime, started.jobId, services('a'))).contract;
  assert.ok(calls.length >= 4 && calls.every(call => call.observation.boundary === 'host-attempt'), 'plan, blueprint, author and review all went through the gateway');
  assert.ok(calls.every(call => call.feature === 'generate' && call.executionMode === 'agent-preferred'));
  const byKind = Object.fromEntries(calls.map(call => [call.kind, call.requestedEffort]));
  assert.deepEqual([byKind.plan, byKind.review, byKind.author], ['follow', 'highest', 'lowest']);
  assert.equal(new Set(calls.map(call => call.callId)).size, calls.length);
});

test('stopping one owner stops its jobs and leaves a sibling owner\'s job in the same library untouched', async t => {
  const { runtime, staged, hold, services } = await library(t, { holdAt: 'plan' });
  const owner = 'a', sibling = 'b';
  const first = await runtime.call('generate', request, services(owner));
  await soon(() => hold.entered, 'the first job to be at the model');
  const second = await runtime.call('generate', request, services(sibling));
  runtime.cancelOwner(owner);
  hold.open();
  await soon(() => runtime.work.jobs.get(first.jobId).status === 'cancelled', 'the stopped owner\'s job to end');
  assert.equal((await runtime.call('job.wait', { jobId: second.jobId, timeoutSeconds: 30 }, services(sibling))).status, 'complete');
  assert.ok(staged.log.includes('review'));
});

test('flipping the switch never resubmits a started attempt: each job runs once, on the side it was submitted', async t => {
  const { runtime, staged, hold, services } = await library(t, { holdAt: 'plan' });
  const legacy = await runtime.call('generate', request, services('a', false));
  await soon(() => hold.entered, 'the legacy job to be at the model');
  const managed = await runtime.call('generate', request, services('a'));
  assert.equal((await snapshotOf(runtime, legacy.jobId, services('a'))).contract.contractVersion, 1);
  assert.equal((await snapshotOf(runtime, managed.jobId, services('a'))).contract.contractVersion, 2);
  hold.open();
  for (const { jobId } of [legacy, managed]) assert.equal((await runtime.call('job.wait', { jobId, timeoutSeconds: 30 }, services('a'))).status, 'complete');
  assert.equal(staged.log.filter(stage => stage === 'plan').length, 2, 'two jobs, two planning calls: nothing ran twice');
});

test('a second run of the same request names its steps exactly like the first: the keys are the units\', not this attempt\'s', async t => {
  const { runtime, services } = await library(t);
  const keys = [];
  for (let run = 0; run < 2; run++) {
    const started = await runtime.call('generate', request, services('a'));
    assert.equal((await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 }, services('a'))).status, 'complete');
    keys.push((await snapshotOf(runtime, started.jobId, services('a'))).contract.calls.map(call => call.stepKey));
  }
  assert.deepEqual(keys[0], keys[1]);
  assert.equal(new Set(keys[0]).size, keys[0].length, `one key per unit: ${keys[0].join(' ')}`);
});
