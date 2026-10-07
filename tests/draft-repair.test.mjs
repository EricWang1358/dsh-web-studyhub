import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { card } from './helpers/supplement-fixtures.mjs';
import { gate, openLibrary, jobsOf, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* The behaviour of the background repair of rejected cards (`draft.repair`) that must be the same on both sides of its migration switch: this suite runs as it is on the
   legacy path and, through draft-repair.runtime.test.mjs, on the runtime (`generationRepair`). */

const source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
const base = (id, n) => ({ ...card(id, 's', source.text), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });

function repairing({ reviewIssues = [] } = {}) {
  const staged = stagedModel(), repairs = [];
  const complete = async (system, prompt, context = {}) => {
    if (system.startsWith('Repair one draft card')) {
      const input = JSON.parse(prompt);
      repairs.push(input.card.id);
      return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } });
    }
    if (system.startsWith('Act as a strict') && reviewIssues.length) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate, reviewIssues));
    return staged.complete(system, prompt, context);
  };
  return { complete, repairs, staged };
}
async function library(t, model, hold) {
  const opened = await openLibrary(t, { prefix: 'study-s35-', model: model.complete, hold });
  await opened.service.call('source.add', source);
  const saved = await opened.service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [base('a', 1), base('b', 2)],
    editorial: { generation: { sourceIds: ['s'], kind: 'flashcard' }, rejectedIssues: { a: ['explanationQuality failed'], b: ['explanationQuality failed'] } } } });
  return { ...opened, args: { id: 'd', draftVersion: saved.draftVersion } };
}
const draftOf = async service => (await service.call('export')).drafts.find(draft => draft.id === 'd');

test('both rejected cards are repaired in order, each saved once it passed its own review, and the job is complete', async t => {
  const model = repairing(), { service, args } = await library(t, model);
  const started = await service.call('draft.repair', args);
  assert.equal(started.draftId, 'd');
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(model.repairs, ['a', 'b']);
  const draft = await draftOf(service);
  assert.deepEqual(draft.cards.map(item => item.explanation.slice(0, 6)), ['Fixed:', 'Fixed:']);
  assert.deepEqual(draft.editorial.rejectedIssues, {});
  assert.ok(draft.editorial.reviewedCards.a && draft.editorial.reviewedCards.b);
  assert.equal((await jobsOf(service)).find(job => job.id === started.jobId).savedCount, 2);
});

test('a repair queued behind a generation job waits for it, and one that is stopped while it waits never asks a model', async t => {
  const hold = gate(), model = repairing(), blocker = stagedModel({ holdAt: 'plan', hold });
  const { service, args } = await library(t, { complete: (system, prompt, context) => (system.startsWith('Repair one') ? model : blocker).complete(system, prompt, context) }, hold);
  await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the generation job to be at the model');
  const before = await draftOf(service), started = await service.call('draft.repair', args);
  assert.deepEqual([started.status, started.queuedBehind], ['queued', 1]);
  await service.call('job.cancel', { jobId: started.jobId });
  hold.open();
  assert.equal((await settleJob(service, started.jobId)).status, 'cancelled');
  assert.deepEqual(model.repairs, []);
  assert.deepEqual(await draftOf(service), before);
});

test('a card whose repair does not pass the independent review stays rejected, with the reason, and is never reported as repaired', async t => {
  const model = repairing({ reviewIssues: ['The explanation does not follow from the evidence.'] }), { service, args } = await library(t, model);
  const done = await settleJob(service, (await service.call('draft.repair', args)).jobId);
  assert.notEqual(done.status, 'complete');
  const draft = await draftOf(service);
  assert.deepEqual(Object.keys(draft.editorial.rejectedIssues).sort(), ['a', 'b']);
  assert.doesNotMatch(draft.cards[0].explanation, /^Fixed:/);
});

test('one repair per draft: a second request while one is active is refused with the same words', async t => {
  const hold = gate(), blocker = stagedModel({ holdAt: 'plan', hold });
  const { service, args } = await library(t, { complete: (system, prompt, context) => (system.startsWith('Repair one') ? repairing() : blocker).complete(system, prompt, context) }, hold);
  await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the generation job to be at the model');
  const first = await service.call('draft.repair', args);
  await assert.rejects(service.call('draft.repair', args), /这份草稿已有后台任务/);
  await service.call('job.cancel', { jobId: first.jobId });
  hold.open();
});
