import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { card } from './helpers/supplement-fixtures.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* S3-5: the background repair of rejected cards (`draft.repair`) is a job of the unified runtime behind `runtime.pilot.generationRepair`: it waits in the library's one queue,
   every call it makes is a step of the gateway, and a stop never starts it. Behind `generationRestart` as well, the run is kept on disk: after a restart it is the same
   logical job, interrupted, and its retry repairs what is still rejected - the cards it repaired are saved (the draft is the checkpoint) and are not asked again. */

const RUNTIME = ['generation', 'generationRepair'], RESTART = ['generation', 'generationRepair', 'generationRestart'];
const hostOf = (complete, paths) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths }); return options; };
const source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
const base = (id, n) => ({ ...card(id, 's', source.text), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });

/** The model of a repair: it fixes a card by prefixing its explanation, logs every card it is asked for, and can hold the `at`-th repair call. */
function repairing({ hold, at } = {}) {
  const staged = stagedModel(), repairs = [];
  const complete = async (system, prompt, context = {}) => {
    if (!system.startsWith('Repair one draft card')) return staged.complete(system, prompt, context);
    const input = JSON.parse(prompt);
    repairs.push(input.card.id);
    if (hold && repairs.length === at && !hold.entered) { hold.entered = true; await hold.promise; }
    context.signal?.throwIfAborted();
    return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } });
  };
  return { complete, repairs, staged };
}

async function library(t, model, paths, hold) {
  const opened = await openLibrary(t, { prefix: 'study-s35-', model: model.complete, options: hostOf(model.complete, paths), hold });
  await opened.service.call('source.add', source);
  const saved = await opened.service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [base('a', 1), base('b', 2)],
    editorial: { generation: { sourceIds: ['s'], kind: 'flashcard' }, rejectedIssues: { a: ['explanationQuality failed'], b: ['explanationQuality failed'] } } } });
  return { ...opened, args: { id: 'd', draftVersion: saved.draftVersion } };
}
const draftOf = async service => (await service.call('export')).drafts.find(draft => draft.id === 'd');
const rowOf = async (service, jobId) => (await jobsOf(service)).find(job => job.id === jobId);

test('a repair on the runtime waits in the library queue behind a generation job, every call is a step of the gateway, and both cards are repaired', async t => {
  const hold = gate(), model = repairing(), blocker = stagedModel({ holdAt: 'plan', hold });
  const { service, args } = await library(t, { complete: (system, prompt, context) => (system.startsWith('Repair one') ? model : blocker).complete(system, prompt, context) }, RUNTIME, hold);
  const first = await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the generation job to be at the model');
  const started = await service.call('draft.repair', args);
  assert.deepEqual([started.status, started.queuedBehind], ['queued', 1]);
  const row = await rowOf(service, started.jobId);
  assert.deepEqual([row.contract.contractVersion, row.contract.kind, row.type], [2, 'draft-repair', 'draft-repair']);
  assert.deepEqual(model.repairs, [], 'nothing was asked while it waited');
  hold.open();
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(model.repairs, ['a', 'b']);
  const draft = await draftOf(service);
  assert.deepEqual(draft.cards.map(item => item.explanation.slice(0, 6)), ['Fixed:', 'Fixed:']);
  assert.deepEqual(draft.editorial.rejectedIssues, {});
  const calls = (await rowOf(service, started.jobId)).contract.calls;
  assert.ok(calls.length >= 4 && calls.every(call => call.observation.boundary === 'host-attempt'), 'two repair calls and two reviews, all through the gateway');
  assert.deepEqual([...new Set(calls.map(call => call.kind))].sort(), ['repair', 'review']);
  assert.equal(new Set(calls.map(call => call.stepKey)).size, calls.length, 'every call is its own unit: the cards are told apart by id');
});

test('a queued repair that is stopped never starts: no model call, the draft as it was', async t => {
  const hold = gate(), model = repairing(), blocker = stagedModel({ holdAt: 'plan', hold });
  const { service, args } = await library(t, { complete: (system, prompt, context) => (system.startsWith('Repair one') ? model : blocker).complete(system, prompt, context) }, RUNTIME, hold);
  await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the generation job to be at the model');
  const before = await draftOf(service), started = await service.call('draft.repair', args);
  await service.call('job.cancel', { jobId: started.jobId });
  hold.open();
  assert.equal((await settleJob(service, started.jobId)).status, 'cancelled');
  assert.deepEqual(model.repairs, []);
  assert.deepEqual(await draftOf(service), before);
});

test('a repair stopped between two cards can be tried again in the process: the repaired card is not asked again', async t => {
  const hold = gate(), model = repairing({ hold, at: 2 });
  const { service, args } = await library(t, model, RUNTIME, hold);
  const started = await service.call('draft.repair', args);
  await soon(() => hold.entered, 'the second card to be held');
  await service.call('job.cancel', { jobId: started.jobId });
  hold.open();
  assert.equal((await settleJob(service, started.jobId)).status, 'cancelled');
  assert.equal((await rowOf(service, started.jobId)).contract.actions.retry.available, true);
  const retried = await service.call('job.control', { jobId: started.jobId, action: 'retry' });
  const done = await settleJob(service, retried.attemptId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(model.repairs, ['a', 'b', 'b'], 'card a was repaired once; the retry only asks for b');
  assert.deepEqual((await draftOf(service)).editorial.rejectedIssues, {});
});

async function dying(t, paths) {
  const hold = gate(), model = repairing({ hold, at: 2 }), first = await library(t, model, paths, hold);
  const started = await first.service.call('draft.repair', first.args);
  await soon(() => hold.entered, 'the second card to be held');
  await soon(async () => !(await draftOf(first.service)).editorial.rejectedIssues.a, 'the first card to be saved');
  return { ...first, started, hold };
}
const afterRestart = async (t, root, paths) => {
  const calls = []; let model = async system => { calls.push(String(system).slice(0, 40)); throw new Error('a restart must not call a model by itself'); };
  const complete = (...args) => model(...args);
  const after = await restartedOver(t, root, { options: hostOf(complete, paths), model: complete });
  return { ...after, calls, use(next) { model = next; } };
};

test('restart: a repair cut short between two cards is the same job, interrupted and idle; its retry repairs only the card that is left', async t => {
  const first = await dying(t, RESTART), logical = (await rowOf(first.service, first.started.jobId)).contract.jobId;
  const after = await afterRestart(t, first.root, RESTART), [job, ...rest] = await jobsOf(after.service);
  assert.equal(rest.length, 0);
  assert.deepEqual([job.contract.status, job.contract.kind, job.contract.jobId], ['interrupted', 'draft-repair', logical]);
  assert.deepEqual(after.calls, [], 'nothing is asked by itself');
  const model = repairing(); after.use(model.complete);
  const done = await settleJob(after.service, (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(model.repairs, ['b'], 'card a is already repaired and saved: only b is asked for');
  const draft = await draftOf(after.service);
  assert.deepEqual(draft.cards.map(item => item.explanation), ['Fixed: Report types and rendering backends vary independently.', 'Fixed: Report types and rendering backends vary independently.'], 'a is not fixed twice');
  assert.deepEqual(draft.editorial.rejectedIssues, {});
  await first.hold.open();
});

test('restart: a draft the learner changed since the repair saved it is not repaired automatically', async t => {
  const first = await dying(t, RESTART), after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  const draft = await draftOf(after.service);
  await after.service.call('draft.save', { deck: { ...draft, cards: draft.cards.map(item => (item.id === 'a' ? { ...item, hint: 'Edited by hand.' } : item)) }, requireExisting: true });
  await assert.rejects(after.service.call('job.control', { jobId: job.id, action: 'retry' }), { code: 'checkpoint-invalid' });
  first.hold.open();
});

test('restart: a draft that is gone cannot be repaired again', async t => {
  const first = await dying(t, RESTART), after = await afterRestart(t, first.root, RESTART), [job] = await jobsOf(after.service);
  await after.service.call('draft.delete', { id: 'd' });
  await assert.rejects(after.service.call('job.control', { jobId: job.id, action: 'retry' }), { code: 'input-unavailable' });
  first.hold.open();
});

test('without the restart switch a repair is not kept on disk: after a restart nothing comes back, and repairing again does only what is left', async t => {
  const first = await dying(t, RUNTIME), after = await afterRestart(t, first.root, RUNTIME);
  assert.deepEqual(await jobsOf(after.service), []);
  const model = repairing(); after.use(model.complete);
  const draft = await draftOf(after.service), again = await after.service.call('draft.repair', { id: 'd', draftVersion: draft.draftVersion });
  assert.equal((await settleJob(after.service, again.jobId)).status, 'complete');
  assert.deepEqual(model.repairs, ['b']);
  first.hold.open();
});

test('a repair whose reviews fail leaves the draft with the cards still rejected, and the job is partial: nothing is claimed', async t => {
  const model = repairing(), failing = { complete: async (system, prompt, context) => {
    if (system.startsWith('Act as a strict')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate, ['The explanation does not follow from the evidence.']));
    return model.complete(system, prompt, context);
  } };
  const { service, args } = await library(t, failing, RUNTIME);
  const started = await service.call('draft.repair', args), done = await settleJob(service, started.jobId);
  assert.notEqual(done.status, 'cancelled');
  assert.deepEqual(Object.keys((await draftOf(service)).editorial.rejectedIssues).sort(), ['a', 'b']);
});
