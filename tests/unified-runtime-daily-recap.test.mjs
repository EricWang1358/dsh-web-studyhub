/* S4-5: a generation of the daily recap as a Job of the unified runtime (runtime.pilot.dailyRecap). The characterization suites (daily-recap, -tone and the S4-0
   baseline) run on both sides of the switch through their `.runtime.test.mjs` twins; this file holds what only the runtime path has. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { createDailyRecapDefinition } from '../lib/contexts/notes/jobs/daily-recap.js';
import { until } from './helpers/wait.mjs';
import { gate } from './helpers/model-family-baseline.mjs';
import { writing, course, seeded, answer, noteOf, done, model } from './helpers/recap-library.mjs';

const library = (t, options, mode = 'runtime') => seeded(t, options, mode);
const recapJobs = service => [...service.runtime.work.jobs.values()].filter(job => job.type === 'daily-recap');
const settledJob = (service, index = 0) => until(() => recapJobs(service)[index]?.contract.finishedAt && recapJobs(service)[index], 'the recap Job to settle');
const letters = async service => (await service.call('inbox.raw')).filter(item => item.kind === 'note');

test('one generation is one Job: a Call per model call in the order it asks, the note as its result, the usage booked once per call', async t => {
  const usage = () => reportUsage({ uncachedInputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const service = await library(t, { complete: async () => { usage(); return writing; } });
  await answer(service, 40);
  const started = await service.call('note.daily.generate', { course });
  const note = await done(service, started.id, started.jobId);
  const job = await settledJob(service), { contract } = job;
  assert.deepEqual([contract.kind, contract.status, contract.result.completeness, contract.runtime.attempts.length], ['daily-recap', 'complete', 'complete', 1]);
  assert.deepEqual(contract.result.refs, [{ kind: 'note', id: started.id }]);
  assert.deepEqual(contract.calls.map(call => [call.stepKey, call.kind, call.feature, call.executionMode]), [1, 2, 3].map(n => [`recap:${n}`, 'other', 'other', 'direct']),
    'two batches of the day, then the one consolidation');
  assert.equal(job.generationId, started.jobId, 'the Job answers to the generation the note remembers');
  const { byFeature } = await usageLedger(service.store.root).summary({ days: 1 });
  assert.deepEqual([Object.keys(byFeature), byFeature.other.calls], [['other'], 3]);
  assert.deepEqual(Object.keys(note.generation).filter(key => /usage|token/i.test(key)), []);
  assert.deepEqual((await service.call('snapshot', {})).jobs.map(row => row.type), ['daily-recap'], 'it is a row of the 任务 console now');
});

test('cancelling stops the request and the Job; the note keeps what it had and the model never writes late', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const service = await library(t, { complete: fake.complete });
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  await until(() => fake.calls.length === 1, 'the generation to reach the model');
  await service.call('note.daily.cancel', { id: started.id });
  await until(() => recapJobs(service)[0]?.contract.status === 'cancelling', 'the Job to be stopping');
  assert.equal(fake.calls[0].options.signal.aborted, true, 'the stop reached the request');
  fake.gates.get(0).release();
  const job = await settledJob(service);
  assert.deepEqual([job.contract.status, job.contract.endReason], ['cancelled', 'user-cancel']);
  const after = await noteOf(service, started.id);
  assert.deepEqual([after.generation.status, after.markdown], ['cancelled', '']);
});

test('a second batch that fails keeps the first batch resumable, the Job says failed, and the next generation reuses the saved batch', async t => {
  const fake = model(); let failing = true;
  const service = await library(t, { complete: async (...args) => { if (failing && fake.calls.length === 1) { fake.calls.push({ system: '', data: {}, options: {} }); throw new Error('provider down'); } return fake.complete(...args); } });
  await answer(service, 40);
  const started = await service.call('note.daily.generate', { course });
  const failed = await done(service, started.id, started.jobId);
  assert.equal(failed.generation.status, 'failed');
  const job = await settledJob(service);
  assert.deepEqual([job.contract.status, job.contract.error.message], ['failed', 'provider down']);
  const saved = (await service.store.read()).notes[0];
  assert.deepEqual([saved.markdown, saved.daily.fragments.length], ['', 1], 'the first batch is kept, nothing half-written is published');
  failing = false;
  const again = await service.call('note.daily.generate', { course });
  assert.equal((await done(service, started.id, again.jobId)).generation.status, 'done');
  assert.equal(fake.calls.filter(call => call.data.stage === 'prepare').length, 2, 'the first batch (asked before the failure) was not asked again; only the second was');
});

test('a generation superseded by a course rename ends cancelled as a Job; the new generation owns the note and the late result writes nothing', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const service = await library(t, { complete: fake.complete });
  await answer(service, 10);
  const saved = await service.call('course.save', { name: '数学' });
  const started = await service.call('note.daily.generate', { course: saved.id });
  await until(() => fake.calls.length === 1, 'the first generation to reach the model');
  await service.call('course.rename', { id: saved.id, name: '高等数学' });
  await until(() => recapJobs(service)[0]?.contract.status === 'cancelling', 'the superseded Job to be stopping');
  assert.equal((await noteOf(service, started.id)).generation.status, 'superseded');
  const again = await service.call('note.daily.generate', { course: saved.id });
  const second = await done(service, started.id, again.jobId);
  fake.gates.get(0).release();
  assert.equal((await settledJob(service)).contract.status, 'cancelled');
  const after = await noteOf(service, started.id);
  assert.deepEqual([after.generation.id, after.generation.status, after.revision], [again.jobId, 'done', second.revision]);
  assert.equal(recapJobs(service).length, 2);
});

test('deleting the note stops its generation and nothing brings the note back', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const service = await library(t, { complete: fake.complete });
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  await until(() => fake.calls.length === 1, 'the generation to reach the model');
  await service.call('note.delete', { id: started.id });
  await until(() => recapJobs(service)[0]?.contract.status === 'cancelling', 'the Job to be stopping');
  fake.gates.get(0).release();
  assert.equal((await settledJob(service)).contract.status, 'cancelled');
  assert.equal((await service.call('note.list')).notes.length, 0);
});

test('the letter is sent when the Job settles, once, and only for the first content or a final recap', async t => {
  const service = await library(t, { complete: async () => writing });
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  await done(service, started.id, started.jobId);
  await until(async () => (await letters(service)).length === 1, 'the letter');
  assert.match((await letters(service))[0].detail, /今日学习总结已生成/);
  await answer(service, 3, 10);
  const again = await service.call('note.daily.generate', { course });
  await done(service, started.id, again.jobId); await settledJob(service, 1);
  assert.match((await letters(service))[0].detail, /已生成/, 'an update that is not final says nothing new');
  const last = await service.call('note.daily.generate', { course, final: true });
  await done(service, started.id, last.jobId); await settledJob(service, 2);
  await until(async () => /已整理/.test((await letters(service))[0]?.detail), 'the final letter (the inbox folds it into the open one)');
  assert.equal((await letters(service)).length, 1);
});

test('the letter sink sends only a letter the generation asked for', async () => {
  const sent = [], sink = createDailyRecapDefinition({ sendLetter: letter => { sent.push(letter); } }).notifications[0];
  await sink.deliver({ type: 'settled' }, { detail: { legacy: { letter: null } } });
  await sink.deliver({ type: 'settled' }, { detail: {} });
  await sink.deliver({ type: 'settled' }, { detail: { legacy: { letter: { kind: 'note', noteId: 'n' } } } });
  assert.deepEqual(sent, [{ kind: 'note', noteId: 'n' }]);
});

test('with the switch on but no live executor a generation fails on the note in plain words and asks the model nothing', async t => {
  const fake = model();
  const service = await library(t, { complete: fake.complete, runtimePilot: { dailyRecap: true }, workOwner: Symbol('owner') }, 'legacy');
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  const failed = await done(service, started.id, started.jobId);
  assert.deepEqual([failed.generation.status, failed.generation.message], ['failed', '后台执行器暂时不可用，请稍后再试']);
  assert.equal(fake.calls.length, 0);
});

test('with the switch off there is no Job at all', async t => {
  const service = await library(t, { complete: async () => writing }, 'legacy');
  await answer(service, 10);
  const started = await service.call('note.daily.generate', { course });
  await done(service, started.id, started.jobId);
  assert.equal(recapJobs(service).length, 0);
});
