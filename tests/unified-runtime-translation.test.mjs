/* S4-2: a page or chapter translation as a Job of the unified runtime (runtime.pilot.translation). The characterization suites (translation-jobs,
   job-control-translation and the S4-0 baseline) run on both sides of the switch through their `.runtime.test.mjs` twins; this file holds what only the
   runtime path has. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { until, settleJob } from './helpers/wait.mjs';
import { gate } from './helpers/model-family-baseline.mjs';
import { lines, model, library, row } from './helpers/translation-library.mjs';

const runtimeLibrary = (t, fake = model()) => library(t, fake, 'runtime');
const jobsOf = runtime => [...runtime.work.jobs.values()].filter(job => job.type === 'translation');
const contractOf = async (runtime, jobId) => (await row(runtime, jobId)).contract;

test('a translation is one Job in the library queue: a Step per batch, the paragraphs as its result, the usage booked once per call', async t => {
  const f = await runtimeLibrary(t), a = await f.one('Alpha');
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  assert.equal(started.job.type, 'translation');
  const ended = await settleJob(f.runtime, started.jobId);
  assert.equal(ended.status, 'complete');
  const contract = await contractOf(f.runtime, started.jobId);
  assert.deepEqual([contract.kind, contract.status, contract.result.completeness, contract.runtime.attempts.length], ['translation', 'complete', 'complete', 1]);
  assert.deepEqual(contract.result.refs, [{ kind: 'source', id: a.sourceId }]);
  assert.equal(contract.calls.length, f.fake.calls.length);
  assert.ok(contract.calls.every(call => call.kind === 'translate' && call.feature === 'other' && call.executionMode === 'agent-preferred'));
  assert.deepEqual(contract.capabilities.executionModes, ['direct', 'subagent']);
});

test('pausing leaves the library: the Job is paused at a wave boundary, another job runs meanwhile, and the resume asks only for what is left', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const f = await runtimeLibrary(t, fake), [a, b] = [await f.one('Alpha'), await f.one('Beta')];
  const first = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope, concurrency: 1 });
  await until(() => fake.calls.length === 1, 'the first wave to reach the model');
  await f.runtime.call('job.control', { jobId: first.jobId, action: 'pause' });
  assert.equal((await contractOf(f.runtime, first.jobId)).status, 'pausing');
  fake.gates.get(0).release();
  await until(async () => (await contractOf(f.runtime, first.jobId)).status === 'paused', 'the boundary');
  // The library is free while the first one waits to be resumed: a second job runs to its end.
  const second = await f.runtime.call('generation.translation.start', { documentId: b.documentId, scope: b.scope });
  assert.equal((await settleJob(f.runtime, second.jobId)).status, 'complete');
  const seen = fake.calls.length;
  await f.runtime.call('job.control', { jobId: first.jobId, action: 'resume' });
  const done = await settleJob(f.runtime, first.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual([done.done, done.total], [9, 9]);
  const resent = fake.calls.slice(seen).flatMap(call => call.passages.map(item => item.text)).filter(text => text.startsWith('Alpha'));
  assert.equal(resent.length, 9 - 6, 'only the paragraphs that had no translation yet were asked again: the first wave of six was kept');
  assert.equal((await contractOf(f.runtime, first.jobId)).runtime.attempts.length, 2);
  assert.equal((await f.items(a.documentId)).items.length, 9);
});

test('the time budget stops the request, nothing late is kept, and an observer that stops waiting does not stop the job', async t => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => original(callback, ms === 3600000 ? 25 : ms, ...args));
  const fake = model(); fake.gates.set(0, gate());
  const f = await runtimeLibrary(t, fake), a = await f.one('Alpha');
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  assert.notEqual((await f.runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 0 })).status, 'cancelled', 'a wait that runs out is not a stop');
  const ended = await settleJob(f.runtime, started.jobId);
  assert.equal(ended.status, 'failed');
  assert.equal(ended.outcome, 'budget');
  assert.equal(fake.signals[0].aborted, true, 'the request was stopped, not abandoned');
  const kept = (await f.items(a.documentId)).items.length;
  fake.gates.get(0).release();
  await until(() => jobsOf(f.runtime)[0]?.contract.finishedAt, 'the job to be over');
  assert.equal((await f.items(a.documentId)).items.length, kept, 'a late answer is not kept');
  assert.ok(kept < 9);
});

test('the glossary of the submission is what every wave asks with, for explicit passages too', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const f = await runtimeLibrary(t, fake), a = await f.one('Alpha');
  await f.runtime.call('materials.translation.glossary.set', { documentId: a.documentId, glossary: [{ term: 'architecture', to: '架构' }] });
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, passages: lines('Alpha').slice(0, 7).map(text => ({ sourceId: a.sourceId, text })), concurrency: 1 });
  await until(() => fake.calls.length === 1, 'the first wave');
  await f.runtime.call('materials.translation.glossary.set', { documentId: a.documentId, glossary: [{ term: 'consequence', to: '后果' }] });
  fake.gates.get(0).release();
  await settleJob(f.runtime, started.jobId);
  assert.ok(fake.calls.length >= 2);
  assert.ok(fake.calls.every(call => call.glossary?.every(entry => entry.term === 'architecture')), 'every wave used the glossary of the moment of the submission');
});

test('with the switch off there is no Job of the runtime: the card is the job table\'s own', async t => {
  const f = await library(t, model(), 'legacy'), a = await f.one('Alpha');
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  await settleJob(f.runtime, started.jobId);
  assert.equal((await contractOf(f.runtime, started.jobId)).runtime, undefined);
  assert.equal(jobsOf(f.runtime).length, 1);
});
