import test from 'node:test';
import assert from 'node:assert/strict';
import { jobArchive } from '../lib/job-archive.js';
import { jobCleanup } from '../lib/job-cleanup.js';
import { writeSaved } from '../lib/live.js';
import { batchLibrary, hostModel, library, seedReview, subtitleText } from './helpers/audio-family.mjs';
import { settleJob } from './helpers/wait.mjs';

/* S2-0 fixtures for archive / unarchive / dismiss / retry names of the audio family, on the code as it is.
   Already covered elsewhere: the single-file import (job-archive-service), the archive store and operations (job-archive*), legacy recovery cards (audio-retry). */

const restart = async lib => { jobArchive(lib.root).reload(); return lib.open(); };

test('a failed batch: archived by its batch id (its job id is an alias), kept archived across a restart, unarchived from its folder, retried, dismissed with its working copy', async t => {
  let broken = true;
  const lib = await batchLibrary(t, { failTranslate: name => broken && name === 'B' });
  const first = await lib.service.call('audio.import', { files: [{ path: lib.a }, { path: lib.b }] });
  const failed = await settleJob(lib.service, first.jobId);
  assert.deepEqual([failed.status, failed.batchId], ['failed', first.batchId]);
  const before = lib.calls.length;

  assert.deepEqual((await lib.service.call('job.archive', { jobIds: [first.batchId] })).archived, [first.batchId]);
  assert.deepEqual(await lib.folders(), [first.batchId], 'archiving deletes nothing');
  const snapshot = await lib.service.call('snapshot');
  assert.deepEqual([snapshot.jobs, snapshot.archivedJobs.length, snapshot.archivedJobs[0].contract.jobId], [[], 1, first.batchId]);
  assert.deepEqual((await lib.service.call('job.archive', { jobIds: [failed.id] })).alreadyArchived, [failed.id], 'the attempt id is an alias of the archived lineage');

  const restarted = await restart(lib);
  assert.deepEqual([(await restarted.call('snapshot')).jobs, (await restarted.call('snapshot')).archivedJobs.length], [[], 1]);
  await assert.rejects(restarted.call('job.control', { jobId: failed.id, action: 'retry' }), error => error.code === 'archived');
  await assert.rejects(restarted.call('audio.retry', { jobId: failed.id }), /这个任务不能重试/);

  assert.deepEqual((await restarted.call('job.unarchive', { jobIds: [failed.id] })).unarchived, [failed.id]);
  const back = (await restarted.call('snapshot')).jobs;
  assert.deepEqual([back.length, back[0].batchId, back[0].id, back[0].contract.actions.retry.available], [1, first.batchId, failed.id, true]);
  broken = false;
  const retried = await restarted.call('job.control', { jobId: first.batchId, action: 'retry' });
  assert.deepEqual([retried.batchId, retried.attemptId === failed.id, retried.jobId === failed.id], [first.batchId, true, false]);
  const done = await settleJob(restarted, retried.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(lib.calls.slice(before).map(call => call.split(':')[0]), ['translate', 'title'], 'only what the failed member had not finished is done again');

  assert.deepEqual((await restarted.call('job.dismiss', { jobId: done.id })).dismissed, [done.id]);
  await jobCleanup.idle();
  assert.deepEqual([(await restarted.call('snapshot')).jobs, await lib.folders(), (await lib.state()).sources.length], [[], [], 1], 'the folder goes, the source stays');
});

/** Jobs that have no manifest: a finished one per kind, made by the real entry point with fake models. */
const KINDS = {
  subtitle: (service) => service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText }),
  review: async service => { await seedReview(service, 2); return service.call('audio.corrections.review', { sourceId: 'talk-1' }); },
  'live-save': async (service, lib) => {
    await writeSaved(lib.root, { id: 'saved-class-0001', title: 'Databases', segments: [{ id: 1, t: 0, en: 'Transactions preserve consistency.', zh: '译', zhState: 'done' }] });
    return service.call('live.save', { id: 'saved-class-0001', proofread: true });
  },
};
for (const [kind, create] of Object.entries(KINDS)) test(`${kind}: a record-only job is archived, stays archived after a restart, comes back from its record with nothing to retry, and dismiss removes it`, async t => {
  const log = [];
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log) });
  const done = await settleJob(lib.service, (await create(lib.service, lib)).jobId);
  assert.equal(done.status, 'complete', done.stage);
  const requests = log.length, sources = (await lib.state()).sources.map(source => source.id);
  assert.deepEqual((await lib.service.call('job.archive', { jobIds: [done.id] })).archived, [done.id]);
  const archived = (await lib.service.call('snapshot')).archivedJobs[0];
  assert.deepEqual([archived.contract.kind, archived.contract.status, archived.contract.jobId], ['audio-import', 'complete', done.id]);
  assert.deepEqual((await lib.state()).sources.map(source => source.id), sources, 'the sources the job made stay in the library');

  const restarted = await restart(lib);
  assert.deepEqual([(await restarted.call('snapshot')).jobs, (await restarted.call('snapshot')).archivedJobs.length], [[], 1]);
  assert.deepEqual((await restarted.call('job.unarchive', { jobIds: [done.id] })).unarchived, [done.id]);
  const back = (await restarted.call('snapshot')).jobs.find(job => job.id === done.id);
  assert.deepEqual([back.contract.status, back.contract.jobId, back.contract.actions.retry.available, back.sourceIds], ['complete', done.id, false, undefined], 'a record has no sourceIds field, only the contract refs');
  assert.deepEqual(back.contract.result.refs.map(ref => ref.id), done.sourceIds);
  await assert.rejects(restarted.call('audio.retry', { jobId: done.id }), /这个任务不能重试/);
  assert.deepEqual((await restarted.call('job.dismiss', { jobId: done.id })).dismissed, [done.id]);
  assert.deepEqual([(await restarted.call('snapshot')).jobs, (await restarted.call('snapshot')).archivedJobs, log.length], [[], [], requests]);
});
