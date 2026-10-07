import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { card } from './helpers/supplement-fixtures.mjs';
import { openLibrary, stagedModel } from './helpers/generation-baseline.mjs';

/* The behaviour of the publication of a draft (`draft.publish.start`) that must be the same on both sides of its migration switch: this suite runs as it is on the legacy
   path and, through draft-publish.runtime.test.mjs, on the runtime (`generationPublish`). */

const source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
const base = (id, n) => ({ ...card(id, 's', source.text), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });

/** A model for the reviews of a publication; `failing` names the cards whose review does not pass. */
function reviewer(failing = []) {
  const staged = stagedModel();
  return { staged, complete: async (system, prompt, context) => {
    if (!system.startsWith('Act as a strict')) return staged.complete(system, prompt, context);
    const review = qualityReview(JSON.parse(prompt).candidate);
    for (const check of review.checks) if (failing.includes(check.cardId)) check.sourceSupport = 'fail';
    return JSON.stringify(review);
  } };
}
async function library(t, model) {
  const opened = await openLibrary(t, { prefix: 'study-s36-', model: model.complete });
  await opened.service.call('source.add', source);
  await opened.service.store.update(state => { state.decks.push({ id: 't', title: 'Target', course: 'A', cards: [base('old', 0)], createdAt: '2026-09-29T00:00:00.000Z' }); });
  const saved = await opened.service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [base('a', 1), base('b', 2)], course: 'A' } });
  const notices = []; opened.service.notify = notice => notices.push(notice);
  return { ...opened, notices, args: { id: 'd', draftVersion: saved.draftVersion, mergeTargetId: 't' } };
}
const stateOf = async service => service.call('export');
const noticesOf = notices => notices.filter(notice => /发布任务|publication task/.test(notice.text));

test('both cards pass their review and go into the target deck once; the draft is gone; the job reports what went in; the session is told once', async t => {
  const { service, args, notices } = await library(t, reviewer());
  const started = await service.call('draft.publish.start', args);
  assert.equal(started.draftId, 'd');
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const state = await stateOf(service);
  assert.deepEqual(state.decks.find(deck => deck.id === 't').cards.map(item => item.id), ['old', 'a', 'b']);
  assert.ok(!state.drafts.some(draft => draft.id === 'd'));
  assert.deepEqual([done.added, done.total, done.accepted, done.rejected, done.deckId], [2, 3, 2, 0, 't']);
  assert.equal(noticesOf(notices).length, 1);
});

test('a card that does not pass its review stays in a draft of its own, and the job says how many went in', async t => {
  const { service, args } = await library(t, reviewer(['b']));
  const done = await settleJob(service, (await service.call('draft.publish.start', args)).jobId);
  assert.equal(done.status, 'complete', done.stage);
  const state = await stateOf(service);
  assert.deepEqual(state.decks.find(deck => deck.id === 't').cards.map(item => item.id), ['old', 'a']);
  assert.deepEqual([done.accepted, done.rejected], [1, 1]);
  assert.ok(done.rejectedDraftId && state.drafts.some(draft => draft.id === done.rejectedDraftId));
});

test('a draft that changed since it was opened is refused before anything is queued, and one publication per draft at a time', async t => {
  const { service, args } = await library(t, reviewer());
  await assert.rejects(service.call('draft.publish.start', { ...args, draftVersion: args.draftVersion + 1 }), /草稿已更新/);
  const first = await service.call('draft.publish.start', args);
  await assert.rejects(service.call('draft.publish.start', args), /这份草稿已有后台任务|草稿已更新|not found|Draft/);
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
});
