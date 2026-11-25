import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { stageSystem } from '../lib/prompt-order.js';
import { settleJob } from './helpers/wait.mjs';
import { evidence } from './helpers/supplement-fixtures.mjs';
import { openLibrary, stagedModel } from './helpers/generation-baseline.mjs';

/* #1400: the learner level a run was asked with survives a continuation of its draft, a retry with the original settings and the model review, and a value that is not a
   level never reaches the request. Fake models only. */

const levelOf = text => (/"learnerLevel":"(\w+)"/.exec(text) || [])[1];

/** A library holding one material, whose model is `complete` or the staged fake; every request is recorded with its stage head. */
async function stagedLibrary(t, complete) {
  const staged = stagedModel(), record = [];
  const model = complete || (async (system, prompt, context) => { record.push({ head: stageSystem(system, prompt), prompt }); return staged.complete(system, prompt, context); });
  const opened = await openLibrary(t, { prefix: 'study-1400-', model });
  await opened.service.call('source.add', { id: 'p1', title: 'Notes', text: evidence, courses: ['A'] });
  return { ...opened, record };
}
const GENERATE = { sourceIds: ['p1'], count: 1, kind: 'flashcard' };

const LESSON = [
  'Serializable isolation prevents dirty reads, non-repeatable reads and phantoms by making concurrent transactions behave like some serial order of the same transactions.',
  'Snapshot isolation reads a consistent snapshot at the start of a transaction and detects first-writer-wins conflicts at commit, yet two transactions that read overlapping rows and write disjoint rows can still produce write skew.',
].join('\n\n');
const MORE = 'A write-ahead log records every change before the data page is written, so a crash can be repaired by replaying the log from the last checkpoint onwards.';

/** A service whose model is the repository's fake one; every request is recorded with its stage. */
async function recordingService(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-1400-'));
  const fake = createFakeModel({ latencyMs: 1 });
  const prompts = [];
  const service = new StudyService(root, { coach: false, complete: async (system, prompt, context) => {
    const head = stageSystem(system, prompt);
    prompts.push({ head, prompt });
    return fake(system, prompt, context);
  } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const lesson = await service.call('source.add', { title: 'Isolation', text: LESSON });
  const more = await service.call('source.add', { title: 'Logging', text: MORE });
  return { service, prompts, lesson, more };
}
const planning = item => /^(Plan a source-grounded|Prepare supported answers)/.test(item.head);

test('a continuation of a draft goes on with the level the draft was asked with, and the draft records it', async t => {
  const { service, prompts, lesson, more } = await recordingService(t);
  const first = await service.call('generate', { sourceIds: [lesson.id], count: 1, kind: 'flashcard', learnerLevel: 'sprint' });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.generation.learnerLevel, 'sprint', 'the draft records the level it was written with');
  prompts.length = 0;
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, extraSourceIds: [more.id], count: 1 });
  const done = await settleJob(service, next.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const asked = prompts.filter(planning);
  assert.ok(asked.length, 'the continuation asked its planning stages');
  assert.deepEqual([...new Set(asked.map(item => levelOf(item.prompt)))], ['sprint']);
  assert.equal((await service.call('export')).drafts[0].editorial.generation.learnerLevel, 'sprint');
});

test('a draft written without a level records none, and its continuation stays unspecified', async t => {
  const { service, prompts, lesson, more } = await recordingService(t);
  const first = await service.call('generate', { sourceIds: [lesson.id], count: 1, kind: 'flashcard' });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  assert.equal('learnerLevel' in draft.editorial.generation, false);
  prompts.length = 0;
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, extraSourceIds: [more.id], count: 1 });
  const done = await settleJob(service, next.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.ok(prompts.length && prompts.every(item => !/learnerLevel/.test(item.prompt)));
});

test('a value that is not a learner level is dropped from the request: it is not in the prompts nor in what the job was asked', async t => {
  const { service, prompts, lesson } = await recordingService(t);
  const started = await service.call('generate', { sourceIds: [lesson.id], count: 1, kind: 'flashcard', learnerLevel: 'bogus' });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  assert.ok(prompts.length && prompts.every(item => !/bogus|learnerLevel/.test(item.prompt)));
  const job = (await service.call('snapshot')).jobs.find(item => item.id === started.jobId);
  assert.equal('learnerLevel' in job.asked, false);
  assert.equal('learnerLevel' in (await service.call('export')).drafts[0].editorial.generation, false);
});

test('a failed run keeps the level it was asked with in `asked`, for the retry with the original settings', async t => {
  const failing = async () => { throw new Error('model unavailable'); };
  const { service } = await stagedLibrary(t, failing);
  const started = await service.call('generate', { ...GENERATE, learnerLevel: 'rusty' });
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'failed', done.stage);
  const job = (await service.call('snapshot')).jobs.find(item => item.id === started.jobId);
  assert.equal(job.asked.learnerLevel, 'rusty');
});

test('the model review of a generated draft is told the level, like the stages that wrote it', async t => {
  const { service, record } = await stagedLibrary(t);
  const started = await service.call('generate', { ...GENERATE, learnerLevel: 'rusty' });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const reviews = record.filter(item => item.head.startsWith('Act as a strict'));
  assert.ok(reviews.length, 'the review was asked');
  assert.deepEqual([...new Set(reviews.map(item => levelOf(item.prompt)))], ['rusty']);
  // The review made when the draft is published is told the level the draft was written with.
  const generated = (await service.call('export')).drafts[0];
  const edited = await service.call('draft.save', { deck: { ...generated, cards: generated.cards.map(item => ({ ...item, explanation: `${item.explanation} Edited by the learner.` })) } });
  record.length = 0;
  const published = await service.call('draft.publish.start', { id: edited.id, draftVersion: edited.draftVersion });
  assert.equal((await settleJob(service, published.jobId)).status, 'complete');
  const publication = record.filter(item => item.head.startsWith('Act as a strict'));
  assert.ok(publication.length, 'the publication asked a review');
  assert.deepEqual([...new Set(publication.map(item => levelOf(item.prompt)))], ['rusty']);
});
