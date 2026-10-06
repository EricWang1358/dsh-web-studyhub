import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { fakeAudioService, TEST_KEY, wav } from '../audio-single-characterization-process.mjs';
import { settleJob, until } from '../../helpers/wait.mjs';
import { flushAudioUsage } from '../../../lib/audio-dashboard.js';

const [mode, root, oldRoot] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let output;
if (mode === 'prepare') {
  await mkdir(root, { recursive: true });
  const runtimePilot = { audioSingle: true }, f = fakeAudioService(root, { managed: true, runtimeOptions: { runtimePilot } });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host' });
  const path = join(root, 'complete.wav'); await writeFile(path, wav());
  const first = await f.service.call('audio.import', { path });
  assert.equal((await settleJob(f.service, first.jobId)).status, 'complete');
  runtimePilot.audioSingle = false;
  const off = await f.service.call('audio.import', { path });
  assert.equal((await settleJob(f.service, off.jobId)).status, 'complete');
  const snapshot = await f.service.call('snapshot');
  assert.equal(snapshot.jobs.find(job => job.id === off.jobId).contract.contractVersion, 1);
  const source = await f.service.call('source.get', { id: snapshot.sources[0].id });
  assert.ok(typeof source.text === 'string' && source.text.length > 20);
  await f.service.dispose();
  const paused = fakeAudioService(root, { managed: true, holdTranscription: true });
  const pausePath = join(root, 'paused.wav'), bytes = wav(); bytes[bytes.length - 1] = 9; await writeFile(pausePath, bytes);
  const submitted = await paused.service.call('audio.import', { path: pausePath });
  await until(() => paused.calls.includes('transcribe'), 'rollback checkpoint request');
  await paused.service.call('job.control', { jobId: submitted.jobId, action: 'pause' }); paused.release();
  await until(async () => (await paused.service.call('snapshot')).jobs.find(job => job.id === submitted.jobId).contract.status === 'paused', 'rollback checkpoint saved');
  const job = (await paused.service.call('snapshot')).jobs.find(job => job.id === submitted.jobId);
  const manifestPath = join(root, 'audio-batches', job.singleId, 'manifest.json');
  output = { sourceId: source.id, sourceText: source.text, pausedJobId: job.id, pausedSingleId: job.singleId, manifestPath,
    manifestHash: hash(await readFile(manifestPath)), checkpoint: job.contract.runtime.attempts.at(-1).checkpointRef,
    newAdmissionOffIsV1: true, completedDrained: true, pausedPhysicalAttemptFinished: job.contract.runtime.activeAttemptId === null };
  await writeFile(join(root, 'rollback-baseline.json'), JSON.stringify(output));
  await flushAudioUsage();
  // Exit after the saved safe boundary, without converting the paused logical
  // job to cancelled through deliberate owner disposal.
} else if (mode === 'old-read') {
  const { StudyService } = await import(pathToFileURL(join(oldRoot, 'lib/service.js')));
  let calls = 0;
  const service = new StudyService(root, { fetch: async () => { calls++; throw new Error('rollback forbids model dispatch'); },
    complete: async () => { calls++; throw new Error('rollback forbids model dispatch'); } });
  const expected = JSON.parse(await readFile(join(root, 'rollback-baseline.json'))), snapshot = await service.call('snapshot');
  assert.ok(snapshot.sources.some(item => item.id === expected.sourceId));
  const source = await service.call('source.get', { id: expected.sourceId });
  assert.ok(typeof expected.sourceText === 'string' && expected.sourceText.length > 20);
  assert.equal(source.text, expected.sourceText);
  const job = snapshot.jobs.find(item => item.singleId === expected.pausedSingleId);
  assert.equal(job.contract.actions.resume.available, false);
  assert.equal(job.contract.actions.resume.reason.code, 'kernel-recovery-required');
  let refusal;
  try { await service.call('audio.retry', { jobId: job.id }); } catch (error) { refusal = error.code || error.message; }
  assert.ok(refusal); assert.equal(calls, 0);
  assert.equal(hash(await readFile(expected.manifestPath)), expected.manifestHash);
  output = { oldSha: 'b53b14752ec74dc149d2c7690cc33a5d6ab9e6b7', runtimeStarted: true, sourceReadableAndUnchanged: true,
    unfinishedCanResume: false, actionReason: job.contract.actions.resume.reason.code, explicitRetryRefusal: refusal,
    modelCalls: calls, manifestPreserved: true, scope: 'old StudyService process over private synthetic library; not a desktop/web host downgrade or real provider validation' };
  await service.dispose();
  assert.equal(hash(await readFile(expected.manifestPath)), expected.manifestHash);
} else if (mode === 'current-resume') {
  const expected = JSON.parse(await readFile(join(root, 'rollback-baseline.json')));
  const f = fakeAudioService(root, { managed: true });
  await f.service.call('snapshot'); assert.deepEqual(f.calls, []);
  await f.service.call('job.control', { jobId: expected.pausedJobId, action: 'resume' });
  const done = await settleJob(f.service, expected.pausedJobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(f.calls, ['proofread', 'translate', 'title']);
  assert.equal(f.starts(), 1);
  output = { compatibleRuntimeResumes: true, freshNativeBindings: f.starts(), calls: f.calls, retranscribed: false,
    modelBoundary: 'controlled executor and fake responses; not paid quality validation' };
  await f.service.dispose(); await flushAudioUsage();
} else throw new Error('Unknown rollback probe mode');
await new Promise(resolve => process.stdout.write(JSON.stringify(output), resolve));
process.exit(0);
