import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { card } from './helpers/supplement-fixtures.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* S3-6: the publication of a draft (`draft.publish.start`) is a job of the unified runtime behind `runtime.pilot.generationPublish`: its check asks its reviews through the
   gateway, and its one write is a commit of the runtime. Behind `generationRestart` as well, a publication that was cut short is looked at again, never done twice: the
   draft and the deck say whether the write happened (publish-reconcile.js). The "process died" is a copy of the library folder taken while the job is held at the point. */

const RUNTIME = ['generation', 'generationPublish'], RESTART = ['generation', 'generationPublish', 'generationRestart'];
const hostOf = (complete, paths) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths }); return options; };
const source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
const base = (id, n) => ({ ...card(id, 's', source.text), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });

async function library(t, model, paths, { hold, draft } = {}) {
  const opened = await openLibrary(t, { prefix: 'study-s36-', model: model.complete, options: hostOf(model.complete, paths), hold });
  await opened.service.call('source.add', source);
  await opened.service.store.update(state => { state.decks.push({ id: 't', title: 'Target', course: 'A', cards: [base('old', 0)], createdAt: '2026-09-29T00:00:00.000Z' }); });
  const saved = await opened.service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [base('a', 1), base('b', 2)], course: 'A', ...draft } });
  const notices = []; opened.service.notify = notice => notices.push(notice);
  return { ...opened, notices, args: { id: 'd', draftVersion: saved.draftVersion, mergeTargetId: 't' } };
}
const deckOf = async (service, id = 't') => (await service.call('export')).decks.find(deck => deck.id === id);
const draftsOf = async service => (await service.call('export')).drafts;
const rowOf = async (service, jobId) => (await jobsOf(service)).find(job => job.id === jobId);
const afterRestart = async (t, root, paths) => {
  const calls = []; let model = async system => { calls.push(String(system).slice(0, 40)); throw new Error('a restart must not call a model by itself'); };
  const complete = (...args) => model(...args);
  const after = await restartedOver(t, root, { options: hostOf(complete, paths), model: complete });
  const notices = []; after.service.notify = notice => notices.push(notice);
  return { ...after, calls, notices, use(next) { model = next; } };
};
const retry = async (service, job) => settleJob(service, (await service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);

/** The point at which the write is held: before it reaches the library, or after it did (and before the job hears of it). */
function holdWrite(service, { where, hold }) {
  const invoke = service.runtime.invoke.bind(service.runtime);
  service.runtime.invoke = async (api, action, args, services) => {
    const writing = api === 'authoring.v1' && action === 'draft.publish' && args.planned === true;
    if (writing && where === 'before') { hold.entered = true; await hold.promise; }
    const result = await invoke(api, action, args, services);
    if (writing && where === 'after') { hold.entered = true; await hold.promise; }
    return result;
  };
}

test('a publication on the runtime waits in the library queue, reviews through the gateway, writes once, and tells the session once', async t => {
  const hold = gate(), blocker = stagedModel({ holdAt: 'plan', hold });
  const { service, args, notices } = await library(t, blocker, RUNTIME, { hold });
  const first = await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the generation job to be at the model');
  const started = await service.call('draft.publish.start', args);
  assert.equal(started.status, 'queued');
  const row = await rowOf(service, started.jobId);
  assert.deepEqual([row.contract.contractVersion, row.contract.kind, row.type], [2, 'draft-publish', 'draft-publish']);
  hold.open();
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual((await deckOf(service)).cards.map(item => item.id), ['old', 'a', 'b']);
  assert.ok((await draftsOf(service)).every(draft => draft.id !== 'd'), 'the draft became the deck');
  const calls = (await rowOf(service, started.jobId)).contract.calls;
  assert.ok(calls.length >= 1 && calls.every(call => call.kind === 'review' && call.observation.boundary === 'host-attempt'), 'the reviews of the check went through the gateway');
  assert.equal(new Set(calls.map(call => call.stepKey)).size, calls.length);
  assert.equal(notices.filter(notice => /发布任务/.test(notice.text)).length, 1, 'one notice for the session');
});

/** A library whose publication is held at `where`, with the restart switch on; the process "dies" there. */
async function dying(t, where, { model = stagedModel(), draft } = {}) {
  const hold = gate(), first = await library(t, model, RESTART, { hold, draft });
  if (where === 'before' || where === 'after') holdWrite(first.service, { where, hold });
  const started = await first.service.call('draft.publish.start', first.args);
  await soon(() => hold.entered, `the publication to be held ${where} its write`);
  return { ...first, started, hold };
}

test('restart, cut short before the write: the same job, interrupted; its retry writes once and does not ask its reviews again', async t => {
  const first = await dying(t, 'before'), before = await deckOf(first.service);
  const logical = (await rowOf(first.service, first.started.jobId)).contract.jobId;
  const after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  assert.deepEqual([job.contract.status, job.contract.kind, job.contract.jobId], ['interrupted', 'draft-publish', logical]);
  assert.deepEqual(after.calls, []);
  assert.deepEqual((await deckOf(after.service)).cards, before.cards, 'nothing was written');
  const done = await retry(after.service, job);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(after.calls, [], 'the check was kept: nothing is asked again');
  assert.deepEqual((await deckOf(after.service)).cards.map(item => item.id), ['old', 'a', 'b']);
  assert.equal(after.notices.filter(notice => /发布任务/.test(notice.text)).length, 1);
  first.hold.open();
});

test('restart, cut short in the reviews: the retry asks them again and writes once', async t => {
  const hold = gate(), model = stagedModel({ holdAt: 'review', hold }), first = await library(t, model, RESTART, { hold });
  const started = await first.service.call('draft.publish.start', first.args);
  await soon(() => hold.entered, 'the first review to be held');
  const after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  const asked = stagedModel(); after.use(asked.complete);
  const done = await retry(after.service, job);
  assert.equal(done.status, 'complete', done.stage);
  assert.ok(asked.log.includes('review'), 'the reviews were still to do');
  assert.deepEqual((await deckOf(after.service)).cards.map(item => item.id), ['old', 'a', 'b']);
  hold.open();
  void started;
});

test('restart, the write happened and its receipt was lost: the retry finds it by looking, writes nothing, asks nothing, and the session hears of it once', async t => {
  const first = await dying(t, 'after');
  const written = await deckOf(first.service);
  assert.deepEqual(written.cards.map(item => item.id), ['old', 'a', 'b'], 'the library holds the publication');
  const after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  assert.deepEqual((await deckOf(after.service)).cards, written.cards);
  const done = await retry(after.service, job);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(after.calls, [], 'no model call');
  assert.deepEqual((await deckOf(after.service)).cards, written.cards, 'the deck is exactly as the write left it: nothing was written twice');
  assert.equal(done.recovered, true);
  assert.match(done.stage, /没有重复写入/, 'the console says it was found by looking');
  const row = await rowOf(after.service, job.id);
  assert.ok(row.contract.events.some(event => event.code === 'publish-recovered'), 'a domain event on the record, not a log line');
  assert.equal(after.notices.filter(notice => /发布任务/.test(notice.text)).length, 1, 'one notice, from the Attempt that settled');
  first.hold.open();
});

test('restart, the write happened to a part draft: the cards are fingerprinted as the write makes them (part stamp included), so it is not mistaken for a conflict', async t => {
  const first = await dying(t, 'after', { draft: { editorial: { part: { deckId: 't', n: 2 } } } });
  const written = await deckOf(first.service);
  assert.deepEqual(written.cards.filter(item => item.part === 2).map(item => item.id), ['a', 'b'], 'the write stamped the part; the draft has none');
  const after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  const done = await retry(after.service, job);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.recovered, true);
  assert.deepEqual((await deckOf(after.service)).cards, written.cards);
  first.hold.open();
});

test('restart, the draft was edited after the check and before the write: the retry is refused, in words that say what changed and what to do', async t => {
  const first = await dying(t, 'before'), after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  const [draft] = (await draftsOf(after.service)).filter(item => item.id === 'd');
  await after.service.call('draft.save', { deck: { ...draft, cards: draft.cards.map(item => (item.id === 'a' ? { ...item, hint: 'Edited by hand.' } : item)) }, requireExisting: true });
  await assert.rejects(after.service.call('job.control', { jobId: job.id, action: 'retry' }), { code: 'artifact-conflict', message: /草稿.*被改动或删除.*重新发布/ });
  assert.deepEqual((await deckOf(after.service)).cards.map(item => item.id), ['old'], 'nothing was written');
  first.hold.open();
});

test('restart, the deck was changed after the write: the retry is refused, in words that say what changed and what to do', async t => {
  const first = await dying(t, 'after'), after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  await after.service.store.update(state => { const deck = state.decks.find(item => item.id === 't'); deck.cards.find(item => item.id === 'a').answer = 'Changed by the learner.'; });
  const before = await deckOf(after.service);
  await assert.rejects(after.service.call('job.control', { jobId: job.id, action: 'retry' }), { code: 'artifact-conflict', message: /题组.*被改动.*重新发布/ });
  assert.deepEqual((await deckOf(after.service)).cards, before.cards, 'nothing was written');
  first.hold.open();
});

test('a card that does not pass its review stays in the draft, and the job says so; the write happens once', async t => {
  const model = { ...stagedModel(), complete: undefined };
  const staged = stagedModel();
  model.complete = async (system, prompt, context) => {
    if (!system.startsWith('Act as a strict')) return staged.complete(system, prompt, context);
    const review = qualityReview(JSON.parse(prompt).candidate);
    const failing = review.checks.find(check => check.cardId === 'b');
    if (failing) failing.sourceSupport = 'fail';
    return JSON.stringify(review);
  };
  const { service, args } = await library(t, model, RUNTIME);
  const done = await settleJob(service, (await service.call('draft.publish.start', args)).jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual((await deckOf(service)).cards.map(item => item.id), ['old', 'a']);
  assert.equal(done.rejected, 1);
  assert.ok(done.rejectedDraftId, 'the remainder is a draft of its own');
});
