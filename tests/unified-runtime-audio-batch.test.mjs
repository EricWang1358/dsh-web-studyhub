import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchLibrary, wav } from './helpers/audio-family.mjs';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { endAfterMemberResult, runBatchChild } from './helpers/audio-batch-child.mjs';
import { settleJob, until } from './helpers/wait.mjs';
import { taskKindOf } from '../ui/tasks/task-model.js';
import { isAudioJob } from '../lib/job-status.js';

// S2-2: the audio batch as a job of the unified runtime, whatever the suite's own switch side is. The characterization suites (audio-batch,
// audio-family-baseline-batch, job-control-audio, ...) run the same expectations on both sides; this file covers what only the runtime has.

const RUNTIME = switchOptions('runtime', { paths: [...AUDIO_SWITCHES] });
const runtimeBatch = (t, options = {}) => batchLibrary(t, { ...RUNTIME, ...options });
const rowOf = async (lib, id) => (await lib.service.call('snapshot')).jobs.find(job => job.id === id);
const manifestOf = async (lib, batchId) => JSON.parse(await readFile(join(lib.root, 'audio-batches', batchId, 'manifest.json'), 'utf8'));
const releaseAll = lib => () => { for (const release of lib.held.values()) release(); };

test('a batch is one job of the runtime: its own kind, honest capabilities, the audio family in the console, member commits in the manifest', async t => {
  const lib = await runtimeBatch(t);
  const started = await lib.service.call('audio.import', { files: [{ path: lib.a }, { path: lib.b }], title: 'Week 3' });
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const row = await rowOf(lib, started.jobId), { contract } = row;
  assert.deepEqual([contract.kind, contract.runtime.scopeId, row.type, taskKindOf(row), isAudioJob(row)], ['audio-batch', 'audio.v1', 'audio-batch', 'audio', true]);
  assert.deepEqual(contract.capabilities, { cancel: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint', retry: true, set: true, executionModes: ['direct', 'subagent'] });
  assert.equal(row.batchId, started.batchId);
  assert.ok(contract.calls.length > 0 && contract.calls.every(call => /^member:[01]:/.test(call.stepKey)), 'every call is named after its file');
  const manifest = await manifestOf(lib, started.batchId);
  assert.deepEqual([manifest.job.type, manifest.job.batchId, manifest.job.status], ['audio-import', started.batchId, 'complete']);
  assert.deepEqual(manifest.runtimeJob.commits.map(commit => [commit.stepKey, commit.status]).sort(), [['assemble:1', 'complete'], ['member:0', 'complete'], ['member:1', 'complete']]);
});

test('pause ends the attempt at a file boundary and resume carries on with the files not started, asking the model for nothing twice', async t => {
  const lib = await runtimeBatch(t, { hold: true });
  t.after(releaseAll(lib));
  const started = await lib.service.call('audio.import', { files: [{ path: lib.b }, { path: lib.a }] });
  await until(() => lib.held.has('B'), 'B is being transcribed');
  await lib.service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal((await rowOf(lib, started.jobId)).contract.status, 'pausing', 'asked, not reached: the file in flight is finished first');
  lib.held.get('B')();
  await until(async () => (await rowOf(lib, started.jobId)).contract.status === 'paused', 'the attempt ends at the file boundary');
  const paused = (await rowOf(lib, started.jobId)).contract;
  assert.equal(paused.runtime.attempts.at(-1).endReason, 'checkpoint-pause');
  assert.deepEqual([paused.actions.resume.available, paused.result.completeness], [true, 'partial']);
  assert.deepEqual(lib.calls, ['transcribe:B', 'proofread:B', 'translate:B', 'title:B'], 'B finished all its steps; A was not started');
  assert.equal((await lib.state()).sources.length, 0);
  await lib.service.call('job.control', { jobId: started.jobId, action: 'resume' });
  await until(() => lib.held.has('A'), 'A is transcribed by the second attempt');
  lib.held.get('A')();
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(lib.calls.filter(call => call.endsWith(':B')), ['transcribe:B', 'proofread:B', 'translate:B', 'title:B'], 'B is not asked again');
  const source = (await lib.state()).sources[0];
  assert.ok(source.text.indexOf('B.wav') < source.text.indexOf('A.wav'));
  assert.equal((await rowOf(lib, started.jobId)).contract.runtime.attempts.length, 2);
});

test('a skip retry that cannot start puts the skipped marks back, and one that can start leaves the file out', async t => {
  let broken = true;
  const lib = await runtimeBatch(t, { failTranslate: name => broken && name === 'B' });
  const first = await lib.service.call('audio.import', { files: [{ path: lib.a }, { path: lib.b }] });
  const failed = await settleJob(lib.service, first.jobId);
  assert.equal(failed.status, 'failed');
  const original = await readFile(lib.a);
  await writeFile(lib.a, wav(3));
  await assert.rejects(lib.service.call('audio.retry', { jobId: failed.id, skip: [1] }), /音频文件已改变：A\.wav/);
  assert.deepEqual((await manifestOf(lib, first.batchId)).members.map(member => !!member.skipped), [false, false], 'the marks went back');
  const card = await rowOf(lib, failed.id);
  assert.deepEqual([card.status, card.retryable], ['failed', true], 'the failed card is still there to act on');
  await writeFile(lib.a, original);
  const retried = await lib.service.call('audio.retry', { jobId: failed.id, skip: [1] });
  const done = await settleJob(lib.service, retried.jobId);
  assert.deepEqual([done.status, done.members.map(member => member.status)], ['complete', ['complete', 'skipped']]);
});

test('the switch routes new submissions only: a runtime batch resumes on the runtime with the switch off, a new batch then runs on the old path', async t => {
  let broken = true;
  const lib = await runtimeBatch(t, { failTranslate: name => broken && name === 'B' });
  const failed = await settleJob(lib.service, (await lib.service.call('audio.import', { files: [{ path: lib.a }, { path: lib.b }] })).jobId);
  assert.equal(failed.status, 'failed');
  const restarted = await lib.open({ runtimePilot: {} });
  broken = false;
  const retried = await settleJob(restarted, (await restarted.call('audio.retry', { jobId: failed.id })).jobId);
  assert.equal(retried.status, 'complete', retried.stage);
  const resumed = (await restarted.call('snapshot')).jobs.find(job => job.id === retried.id);
  assert.deepEqual([resumed.contract.contractVersion, resumed.contract.kind], [2, 'audio-batch']);
  const fresh = await settleJob(restarted, (await restarted.call('audio.import', { files: [{ path: lib.a }, { path: lib.b }], title: 'Another' })).jobId);
  assert.equal(fresh.status, 'complete', fresh.stage);
  assert.equal((await restarted.call('snapshot')).jobs.find(job => job.id === fresh.id).contract.contractVersion, 1, 'a new submission follows the switch');
});

async function crashedBatch(t, { lastMember = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'audio-batch-runtime-')), root = join(directory, 'library');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await runBatchChild({ directory, root, mode: lastMember ? 'last' : 'interrupt', ...(lastMember ? { preload: endAfterMemberResult(1) } : {}) });
  return { directory, root, batchId: first.batchId, child: (mode, options = {}) => runBatchChild({ directory, root, mode, ...options }),
    manifest: async () => JSON.parse(await readFile(join(root, 'audio-batches', first.batchId, 'manifest.json'), 'utf8')) };
}

test('a crash while a request is in flight refuses recovery: nothing is asked again and nothing is published', async t => {
  const crashed = await crashedBatch(t, { lastMember: false });
  const probe = await crashed.child('probe');
  assert.equal(probe.refusal.code, 'remote-result-unknown');
  assert.deepEqual([probe.before.status, probe.before.contract.actions.retry.reason.code, probe.calls, probe.sources], ['failed', 'remote-result-unknown', 0, 0]);
});

test('a crash with every request answered resumes from the saved results: no model request, one publication, the uploaded copy still there', async t => {
  const crashed = await crashedBatch(t);
  const before = await crashed.manifest();
  assert.deepEqual(before.runtimeJob.commits.map(commit => [commit.stepKey, commit.status]).sort(), [['member:0', 'complete'], ['member:1', 'pending']]);
  const resumed = await crashed.child('resume');
  assert.deepEqual([resumed.before.status, resumed.before.retryable, resumed.callsBeforeRetry, resumed.transcribed], ['failed', true, 0, []]);
  assert.equal(resumed.done.status, 'complete', resumed.done.stage);
  assert.equal(resumed.sources.length, 1);
  assert.deepEqual(resumed.sources[0].courses, ['Frozen A']);
  assert.ok(resumed.done.members.every(member => member.reused), 'both files come from their saved results');
  assert.equal(resumed.oldFailureLetters, 0);
  assert.equal((await crashed.manifest()).runtimeJob.commits.find(commit => commit.stepKey === 'member:1').status, 'complete');
});

const reseal = (result, change) => {
  const { checkpoint, ...payload } = result, { digest: _digest, ...metadata } = change(checkpoint, payload);
  checkpoint.digest = createHash('sha256').update(JSON.stringify({ result: payload, checkpoint: metadata })).digest('hex');
  return { ...payload, checkpoint };
};
for (const invalid of ['corrupt JSON', 'changed transcript', 'wrong member identity']) test(`a saved result with ${invalid} is made again, not published`, async t => {
  const crashed = await crashedBatch(t), file = join(crashed.root, 'audio-batches', crashed.batchId, 'result-1.json');
  const result = JSON.parse(await readFile(file, 'utf8'));
  if (invalid === 'corrupt JSON') await writeFile(file, '{', 'utf8');
  else if (invalid === 'changed transcript') await writeFile(file, JSON.stringify({ ...result, documents: ['An unrelated transcript.'] }), 'utf8');
  else await writeFile(file, JSON.stringify(reseal(result, checkpoint => ({ ...checkpoint, index: 0 }))), 'utf8');
  // Without the transcript cache the file has to be transcribed again: that is how the result is known not to have been used.
  await rm(join(crashed.root, 'audio-cache'), { recursive: true, force: true });
  const resumed = await crashed.child('resume');
  assert.equal(resumed.done.status, 'complete', resumed.done.stage);
  assert.deepEqual(resumed.transcribed, ['B'], 'the first file keeps its result; only the second is made again');
  assert.equal(resumed.sources.length, 1);
  assert.ok(resumed.sources[0].text.includes('B explains'), 'the published text is the new one');
});

test('a recording that changed after the crash is refused before any request, naming the file', async t => {
  const crashed = await crashedBatch(t);
  await writeFile(join(crashed.root, 'A.wav'), wav(3));
  const probe = await crashed.child('probe');
  assert.match(probe.refusal.message, /音频文件已改变：A\.wav/);
  assert.deepEqual([probe.calls, probe.sources], [0, 0]);
});
