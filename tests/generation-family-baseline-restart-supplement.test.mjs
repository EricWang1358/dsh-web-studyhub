import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { withQualityStages, qualityReview } from './helpers/assessment.mjs';
import { gate, openLibrary, restartedOver, jobsOf, finish, soon } from './helpers/generation-baseline.mjs';

/* S3-0 baseline, restart boundary of the SUPPLEMENT and REPAIR paths: `generate { resumeDraftId, extraSourceIds }`, the target supplement (`supplement { deckId }`) and `draft.repair`.
   Like the other ordinary paths they have no restart restoration: what the library folder keeps is the draft (a supplement's checkpoint, a repair's per-card saves) and, for a
   supplement, the untouched target deck; no job comes back and nothing continues by itself. Owners of the gaps: S3-3 (supplements), S3-5 (repair). Fake models only. */

const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
const other = 'A trade-off analysis weighs the cost of each architectural characteristic against the others.';
const card = (id, sourceId = 'p1', quote = evidence) => ({ id, kind: 'flashcard', topic: 'Bridge', objective: `Explain dimension ${id}`,
  prompt: `Why separate report and renderer dimension ${id}?`, answer: 'They can vary independently.', hint: 'Consider two reasons to change.',
  explanation: 'Report types and rendering backends vary independently.', misconception: 'A subclass for every combination causes a cross product.', citations: [{ sourceId, quote }] });
const SCHEDULE = { repetitions: 3, interval_days: 16, ease_factor: 2.6, due_at: '2026-10-16T00:00:00.000Z' };
const ONE_BY_ONE = { concurrency: 1, batchSize: 1, jobTimeoutMinutes: 20, fillRounds: 0, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };

/** A model that authors one fresh card per part and holds the author stage of the `at`-th part (1-based) until the gate is opened. */
function authoring(hold, at) {
  let authors = 0, seen = 0;
  const inner = withQualityStages(async (system, prompt) => {
    if (system.startsWith('You author')) return JSON.stringify({ title: 'Supplement', cards: [card(`new-${++authors}`, 'p1')] });
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  });
  return async (system, prompt, context = {}) => {
    if (system.startsWith('You author') && ++seen === at && !hold.entered) { hold.entered = true; await hold.promise; }
    return inner(system, prompt, context);
  };
}

test('extraSourceIds supplement killed after its first batch: the draft keeps the batch, the added source and the request; no job comes back', async t => {
  const hold = gate();
  const first = await openLibrary(t, { model: authoring(hold, 2), hold });
  await first.service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
  await first.service.call('source.add', { id: 'p2', title: 'Page 2', text: other });
  const seeded = await first.service.call('draft.save', { deck: { id: 'draft-a', title: 'Chapter', course: 'A', cards: [card('seed', 'p1')],
    editorial: { requested: 1, generated: 1, parts: 1, completedParts: 1, failures: [], generation: { sourceIds: ['p1'], kind: 'flashcard', language: 'English', difficulty: 'advanced', notation: 'text', course: 'A',
      performance: ONE_BY_ONE } } } });
  const started = await first.service.call('generate', { resumeDraftId: seeded.id, draftVersion: seeded.draftVersion, extraSourceIds: ['p2'], count: 2 });
  assert.equal(started.draftId, seeded.id, 'a supplement works on the same draft');
  await soon(async () => (await first.service.call('export')).drafts[0].cards.length === 2, 'the first added batch to be saved');
  const after = await restartedOver(t, first.root);
  const draft = (await after.service.call('export')).drafts[0];
  assert.equal(draft.id, seeded.id);
  assert.deepEqual(draft.cards.map(item => item.id).slice(0, 1), ['seed'], 'the existing card id is untouched');
  assert.equal(draft.cards.length, 2, 'the batch that passed review is the checkpoint');
  assert.equal(draft.editorial.requested, 3, 'the request grew by what was asked for (1 + 2), though only 1 was added');
  assert.ok(draft.editorial.generation.sourceIds.includes('p2'), 'the added source is recorded with the first save');
  assert.equal(draft.editorial.coverageRun, undefined);
  assert.deepEqual(await jobsOf(after.service), [], 'no interrupted job, no continue button');
  assert.deepEqual(after.calls, []);
  await finish(first.service, hold, started.jobId);
});

test('target supplement killed after its first batch: the target deck (card ids, schedule, attempts) is untouched, its checkpoint draft keeps the target, no job comes back', async t => {
  const hold = gate();
  const first = await openLibrary(t, { model: authoring(hold, 2), hold });
  await first.service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
  await first.service.store.update(state => {
    state.decks.push({ id: 'target', title: 'Chapter 3', course: 'A', cards: [{ ...card('original'), review: SCHEDULE }], createdAt: '2026-09-29T00:00:00.000Z' });
    state.attempts.push({ id: 'history', deckId: 'target', quiz_id: 'original', grade: 4 });
  });
  const before = (await first.service.call('export')).decks[0];
  const started = await first.service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 2, kind: 'flashcard', performance: ONE_BY_ONE });
  assert.equal(started.completion, 'published-to-target');
  await soon(async () => (await first.service.call('export')).drafts[0]?.cards.length === 1, 'the first batch to be saved as a checkpoint draft');
  const after = await restartedOver(t, first.root);
  const state = await after.service.call('export');
  assert.deepEqual(state.decks[0], before, 'the target deck (ids, review schedule, requirements) is exactly as it was');
  assert.deepEqual(state.attempts, [{ id: 'history', deckId: 'target', quiz_id: 'original', grade: 4 }], 'learning history is untouched');
  assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].mergeTargetId, 'target', 'the checkpoint remembers the exact target: a later manual publish merges, it does not create a deck');
  assert.equal(state.drafts[0].editorial.generation.mergeTargetId, 'target');
  assert.deepEqual(await jobsOf(after.service), [], 'the job (type supplement) is not restored; its automatic publication is lost with it');
  assert.deepEqual(after.calls, []);
  await finish(first.service, hold, started.jobId);
});

test('draft.repair killed during the second card: the first card stays repaired and reviewed on disk, the rest stays rejected; no job comes back; repairing again does only what is left', async t => {
  const hold = gate(), source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
  const base = (id, n) => ({ ...card(id, 's', source.text), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });
  let repairs = 0;
  const model = (guard) => async (system, prompt) => {
    if (system.startsWith('Repair one draft card')) {
      if (guard && ++repairs === 2 && !hold.entered) { hold.entered = true; await hold.promise; }
      const input = JSON.parse(prompt);
      return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } });
    }
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  };
  const first = await openLibrary(t, { model: model(true), hold });
  await first.service.call('source.add', source);
  const saved = await first.service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [base('a', 1), base('b', 2)],
    editorial: { generation: { sourceIds: ['s'], kind: 'flashcard' }, rejectedIssues: { a: ['explanationQuality failed'], b: ['explanationQuality failed'] } } } });
  const started = await first.service.call('draft.repair', { id: 'd', draftVersion: saved.draftVersion });
  assert.equal(started.status, 'running');
  await soon(() => hold.entered, 'the second card to be held');
  const after = await restartedOver(t, first.root);
  const draft = (await after.service.call('export')).drafts[0];
  assert.match(draft.cards[0].explanation, /^Fixed:/, 'card a was repaired and saved the moment it passed its own review');
  assert.doesNotMatch(draft.cards[1].explanation, /^Fixed:/);
  assert.deepEqual(Object.keys(draft.editorial.rejectedIssues), ['b'], 'only the unconfirmed card is still rejected');
  assert.ok(draft.editorial.reviewedCards.a, 'the receipt of the repaired card is the durable commit');
  assert.deepEqual(await jobsOf(after.service), []);
  assert.deepEqual(after.calls, []);
  after.service.complete = model(false);
  const again = await after.service.call('draft.repair', { id: 'd', draftVersion: draft.draftVersion });
  assert.equal(again.status, 'running');
  assert.equal((await settleJob(after.service, again.jobId)).status, 'complete');
  assert.equal((await jobsOf(after.service)).find(job => job.id === again.jobId).count, 1, 'the new job repairs one card, not two');
  assert.deepEqual((await after.service.call('export')).drafts[0].editorial.rejectedIssues, {});
  await finish(first.service, hold, started.jobId);
});
