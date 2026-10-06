/* S4-10: the AI draft of a note (note.generate) as a Job of the unified runtime (runtime.pilot.noteGenerate). The characterization suite (blog-notes) runs on both sides of the switch through
   its `.runtime.test.mjs` twin; this file holds what only the runtime path has. Fakes only: no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { writing } from './helpers/recap-library.mjs';

async function library(t, complete, mode = 'runtime') {
  const root = await privateRoot(t, 'runtime-note-generate-');
  const service = new StudyService(root, { complete, ...switchOptions(mode, { complete, paths: ['noteGenerate'] }) });
  t.after(() => service.dispose());
  await service.store.update(state => {
    state.decks.push({ id: 'deck', title: 'Course', cards: [{ id: 'card', topic: 'Capacity planning', prompt: 'Question', answer: 'Answer', explanation: 'Explanation', misconception: 'Misconception' }] });
  });
  const note = await service.call('note.create', { title: 'Capacity planning', cards: [{ deckId: 'deck', cardId: 'card' }] });
  return { service, note };
}
const noteJobs = service => [...service.runtime.work.jobs.values()].filter(job => job.type === 'note-generate');
const settled = (service, index = 0) => until(() => noteJobs(service)[index]?.contract.finishedAt && noteJobs(service)[index], 'the note Job to settle');
const finished = (service, id) => until(async () => { const note = await service.call('note.get', { id }); return note.generation?.status !== 'running' && note; }, 'the draft to end');

test('one draft is one Job: found whole the moment the call returns, a Call per model call, the note as its result, the usage booked once', async t => {
  const calls = [];
  const complete = async (system, prompt, options) => { calls.push({ system, data: JSON.parse(prompt), options }); reportUsage({ uncachedInputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }); return writing; };
  const { service, note } = await library(t, complete);
  const started = await service.call('note.generate', { id: note.id });
  assert.equal(started.status, 'running');
  // The Job is in the table, with its card, before anything else has had a turn: a second start or the console finds it at once.
  assert.deepEqual([noteJobs(service).length, noteJobs(service)[0]?.title], [1, '笔记草稿']);
  const ready = await finished(service, note.id);
  assert.equal(ready.generation.status, 'done');
  const { contract } = await settled(service);
  assert.deepEqual([contract.kind, contract.status, contract.result.completeness, contract.runtime.attempts.length], ['note-generate', 'complete', 'complete', 1]);
  assert.deepEqual(contract.result.refs, [{ kind: 'note', id: note.id }]);
  assert.deepEqual(contract.calls.map(call => [call.stepKey, call.kind, call.feature, call.executionMode]), [['note:1', 'other', 'other', 'direct']]);
  assert.deepEqual(calls.map(call => call.data.articleTitle), ['Capacity planning']);
  const { byFeature } = await usageLedger(service.store.root).summary({ days: 1 });
  assert.deepEqual([Object.keys(byFeature), byFeature.other.calls], [['other'], 1]);
  assert.deepEqual((await service.call('snapshot', {})).jobs.map(row => row.type), ['note-generate'], 'it is a row of the 任务 console now');
});

test('a second start while one is running finds the same Job: one Job, one model call', async t => {
  const held = gate(); let asked = 0;
  t.after(() => held.release());
  const { service, note } = await library(t, async () => { asked++; await held.promise; return writing; });
  await service.call('note.generate', { id: note.id });
  await until(() => asked === 1, 'the draft to reach the model');
  assert.equal((await service.call('note.generate', { id: note.id })).status, 'running');
  held.release();
  assert.equal((await finished(service, note.id)).generation.status, 'done');
  assert.deepEqual([noteJobs(service).length, asked], [1, 1]);
});

test('deleting the note stops the request and the Job; the model never writes late', async t => {
  const held = gate(); let options;
  t.after(() => held.release());
  const { service, note } = await library(t, async (_system, _prompt, given) => { options = given; await held.promise; return writing; });
  await service.call('note.generate', { id: note.id });
  await until(() => options, 'the draft to reach the model');
  await service.call('note.delete', { id: note.id });
  await until(() => noteJobs(service)[0]?.contract.status === 'cancelling', 'the Job to be stopping');
  assert.equal(options.signal.aborted, true, 'the stop reached the request');
  held.release();
  const job = await settled(service);
  assert.deepEqual([job.contract.status, job.contract.endReason], ['cancelled', 'user-cancel']);
  assert.deepEqual((await service.store.read()).notes, [], 'nothing was written back');
});

test('a draft whose model fails says so on the note and on the Job; a note saved meanwhile is never overwritten', async t => {
  const { service, note } = await library(t, async () => { throw new Error('provider down'); });
  await service.call('note.generate', { id: note.id });
  const failed = await finished(service, note.id);
  assert.deepEqual([failed.generation.status, failed.generation.message], ['failed', 'provider down']);
  const job = await settled(service);
  assert.deepEqual([job.contract.status, job.contract.error.message], ['failed', 'provider down']);
  const held = gate();
  t.after(() => held.release());
  const second = await library(t, async () => { await held.promise; return writing; });
  await second.service.call('note.generate', { id: second.note.id });
  await second.service.call('note.save', { id: second.note.id, markdown: 'My writing after the draft started' });
  held.release();
  await settled(second.service);
  const kept = await second.service.call('note.get', { id: second.note.id });
  assert.deepEqual([kept.markdown, kept.generation.status], ['My writing after the draft started', 'superseded']);
  assert.equal(noteJobs(second.service)[0].contract.result.completeness, 'partial', 'the Job did not write, and says so');
});

test('with no host to run it the learner is told on the note, in words, and nothing is left running', async t => {
  const root = await privateRoot(t, 'runtime-note-generate-none-');
  const service = new StudyService(root, { complete: async () => writing, runtimePilot: { noteGenerate: true }, workOwner: Symbol('owner') });
  t.after(() => service.dispose());
  await service.store.update(state => { state.decks.push({ id: 'deck', title: 'Course', cards: [{ id: 'card', prompt: 'Q', answer: 'A' }] }); });
  const note = await service.call('note.create', { title: 'No host', cards: [{ deckId: 'deck', cardId: 'card' }] });
  await service.call('note.generate', { id: note.id });
  const failed = await finished(service, note.id);
  assert.equal(failed.generation.status, 'failed');
  assert.match(failed.generation.message, /后台执行器暂时不可用/);
  assert.deepEqual(noteJobs(service), []);
});
