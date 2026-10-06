import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { evidence, other, card, SCHEDULE, ONE_BY_ONE, authoring } from './helpers/supplement-fixtures.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon } from './helpers/generation-baseline.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { roundList } from '../lib/coverage-run.js';

/* S3-3: a generation run survives a restart (switch `generationRestart`). The runtime keeps the request and its own record of the job on disk; the draft stays the
   one checkpoint. After the restart the job is the same logical job, interrupted and visible, nothing is asked of a model by itself, and its retry is a new Attempt
   that continues the draft the old one left. The library folder at the moment of "death" is a consistent copy of the live one (tests/helpers/generation-baseline.mjs). */

const PATHS = ['generation', 'generationRestart'];
const hostOf = (complete, extra = {}) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: PATHS, ...extra }); return options; };
const retried = async (service, job) => (await service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId;
const draftsOf = async service => (await service.call('export')).drafts;
const contractOf = async (service, id) => (await jobsOf(service)).find(job => job.id === id).contract;

/** A library whose run is cut short at its `at`-th author call, with the runtime and its restart switch on. */
async function dying(t, at, { seed } = {}) {
  const hold = gate(), model = authoring(hold, at, 'first');
  const opened = await openLibrary(t, { model, hold, options: hostOf(model) });
  await opened.service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
  await opened.service.call('source.add', { id: 'p2', title: 'Page 2', text: other });
  if (seed) await seed(opened.service);
  return { ...opened, hold };
}

/** The new host after the restart: the same folder, the runtime on, a model that refuses until the test gives it one. */
async function restarted(t, root, extra) {
  const calls = []; let model = async system => { calls.push(String(system).slice(0, 40)); throw new Error('a restart must not call a model by itself'); };
  const complete = (...args) => model(...args);
  const after = await restartedOver(t, root, { options: hostOf(complete, extra), model: complete });
  return { ...after, calls, use(next) { model = next; } };
}
const askedAuthors = () => { const log = []; const inner = authoring({ entered: true }, Infinity, 'again'); return { log, model: async (system, prompt, context) => { if (system.startsWith('You author')) log.push(JSON.parse(prompt.split('REQUEST DATA:\n')[1]).count); return inner(system, prompt, context); } }; };

test('a run killed after its first part is the same job after the restart, interrupted and idle; its retry continues the same draft with only what is missing', async t => {
  const first = await dying(t, 2);
  const started = await first.service.call('generate', { sourceIds: ['p1'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(async () => (await draftsOf(first.service))[0]?.cards.length === 1, 'the first part to be saved');
  const before = (await draftsOf(first.service))[0], logical = (await contractOf(first.service, started.jobId)).jobId;
  const after = await restarted(t, first.root);
  const [job, ...rest] = await jobsOf(after.service);
  assert.equal(rest.length, 0);
  assert.deepEqual([job.contract.status, job.contract.kind, job.contract.jobId], ['interrupted', 'generation', logical], 'the same logical job, lost with the old process');
  assert.equal(job.contract.actions.retry.available, true);
  assert.deepEqual(after.calls, [], 'no model call happened by itself');
  const asked = askedAuthors(); after.use(asked.model);
  const attempt = await retried(after.service, job);
  const done = await settleJob(after.service, attempt);
  assert.equal(done.status, 'complete', done.stage);
  const drafts = await draftsOf(after.service);
  assert.equal(drafts.length, 1, 'no second draft');
  assert.equal(drafts[0].id, before.id);
  assert.deepEqual(drafts[0].cards.slice(0, 1).map(item => item.id), before.cards.map(item => item.id), 'what was approved stays in place');
  assert.deepEqual(drafts[0].editorial.generation.inputRef, before.editorial.generation.inputRef, 'what the first run was asked is kept, not overwritten by what was left to ask');
  assert.equal(drafts[0].cards.length, 3);
  assert.equal(asked.log.length, 2, 'only the two missing questions were written');
  const contract = await contractOf(after.service, attempt);
  assert.deepEqual([contract.jobId, contract.runtime.attempts.length], [logical, 2], 'a new Attempt of the same logical job');
  assert.deepEqual((await readdir(join(after.root, 'generation-runs'))).length, 1, 'one record of the run on disk');
});

test('a run killed before its first draft is saved is asked again as it was: one draft, no duplicate', async t => {
  const first = await dying(t, 1);
  const started = await first.service.call('generate', { sourceIds: ['p1'], count: 2, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(() => first.hold.entered, 'the first part to be at the model');
  assert.equal((await draftsOf(first.service)).length, 0);
  const after = await restarted(t, first.root);
  const [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  assert.equal(job.contract.jobId, (await contractOf(first.service, started.jobId)).jobId);
  const asked = askedAuthors(); after.use(asked.model);
  assert.equal((await settleJob(after.service, await retried(after.service, job))).status, 'complete');
  const drafts = await draftsOf(after.service);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].cards.length, 2);
});

test('an extraSourceIds top-up killed after its first batch continues the same draft from what it recorded, not from the current screen', async t => {
  const first = await dying(t, 2, { seed: service => service.call('draft.save', { deck: { id: 'draft-a', title: 'Chapter', course: 'A', cards: [card('seed', 'p1')],
    editorial: { requested: 1, generated: 1, parts: 1, completedParts: 1, failures: [], generation: { sourceIds: ['p1'], kind: 'flashcard', language: 'English', difficulty: 'advanced', notation: 'text', course: 'A',
      performance: ONE_BY_ONE } } } }) });
  const seeded = (await draftsOf(first.service))[0];
  const started = await first.service.call('generate', { resumeDraftId: seeded.id, draftVersion: seeded.draftVersion, extraSourceIds: ['p2'], count: 3 });
  await soon(async () => (await draftsOf(first.service))[0].cards.length === 2, 'the first added batch to be saved');
  const after = await restarted(t, first.root);
  const [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  const asked = askedAuthors(); after.use(asked.model);
  const finished = await settleJob(after.service, await retried(after.service, job));
  assert.equal(finished.status, 'complete', finished.stage);
  const [draft] = await draftsOf(after.service);
  assert.equal(draft.id, seeded.id);
  assert.deepEqual([draft.cards[0].id, draft.cards.length], ['seed', 4], 'the seed card stays; the top-up asked for 3 and got 3');
  assert.deepEqual(asked.log.length, 2, 'only what the top-up still lacked');
  assert.ok(draft.editorial.generation.sourceIds.includes('p2'));
  void started;
});

test('a target supplement killed after its first batch continues and publishes into the same deck: card ids and the learner\'s schedule are untouched', async t => {
  const first = await dying(t, 2, { seed: async service => service.store.update(state => {
    state.decks.push({ id: 'target', title: 'Chapter 3', course: 'A', cards: [{ ...card('original'), review: SCHEDULE }], createdAt: '2026-09-29T00:00:00.000Z' });
  }) });
  const before = (await first.service.call('export')).decks[0];
  const started = await first.service.call('supplement', { sourceIds: ['p1'], deckId: 'target', count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(async () => (await draftsOf(first.service))[0]?.cards.length === 1, 'the first batch to be saved as the checkpoint draft');
  const after = await restarted(t, first.root);
  const [job] = await jobsOf(after.service);
  assert.deepEqual([job.contract.status, job.contract.kind], ['interrupted', 'supplement']);
  assert.deepEqual((await after.service.call('export')).decks[0], before, 'nothing was published by the restart');
  after.use(askedAuthors().model);
  const done = await settleJob(after.service, await retried(after.service, job));
  assert.equal(done.status, 'complete', done.stage);
  const state = await after.service.call('export');
  assert.equal(state.decks.length, 1);
  assert.equal(state.decks[0].id, 'target');
  assert.deepEqual(state.decks[0].cards[0], before.cards[0], 'the original card, with its review schedule, is as it was');
  assert.equal(state.decks[0].cards.length, 4);
  assert.equal(state.drafts.length, 0, 'no leftover draft: the checkpoint was published into the target');
  void started;
});

test('a retry is refused, with a reason, when what the run was made from changed', async t => {
  const first = await dying(t, 2);
  await first.service.call('generate', { sourceIds: ['p1'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(async () => (await draftsOf(first.service))[0]?.cards.length === 1, 'the first part to be saved');
  const changes = [
    ['a source was rewritten', 'input-changed', service => service.store.update(state => { state.sources.find(source => source.id === 'p1').text = `${evidence} Revised.`; })],
    ['a source was deleted', 'input-unavailable', service => service.store.update(state => { state.sources = state.sources.filter(source => source.id !== 'p1'); })],
    ['a saved question was rewritten', 'checkpoint-invalid', async service => { const [draft] = await draftsOf(service); await service.call('draft.save', { deck: { ...draft, cards: draft.cards.map((item, at) => (at ? item : { ...item, prompt: 'A question the learner rewrote?' })) } }); }],
  ];
  for (const [reason, code, change] of changes) {
    const after = await restarted(t, first.root), [job] = await jobsOf(after.service);
    assert.equal(job.contract.status, 'interrupted', reason);
    await change(after.service);
    await assert.rejects(after.service.call('job.control', { jobId: job.id, action: 'retry' }), { code }, reason);
    assert.deepEqual(after.calls, [], `${reason}: no model call`);
    assert.equal((await contractOf(after.service, job.id)).runtime.attempts.length, 1, `${reason}: no new Attempt`);
  }
});

test('a retry is refused while the old executor may still be alive', async t => {
  const first = await dying(t, 2);
  await first.service.call('generate', { sourceIds: ['p1'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(async () => (await draftsOf(first.service))[0]?.cards.length === 1, 'the first part to be saved');
  const after = await restarted(t, first.root, { inspect: () => ({ state: 'alive' }) });
  const [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'running', 'an unconfirmed loss is not an interruption');
  assert.equal(job.contract.actions.retry.available, false);
  await assert.rejects(after.service.call('job.control', { jobId: job.id, action: 'retry' }), { code: 'executor-alive' });
});

test('a damaged record of a run is left alone: nothing is restored, nothing breaks', async t => {
  const first = await dying(t, 2);
  await first.service.call('generate', { sourceIds: ['p1'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(async () => (await draftsOf(first.service))[0]?.cards.length === 1, 'the first part to be saved');
  const after = await restarted(t, first.root);
  const directory = join(after.root, 'generation-runs'), [name] = await readdir(directory);
  await writeFile(join(directory, name), '{ not json', 'utf8');
  assert.deepEqual(await jobsOf(after.service), []);
  assert.equal((await draftsOf(after.service)).length, 1, 'the draft is still there for the learner to continue by hand');
});

test('two retries at once start one Attempt', async t => {
  const first = await dying(t, 2);
  await first.service.call('generate', { sourceIds: ['p1'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(async () => (await draftsOf(first.service))[0]?.cards.length === 1, 'the first part to be saved');
  const after = await restarted(t, first.root), asked = askedAuthors(); after.use(asked.model);
  const [job] = await jobsOf(after.service);
  const results = await Promise.allSettled([after.service.call('job.control', { jobId: job.id, action: 'retry' }), after.service.call('job.control', { jobId: job.id, action: 'retry' })]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const done = await settleJob(after.service, results.find(item => item.status === 'fulfilled').value.attemptId);
  assert.equal(done.status, 'complete');
  assert.equal(asked.log.length, 2, 'the missing two were written once');
  assert.equal((await draftsOf(after.service))[0].cards.length, 3);
});

// ---- a coverage run: the plan's rounds, one after another on the same draft ----

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const PLAN = 'Plan a source-grounded assessment';
const weighing = async (_system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
const roundsOf = draft => roundList(draft.editorial.coverageSpec).map(round => round.status);

test('a coverage run killed in round 2 is the same job after the restart; its retry runs the round that was in flight again, keeps round 1 and goes on', async t => {
  const hold = gate(), model = clusteringModel();
  let live = null;
  const complete = async (system, prompt, context = {}) => {
    if (!hold.entered && system.startsWith(PLAN) && live) {
      const spec = (await live.call('export')).drafts[0]?.editorial.coverageSpec;
      if (spec?.rounds[1]?.status === 'running') { hold.entered = true; await hold.promise; }
    }
    return model.complete(system, prompt, context);
  };
  const first = await openLibrary(t, { model: complete, hold, options: { coverage: { roundLimit: 8 }, completeLight: weighing, ...hostOf(complete) } });
  live = first.service;
  for (const source of world.sources) await first.service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const ids = world.sources.map(source => source.id);
  const started = await first.service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await soon(() => hold.entered, 'round 2 to be in flight');
  const mid = (await draftsOf(first.service))[0], logical = (await contractOf(first.service, started.jobId)).jobId;
  assert.deepEqual(roundsOf(mid), ['done', 'running', 'pending']);
  const calls = [], again = clusteringModel();
  let next = async system => { calls.push(system.slice(0, 30)); throw new Error('a restart must not call a model by itself'); };
  const after = await restartedOver(t, first.root, { options: { coverage: { roundLimit: 8 }, completeLight: weighing, ...hostOf((...args) => next(...args)) }, model: (...args) => next(...args) });
  const listed = (await jobsOf(after.service)).filter(job => job.contract.jobId === logical);
  assert.equal(listed.length, 1, 'one job for the run, not an interrupted one from the draft and another from the runtime');
  assert.equal(listed[0].contract.status, 'interrupted');
  assert.deepEqual(calls, []);
  next = again.complete;
  const done = await settleJob(after.service, await retried(after.service, listed[0]));
  assert.equal(done.status, 'complete', done.stage);
  const [draft] = await draftsOf(after.service);
  assert.deepEqual(roundsOf(draft), ['done', 'done', 'done']);
  assert.equal(draft.id, mid.id);
  assert.equal(draft.cards.length, draft.editorial.coverageSpec.goal, 'nothing doubled: round 1 kept, rounds 2 and 3 written once');
  assert.deepEqual(draft.cards.slice(0, mid.cards.length).map(item => item.id), mid.cards.map(item => item.id));
  const contract = (await jobsOf(after.service)).find(job => job.contract.jobId === logical).contract;
  assert.deepEqual([contract.status, contract.runtime.attempts.length], ['complete', 2]);
  hold.open();
});

// ---- without the restart switch: the runtime only, in this process ----

test('without the restart switch a cancelled run can still be retried in the process (continuing its draft), and nothing is kept on disk for a restart', async t => {
  const hold = gate(), first = authoring(hold, 2, 'run'), rest = authoring({ entered: true }, Infinity, 'again');
  let model = first;
  const complete = (...args) => model(...args);
  const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: ['generation'] });
  const opened = await openLibrary(t, { model: complete, hold, options });
  await opened.service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence });
  const started = await opened.service.call('generate', { sourceIds: ['p1'], count: 3, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(() => hold.entered, 'the second part to be at the model');
  await soon(async () => (await draftsOf(opened.service))[0]?.cards.length === 1, 'the first part to be saved');
  await opened.service.call('job.cancel', { jobId: started.jobId });
  hold.open();
  assert.equal((await settleJob(opened.service, started.jobId)).status, 'cancelled');
  const [job] = await jobsOf(opened.service), [saved] = await draftsOf(opened.service);
  assert.equal(job.contract.actions.retry.available, true, 'a cancelled run that kept a draft can be continued');
  model = rest.model ?? rest;
  const done = await settleJob(opened.service, await retried(opened.service, job));
  assert.equal(done.status, 'complete', done.stage);
  const [kept] = await draftsOf(opened.service);
  assert.deepEqual([kept.id, kept.cards.length, kept.cards[0].id], [saved.id, 3, saved.cards[0].id]);
  assert.equal((await readdir(opened.root)).includes('generation-runs'), false, 'not durable: nothing for a restart to find');
  const after = await restartedOver(t, opened.root, { options: hostOf(complete) });
  assert.deepEqual(await jobsOf(after.service), [], 'the restart switch is off: no job comes back');
});
