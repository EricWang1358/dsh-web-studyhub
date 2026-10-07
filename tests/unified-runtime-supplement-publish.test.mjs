import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { evidence, other, card, SCHEDULE, ONE_BY_ONE, authoring } from './helpers/supplement-fixtures.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon } from './helpers/generation-baseline.mjs';

/* S3-6b: the publication a supplement run does at its end (the write that puts the run's approved questions into the target deck) goes through the same plan, runtime commit
   and look-again as the publication of a draft (tests/unified-runtime-publish.test.mjs). A process that died after the write and before the job knew of it comes back as a job
   that finds its write done - not as a job that supplements the deck a second time. The "death" is a copy of the library folder taken while the job is held at that point. */

const RESTART = ['generation', 'generationPublish', 'generationRestart'];
const hostOf = (complete, paths) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths }); return options; };

async function dying(t, where) {
  const hold = gate(), model = authoring({ entered: true }, Infinity, 'new');
  const opened = await openLibrary(t, { prefix: 'study-s36b-', model, options: hostOf(model, RESTART), hold });
  await opened.service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
  await opened.service.call('source.add', { id: 'p2', title: 'Page 2', text: other });
  await opened.service.store.update(state => {
    state.decks.push({ id: 'target', title: 'Chapter 3', course: 'A', cards: [{ ...card('original'), review: SCHEDULE }], createdAt: '2026-09-29T00:00:00.000Z' });
  });
  const invoke = opened.service.runtime.invoke.bind(opened.service.runtime);
  opened.service.runtime.invoke = async (api, action, args, services) => {
    const writing = api === 'authoring.v1' && action === 'draft.publish' && args.mergeTargetId === 'target';
    if (writing && where === 'before') { hold.entered = true; await hold.promise; }
    const result = await invoke(api, action, args, services);
    if (writing && where === 'after') { hold.entered = true; await hold.promise; }
    return result;
  };
  const started = await opened.service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 2, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(() => hold.entered, `the supplement to be held ${where} its publication`);
  return { ...opened, hold, started };
}
const afterRestart = async (t, root) => {
  const calls = []; let model = async system => { calls.push(String(system).slice(0, 40)); throw new Error('a restart must not call a model by itself'); };
  const complete = (...args) => model(...args);
  const after = await restartedOver(t, root, { options: hostOf(complete, RESTART), model: complete });
  const notices = []; after.service.notify = notice => notices.push(notice);
  return { ...after, calls, notices, use(next) { model = next; } };
};
const targetOf = async service => (await service.call('export')).decks.find(deck => deck.id === 'target');
const noticesOf = notices => notices.filter(notice => /补题结果|supplement result/i.test(notice.text));

test('restart, the supplement\'s publication was written and its receipt lost: the retry finds the write done, supplements nothing a second time, asks no model, tells the session once', async t => {
  const first = await dying(t, 'after');
  const written = await targetOf(first.service);
  assert.equal(written.cards.length, 3, 'the original card and the two new ones are in the deck');
  const after = await afterRestart(t, first.root), [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  const retried = await after.service.call('job.control', { jobId: job.id, action: 'retry' });
  const done = await settleJob(after.service, retried.attemptId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(after.calls, [], 'no model call: nothing was written again');
  assert.deepEqual((await targetOf(after.service)).cards, written.cards, 'the deck is exactly as the write left it: the run supplemented it once');
  assert.equal(done.publication.added, 2);
  assert.equal(noticesOf(after.notices).length, 1, 'the session hears of the result once');
  first.hold.open();
});

test('restart, the supplement was cut short before its publication: the retry goes on from its draft and publishes once', async t => {
  const first = await dying(t, 'before');
  const before = await targetOf(first.service);
  const after = await afterRestart(t, first.root), [job] = await jobsOf(after.service);
  assert.deepEqual((await targetOf(after.service)).cards, before.cards, 'nothing was written');
  const asked = authoring({ entered: true }, Infinity, 'again'); after.use(asked);
  const done = await settleJob(after.service, (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal((await targetOf(after.service)).cards.length, 3, 'one supplement, not two');
  first.hold.open();
});

for (const mode of ['legacy', 'runtime']) test(`${mode}: supplement publishes into a deck with an active workflow`, async t => {
  const model = authoring({ entered: true }, Infinity, 'workflow');
  const { service } = await openLibrary(t, { prefix: 'study-pub-', model,
    options: mode === 'runtime' ? hostOf(model, ['generation', 'generationPublish']) : { runtimePilot: {} } });
  await service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
  await service.store.update(state => state.decks.push({ id: 'target', title: 'Chapter', cards: [card('original')] }));
  const template = await service.call('workflow.save', { title: 'Recall', steps: [{ id: 'recall', kind: 'recall', title: 'Recall' }] });
  const session = await service.call('workflow.session.start', { templateId: template.id, topic: 'Bridge', scope: [{ deckId: 'target' }], requestId: 'target' });
  const started = await service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 1, kind: 'flashcard', performance: ONE_BY_ONE });
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.error || done.stage);
  assert.equal(done.publication.added, 1);
  assert.equal((await targetOf(service)).cards.length, 2);
  const saved = (await service.call('workflow.session.get', { id: session.id })).session;
  assert.deepEqual(saved.scope, [{ deckId: 'target', cardId: 'original' }]);
  assert.equal(saved.version, session.version + 1);
});
