import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { readAudioBatch, saveAudioBatch } from '../lib/audio-batch.js';
import { finishedElsewhere } from '../lib/contexts/audio/jobs/submit-audio.js';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { endAfterMemberResult, runBatchChild } from './helpers/audio-batch-child.mjs';

/* S2-7b: roll back to 2.7.1, let it finish an interrupted batch by its old path, roll forward again. The older version finishes the work (the documents are in the library,
   every file is complete) but writes only its own facts: the runtime record it never knew keeps saying "interrupted". One fact must be one state: the card of finished work
   is a finished card. Fakes only; the older version's side of this is simulated by writing exactly those facts through the same legacy writers it used. */

async function crashedBatch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'audio-rollforward-')), root = join(directory, 'library');
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const { batchId } = await runBatchChild({ directory, root, mode: 'last', preload: endAfterMemberResult(1) });
  const manifestFile = join(root, 'audio-batches', batchId, 'manifest.json');
  return { directory, root, batchId, runtimeRecord: async () => JSON.stringify(JSON.parse(await readFile(manifestFile, 'utf8')).runtimeJob) };
}

/** What a build rolled back to 2.7.1 leaves after it finishes the batch itself: every file complete and the combined document in the library; the runtime record untouched. */
async function finishLikeTheOlderVersion({ root, batchId }, { documents = true, members = true } = {}) {
  const service = new StudyService(root, {});
  const batch = await readAudioBatch(root, batchId);
  if (members) for (const member of batch.members) member.status = 'complete';
  await saveAudioBatch(root, batch);
  if (documents) await service.store.update(state => { (state.sources ||= []).push({ id: `audio-batch-${batchId}`, title: `${batch.title} · 中英对照逐字稿`, text: 'A and B explain database indexes.', courses: [],
    audio: { batch: { id: batchId, title: batch.title, volume: 1, volumes: 1 }, proofread: true, sourceIds: [`audio-batch-${batchId}`] } }); });
  await service.dispose();
}

/** The learner's view after rolling forward: a service of the current code on the same library with the switches on. */
async function reopen(t, crashed) {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(crashed.directory, 'home');
  const service = new StudyService(crashed.root, switchOptions('runtime', { paths: [...AUDIO_SWITCHES] }));
  t.after(async () => { await service.dispose(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  return service;
}
const rowsOf = async service => (await service.call('snapshot')).jobs.map(job => ({ id: job.id, status: job.status, retry: job.contract?.actions?.retry?.available ?? job.retryable, sourceIds: job.sourceIds }));

test('a batch the older version finished is a finished card after rolling forward, and its runtime record is not touched', async t => {
  const crashed = await crashedBatch(t), recorded = await crashed.runtimeRecord();
  await finishLikeTheOlderVersion(crashed);
  const service = await reopen(t, crashed);
  const rows = await rowsOf(service);
  assert.deepEqual(rows.map(row => [row.status, row.retry, row.sourceIds]), [['complete', false, [`audio-batch-${crashed.batchId}`]]], 'one card, finished, nothing to retry');
  assert.equal(await crashed.runtimeRecord(), recorded, 'the kernel record is not edited from outside the store');
});

test('a batch whose documents are not in the library stays an interrupted job it can go on with', async t => {
  const crashed = await crashedBatch(t);
  await finishLikeTheOlderVersion(crashed, { documents: false });
  const rows = await rowsOf(await reopen(t, crashed));
  assert.deepEqual(rows.map(row => [row.status, row.retry]), [['failed', true]]);
});

test('a batch with a file that is not complete stays an interrupted job even if some document of it exists', async t => {
  const crashed = await crashedBatch(t);
  await finishLikeTheOlderVersion(crashed, { members: false });
  const batch = await readAudioBatch(crashed.root, crashed.batchId);
  batch.members[1].status = 'failed'; await saveAudioBatch(crashed.root, batch);
  const rows = await rowsOf(await reopen(t, crashed));
  assert.deepEqual(rows.map(row => [row.status, row.retry]), [['failed', true]]);
});

test('the same judgement for a single recording: finished when a document of that very recording is in the library, never when the runtime record already says complete', () => {
  const single = { kind: 'single', id: 'single-0001', input: { hash: 'abc' }, runtimeJob: { contract: { status: 'interrupted' } } };
  const library = sources => ({ sources });
  assert.equal(finishedElsewhere(single, library([{ id: 'x', audio: { hash: 'abc' } }])), true);
  assert.equal(finishedElsewhere(single, library([{ id: 'x', audio: { hash: 'other' } }])), false, 'another recording');
  assert.equal(finishedElsewhere(single, library([{ id: 'x', audio: { hash: 'abc', batch: { id: 'b' } } }])), false, 'a batch that happens to hold the same recording is not this import');
  assert.equal(finishedElsewhere(single, library([])), false);
  assert.equal(finishedElsewhere({ ...single, runtimeJob: { contract: { status: 'complete' } } }, library([{ id: 'x', audio: { hash: 'abc' } }])), false, 'the kernel already knows it is finished');
});
