import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { archiveRecordOf, jobArchive } from '../lib/job-archive.js';
import { jobCleanup } from '../lib/job-cleanup.js';
import { createJobServices } from '../lib/runtime/jobs.js';
import { ACTIONS, archivedContract } from '../lib/job-contract.js';
import { goldenRuntimeContracts, validateRuntimeContract } from './fixtures/unified-runtime-contract.mjs';

// Exercise the real library-wide recovery scan with saved legacy manifests. Restoring history must not run a model or reopen a retry.
async function library(t, kind = 'batch') {
  const root = await mkdtemp(join(tmpdir(), 's11-recovery-'));
  t.after(async () => { await jobCleanup.idle(); await rm(root, { recursive: true, force: true }); });
  const at = new Date().toISOString(), v2 = structuredClone(goldenRuntimeContracts.running);
  v2.capabilities = { ...v2.capabilities, retry: false, recoveryMode: 'none' };
  v2.status = 'complete'; v2.finishedAt = at; v2.runtime.activeAttemptId = null; v2.runtime.legacyId = 'legacy-v2-job';
  v2.runtime.attempts[0].status = 'complete'; v2.runtime.steps[0].status = 'complete'; v2.calls[0].status = 'ok';
  v2.actions = Object.fromEntries(ACTIONS.map(name => [name, { available: false, reason: { code: 'job-ended' } }]));
  v2.actions.pause.mode = v2.capabilities.pauseMode;
  validateRuntimeContract(v2);
  const old = archiveRecordOf({ id: 'legacy-v1-job', type: 'audio-import', batchId: 'legacy-v1-folder', filename: 'v1.mp3', status: 'failed', finishedAt: at }, { at });
  const modern = { id: v2.jobId, ids: [v2.jobId, 'legacy-v2-job', 'observed-alias'], archivedAt: at, files: 'legacy-v2-folder',
    job: { id: 'legacy-v2-job', type: 'audio-import', status: 'complete', finishedAt: at, archived: { at }, contract: archivedContract(v2, at) } };
  await jobArchive(root).add([old, modern]);
  const manifests = [];
  for (const record of [old, modern]) {
    const directory = join(root, 'audio-batches', record.files);
    await mkdir(directory, { recursive: true });
    const bytes = JSON.stringify({ id: record.files, kind, job: { id: record.job.id, type: 'audio-import',
      ...(kind === 'batch' ? { batchId: record.files } : {}), status: 'failed', retryable: true, filename: 'history.mp3', finishedAt: at } });
    const path = join(directory, 'manifest.json');
    await writeFile(path, bytes);
    manifests.push({ path, bytes });
  }
  let modelCalls = 0;
  const service = new StudyService(root, { complete: async () => { modelCalls++; throw new Error('Unexpected model call'); } });
  await service.call('snapshot');
  return { root, service, v2, modern, manifests, modelCalls: () => modelCalls };
}

for (const kind of ['batch', 'single']) for (const mode of ['mixed', 'later-v1']) {
  test(`real ${kind} recovery preserves v2 history during ${mode} unarchive`, async t => {
    const { root, service, v2, manifests, modelCalls } = await library(t, kind);
    if (mode === 'mixed') await service.call('job.unarchive', { jobIds: ['legacy-v1-job', 'legacy-v2-job'] });
    else {
      await service.call('job.unarchive', { jobIds: ['legacy-v2-job'] });
      await service.call('job.unarchive', { jobIds: ['legacy-v1-job'] });
    }
    const snapshot = await service.call('snapshot'), restored = snapshot.jobs.find(job => job.id === 'legacy-v2-job');
    assert.equal(restored?.contract.contractVersion, 2, 'the legacy manifest cannot replace saved v2 history');
    assert.deepEqual(restored.contract.runtime, v2.runtime);
    assert.equal(restored.contract.actions.retry.available, false);
    assert.equal(restored.contract.actions.retry.reason.code, 'capability-unsupported');
    await assert.rejects(service.call('job.control', { jobId: restored.id, action: 'retry' }), error => error.code === 'capability-unsupported');
    assert.equal(service.runtime.work.retryable.has(restored.id), false);
    assert.equal(restored.batchId, undefined, 'the archive folder does not prove that this history was a batch');
    assert.equal(restored.singleId, undefined, 'the archive folder does not prove that this history was a single import');
    for (const { path, bytes } of manifests) assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(snapshot.jobs.find(job => job.id === 'legacy-v1-job').contract.contractVersion, 1);
    assert.equal((await jobArchive(root).list()).length, 0);
    assert.equal(modelCalls(), 0);
  });
}

test('restored v2 archive aliases and folder survive rearchive and restart, without exposing private association', async t => {
  const { root, service, v2, modern, manifests, modelCalls } = await library(t);
  await service.call('job.unarchive', { jobIds: [modern.id] });
  const snapshot = await service.call('snapshot'), row = snapshot.jobs.find(job => job.id === modern.job.id);
  const lean = await service.call('job.status', { jobId: modern.job.id });
  for (const view of [row, lean]) {
    assert.equal(JSON.stringify(view).includes(modern.files), false, 'folder association remains private');
    assert.equal(JSON.stringify(view).includes('observed-alias'), false, 'archive aliases remain private');
  }
  assert.deepEqual((await service.call('job.archive', { jobIds: ['observed-alias'] })).archived, ['observed-alias']);
  const saved = await jobArchive(root).find(modern.id);
  assert.ok(saved);
  assert.equal(saved.files, modern.files);
  assert.ok(saved.ids.includes('observed-alias'));
  assert.deepEqual(saved.job.contract.runtime, v2.runtime);
  jobArchive(root).reload();
  const restarted = new StudyService(root, { complete: async () => { throw new Error('Unexpected model call'); } });
  assert.equal((await restarted.call('snapshot')).jobs.length, 0, 'rearchive still excludes legacy manifests after restart');
  await restarted.call('job.unarchive', { jobIds: ['observed-alias'] });
  assert.equal((await restarted.call('snapshot')).jobs.find(job => job.id === modern.job.id).contract.contractVersion, 2);
  for (const { path, bytes } of manifests) assert.equal(await readFile(path, 'utf8'), bytes);
  assert.equal(modelCalls(), 0);
});

for (const operation of ['job.delete', 'job.dismiss']) test(`${operation} releases the observed folder after restoring v2 history`, async t => {
  const { root, service, modern, modelCalls } = await library(t);
  await service.call('job.unarchive', { jobIds: [modern.id] });
  const args = operation === 'job.delete' ? { jobIds: ['observed-alias'] } : { jobId: modern.job.id };
  const result = await service.call(operation, args);
  assert.deepEqual(result[operation === 'job.delete' ? 'deleted' : 'dismissed'], [operation === 'job.delete' ? 'observed-alias' : modern.job.id]);
  await jobCleanup.idle();
  assert.equal((await readdir(join(root, 'audio-batches'))).some(name => name.includes(modern.files)), false);
  assert.equal((await service.call('snapshot')).jobs.some(job => job.id === modern.job.id), false);
  assert.equal(modelCalls(), 0);
});

test('trimming restored v2 history rearchives its observed association before the next legacy scan', async t => {
  const { root, service, modern, v2, modelCalls } = await library(t);
  await service.call('job.unarchive', { jobIds: [modern.id] });
  const restored = service.runtime.work.jobs.get(modern.job.id);
  restored.startedAt = '2020-01-01T00:00:00.000Z';
  for (let n = 0; n < 100; n++) service.runtime.work.jobs.set(`filler-${n}`, {
    id: `filler-${n}`, root, status: 'complete', startedAt: new Date(Date.now() + n).toISOString(), finishedAt: new Date().toISOString(),
  });
  await createJobServices(service.runtime.work).pruneJobs();
  assert.equal(service.runtime.work.jobs.has(modern.job.id), false);
  const saved = await jobArchive(root).find('observed-alias');
  assert.ok(saved, 'history leaves memory only after its archive record is restored');
  assert.equal(saved.files, modern.files);
  assert.deepEqual(saved.job.contract.runtime, v2.runtime);
  await service.call('job.unarchive', { jobIds: ['legacy-v1-job'] });
  assert.equal(service.runtime.work.jobs.has(modern.job.id), false, 'archived v2 history cannot return through the old manifest');
  assert.equal(service.runtime.work.retryable.has(modern.job.id), false);
  assert.equal(modelCalls(), 0);
});

for (const outcome of ['saved', 'failed']) test(`v2 history remains visible until automatic archive writer is ${outcome}`, async t => {
  const { root, service, modern, modelCalls } = await library(t);
  await service.call('job.unarchive', { jobIds: [modern.id] });
  const work = service.runtime.work, restored = work.jobs.get(modern.job.id), archive = jobArchive(root);
  restored.startedAt = '2020-01-01T00:00:00.000Z';
  for (let n = 0; n < 100; n++) work.jobs.set(`filler-${n}`, {
    id: `filler-${n}`, root, status: 'complete', startedAt: new Date(Date.now() + n).toISOString(), finishedAt: new Date().toISOString(),
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; }), original = archive.add;
  archive.add = async records => {
    await gate;
    if (outcome === 'failed') throw new Error('Synthetic archive write failure');
    return original(records);
  };
  const pruning = createJobServices(work).pruneJobs();
  try {
    assert.equal(work.jobs.get(modern.job.id), restored, 'history stays in the same job map while its archive write is pending');
    await service.runtime.invoke('audio.v1', 'recover', { again: true });
    assert.equal(work.jobs.get(modern.job.id), restored, 'the old scan still excludes pending v2 history');
    assert.equal(work.retryable.has(modern.job.id), false);
  } finally {
    release();
    await pruning;
    archive.add = original;
  }
  assert.equal(work.jobs.has(modern.job.id), outcome === 'failed');
  assert.equal(!!await archive.find(modern.id), outcome === 'saved');
  assert.equal(modelCalls(), 0);
});

for (const operation of ['job.delete', 'job.dismiss']) test(`${operation} cannot be undone by a pending v2 automatic archive handoff`, async t => {
  const { root, service, modern, modelCalls } = await library(t);
  await service.call('job.unarchive', { jobIds: [modern.id] });
  const work = service.runtime.work, restored = work.jobs.get(modern.job.id), archive = jobArchive(root);
  restored.startedAt = '2020-01-01T00:00:00.000Z';
  for (let n = 0; n < 100; n++) work.jobs.set(`filler-${n}`, {
    id: `filler-${n}`, root, status: 'complete', startedAt: new Date(Date.now() + n).toISOString(), finishedAt: new Date().toISOString(),
  });
  let release, didWrite;
  const gate = new Promise(resolve => { release = resolve; }), written = new Promise(resolve => { didWrite = resolve; }), original = archive.add;
  archive.add = async records => {
    // Enqueue the actual per-root writer before holding its completion handoff.
    const result = await original(records);
    didWrite();
    await gate;
    return result;
  };
  const pruning = createJobServices(work).pruneJobs();
  try {
    await written;
    const args = operation === 'job.delete' ? { jobIds: [modern.job.id] } : { jobId: modern.job.id };
    await service.call(operation, args);
    assert.equal(await archive.find(modern.id), null, 'permanent deletion removes the queued archive copy too');
  } finally {
    release();
    await pruning;
    archive.add = original;
  }
  await jobCleanup.idle();
  assert.equal(work.jobs.has(modern.job.id), false);
  assert.equal(await archive.find('observed-alias'), null);
  assert.equal((await readdir(join(root, 'audio-batches'))).some(name => name.includes(modern.files)), false);
  assert.equal(modelCalls(), 0);
});
