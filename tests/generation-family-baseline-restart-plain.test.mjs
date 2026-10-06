import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { sectionedModel } from './helpers/coverage-fixture.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { gate, holding, openLibrary, restartedOver, jobsOf, finish, soon } from './helpers/generation-baseline.mjs';

/* S3-0 baseline, restart boundary of the ORDINARY paths (plain/mixed/case first draft, publish.start). Coverage runs have a restart restoration (tests/coverage-run-exec.test.mjs);
   these paths have none: the library folder keeps what was saved (the draft is the only checkpoint), but no job is restored, nothing is interrupted-visible and nothing is
   resumed by itself. The tests describe CURRENT behaviour; the gaps are owned by S3-3 (ordinary + supplement), S3-5 (repair) and S3-6 (publish). */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const PLAIN = { kind: 'quiz', count: 6, performance: { concurrency: 1, batchSize: 4, jobTimeoutMinutes: 20, fillRounds: 0, ...EFFORTS } };
const sourceIds = world.sources.map(source => source.id);

async function library(t, when) {
  const hold = gate(), model = sectionedModel();
  const opened = await openLibrary(t, { model: holding(hold, when)(model.complete), hold });
  for (const source of world.sources) await opened.service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { ...opened, hold, model };
}

test('ordinary run killed before its first draft is saved: nothing on disk, no job after the restart, no automatic model call', async t => {
  const first = await library(t);
  const started = await first.service.call('generate', { sourceIds, ...PLAIN });
  await soon(() => first.hold.entered, 'the first planning call to be held');
  assert.equal((await first.service.call('export')).drafts.length, 0, 'the first draft exists only after its first part passed review');
  const after = await restartedOver(t, first.root);
  assert.deepEqual(await jobsOf(after.service), [], 'the job lived in memory only: it is not restored, not interrupted-visible, not archived');
  assert.deepEqual(await after.service.call('coverage.recover'), { recovered: 0 }, 'the one restart restoration of generation (coverage) has nothing to restore');
  assert.equal((await after.service.call('export')).drafts.length, 0);
  assert.deepEqual(after.calls, [], 'no model call happened by itself');
  await finish(first.service, first.hold, started.jobId);
});

test('ordinary run killed after its first part: the draft keeps the checkpoint and its own request, but no job is restored; the learner can continue by hand with 接着做 of the draft', async t => {
  const first = await library(t, (system, _prompt, context) => /^Prepare supported/.test(system) && /^Part 2\//.test(context.stage || ''));
  const started = await first.service.call('generate', { sourceIds, ...PLAIN });
  await soon(() => first.hold.entered, 'part 2 to be held');
  await soon(async () => (await first.service.call('export')).drafts[0]?.cards.length === 4, 'the first part to be saved');
  const saved = (await first.service.call('export')).drafts[0];
  const after = await restartedOver(t, first.root);
  const draft = (await after.service.call('export')).drafts[0];
  assert.equal(draft.id, saved.id);
  assert.deepEqual(draft.cards.map(card => card.id), saved.cards.map(card => card.id), 'the approved questions are on disk');
  assert.equal(draft.editorial.requested, 6, 'what was asked for is on the draft');
  assert.equal(draft.editorial.coverageRun, undefined, 'no run marker: nothing says the run was in flight');
  assert.equal(draft.editorial.generation.performance.batchSize, 4, 'the request settings travel with the draft');
  assert.deepEqual(await jobsOf(after.service), [], 'no interrupted job, no 接着做 button on the task list');
  assert.deepEqual(after.calls, []);
  // The persisted input is enough to continue by hand (the draft page / the same resumeDraftId call): same draft, same ids.
  after.service.complete = sectionedModel().complete;
  const next = await after.service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion });
  assert.equal(next.draftId, draft.id);
  assert.equal((await settleJob(after.service, next.jobId)).status, 'complete');
  const done = (await after.service.call('export')).drafts[0];
  assert.deepEqual(done.cards.slice(0, 4).map(card => card.id), draft.cards.map(card => card.id), 'every approved question stays in place');
  assert.equal((await after.service.call('export')).drafts.length, 1, 'no second draft');
  await finish(first.service, first.hold, started.jobId);
});

test('publish.start killed during its review: the draft is untouched and the deck absent; no job is restored; starting again is the only way on', async t => {
  const hold = gate(), source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
  const card = { id: 'q', kind: 'flashcard', topic: 'Architecture', objective: 'Explain architectural principles', prompt: 'What guides later system design?', answer: 'Architectural principles.',
    hint: 'Think of design constraints.', explanation: 'The notes say principles guide design and change.', misconception: 'Only components matter.', citations: [{ sourceId: 's', quote: source.text }] };
  const review = async (_system, prompt) => JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  const first = await openLibrary(t, { model: holding(hold)(review), hold });
  await first.service.call('source.add', source);
  const saved = await first.service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [card] } });
  const started = await first.service.call('draft.publish.start', { id: saved.id, draftVersion: saved.draftVersion });
  await soon(() => hold.entered, 'the publication review to be held');
  const after = await restartedOver(t, first.root);
  const state = await after.service.call('export');
  assert.deepEqual([state.decks.length, state.drafts.length, state.drafts[0].draftVersion], [0, 1, saved.draftVersion], 'the commit point (the deck) was not reached; the draft is as it was');
  assert.deepEqual(await jobsOf(after.service), []);
  assert.deepEqual(after.calls, [], 'the review is not asked again by itself');
  after.service.complete = review;
  const again = await after.service.call('draft.publish.start', { id: saved.id, draftVersion: saved.draftVersion });
  assert.equal((await settleJob(after.service, again.jobId)).status, 'complete');
  assert.equal((await after.service.call('export')).decks[0].cards.length, 1);
  // A finished publication leaves no durable task record either: after another restart the job is gone from the list.
  const later = await restartedOver(t, after.root);
  assert.deepEqual(await jobsOf(later.service), [], 'terminal history of non-coverage jobs is in memory only (outside job.archive)');
  await finish(first.service, hold, started.jobId);
});
