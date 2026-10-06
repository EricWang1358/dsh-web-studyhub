/* S4-6: the background units of 学习流 (a teaching of a step, the skeleton of a session) as Jobs of the unified runtime (runtime.pilot.workflow). The
   characterization suites (workflow-teaching, workflow-guide and the S4-0 baseline) run on both sides of the switch through their `.runtime.test.mjs` twins;
   this file holds what only the runtime path has. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { model, library, teach, finished, article, quote } from './helpers/workflow-library.mjs';

const runtimeLibrary = (t, options, sessions = 1) => library(t, options, sessions, 'runtime');
const jobsOf = (service, type) => [...service.runtime.work.jobs.values()].filter(job => job.type === type);
const settledJob = (service, type, index = 0) => until(() => jobsOf(service, type)[index]?.contract.finishedAt && jobsOf(service, type)[index], `the ${type} Job to settle`);
const skeleton = JSON.stringify({ title: '缓存的主线', overview: '先命中，再过期。', nodes: [{ id: 'hit', term: '缓存命中', meaning: '请求可以使用已保存的结果。', cards: ['card'] }], relations: [] });

test('a teaching is one Job: an author and a review Step, the session record unchanged, no Job for plain navigation', async t => {
  const fake = model();
  const withUsage = async (system, prompt) => { reportUsage({ uncachedInputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }); return fake.complete(system, prompt); };
  const { service, session } = await runtimeLibrary(t, { complete: withUsage });
  const call = service.call.bind(service);
  await call('workflow.session.get', { id: session.id });
  assert.equal(jobsOf(service, 'workflow-teaching').length, 0, 'reading a session is no background unit');
  const started = await teach(call, session);
  assert.equal(started.session.records.lesson.teaching.status, 'running');
  const done = await finished(call, session.id);
  assert.deepEqual([done.records.lesson.teaching.status, done.records.lesson.content], ['done', article]);
  const { contract } = await settledJob(service, 'workflow-teaching');
  assert.deepEqual([contract.status, contract.result.completeness, contract.runtime.attempts.length], ['complete', 'complete', 1]);
  assert.deepEqual(contract.calls.map(item => [item.stepKey, item.kind, item.feature]), [['author:1', 'author', 'flow'], ['review:1', 'review', 'flow']]);
  assert.equal(done.records.lesson.teaching.tokenUsage.outputTokens, 20, 'what the lesson used still rides on the step\'s record');
  const { byFeature } = await usageLedger(service.store.root).summary({ days: 1 });
  assert.deepEqual([Object.keys(byFeature), byFeature.flow.calls], [['flow'], 2], 'the gateway booked each call once');
  const moved = await call('workflow.session.advance', { id: session.id, version: done.version, outcome: 'skipped', requestId: 'move' });
  assert.equal(moved.currentStepId, 'recall');
  assert.equal(jobsOf(service, 'workflow-teaching').length, 1, 'moving between steps starts nothing');
});

test('cancelling a teaching stops the request, keeps the session and its saved material, and says so on the step', async t => {
  const fake = model(); fake.gates.set(0, gate());
  let received;
  const { service, session } = await runtimeLibrary(t, { complete: (...args) => { received = args[2]?.signal; return fake.complete(...args); } });
  const call = service.call.bind(service);
  await teach(call, session);
  await until(() => fake.lessons.length === 1, 'the lesson call');
  const [job] = jobsOf(service, 'workflow-teaching');
  await call('job.control', { jobId: job.contract.jobId, action: 'cancel' });
  await until(() => received?.aborted === true, 'the stop to reach the request');
  fake.gates.get(0).release();
  const after = await finished(call, session.id);
  assert.deepEqual([after.records.lesson.teaching.status, after.records.lesson.content], ['failed', undefined]);
  assert.match(after.records.lesson.teaching.message, /已取消/);
  assert.equal((await settledJob(service, 'workflow-teaching')).contract.status, 'cancelled');
  assert.equal((await call('workflow.session.get', { id: session.id })).session.id, session.id, 'the session is still there');
  assert.equal((await call('workflow.session.get', { id: session.id })).resources.teachingActive, false, 'the step can be taught again');
});

test('cancelling one teaching leaves the teachings of other sessions of the library running', async t => {
  const fake = model(); for (const n of [0, 1]) fake.gates.set(n, gate());
  const { service, sessions } = await runtimeLibrary(t, { complete: fake.complete }, 2);
  const call = service.call.bind(service);
  for (const session of sessions) await teach(call, session);
  await until(() => fake.lessons.length === 2, 'both lesson calls');
  await call('job.control', { jobId: jobsOf(service, 'workflow-teaching')[0].contract.jobId, action: 'cancel' });
  for (const n of [0, 1]) fake.gates.get(n).release();
  const results = await Promise.all(sessions.map(session => finished(call, session.id)));
  assert.deepEqual(results.map(row => row.records.lesson.teaching.status).sort(), ['done', 'failed']);
});

test('a skeleton is a Job whose result is the saved skeleton; cancelling it links nothing to the session', async t => {
  const { service, session } = await runtimeLibrary(t, { complete: async () => skeleton });
  await service.call('workflow.skeleton.generate', { id: session.id });
  const job = await settledJob(service, 'workflow-skeleton'), saved = (await service.store.read()).workflowSessions[0];
  assert.deepEqual([job.contract.status, job.contract.result.refs], ['complete', [{ kind: 'skeleton', id: saved.skeletonId }]]);
  assert.deepEqual(job.contract.calls.map(item => [item.stepKey, item.kind]), [['skeleton:1', 'plan']]);
  const held = gate(), other = await runtimeLibrary(t, { complete: async () => { await held.promise; return skeleton; } });
  await other.service.call('workflow.skeleton.generate', { id: other.session.id });
  await until(() => jobsOf(other.service, 'workflow-skeleton')[0], 'the skeleton Job');
  await other.service.call('job.control', { jobId: jobsOf(other.service, 'workflow-skeleton')[0].contract.jobId, action: 'cancel' });
  held.release();
  const row = await until(async () => { const s = (await other.service.store.read()).workflowSessions[0]; return s.skeletonJob.status !== 'running' && s; }, 'the skeleton record to end');
  assert.equal(row.skeletonJob.status, 'failed'); assert.ok(!row.skeletonId, 'nothing was linked');
  assert.match(row.skeletonJob.message, /已取消/);
});

test('a time limit is the Job\'s own: it stops the request and the step says it timed out', async t => {
  const setTimeoutOriginal = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => setTimeoutOriginal(callback, ms === 240000 ? 20 : ms, ...args));
  let received;
  const { service, session } = await runtimeLibrary(t, { complete: (_system, _prompt, options) => new Promise((_, reject) => {
    received = options.signal; options.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); }) });
  await teach(service.call.bind(service), session);
  const after = await finished(service.call.bind(service), session.id);
  assert.match(after.records.lesson.teaching.message, /超时/);
  assert.equal(received.aborted, true);
  assert.equal((await settledJob(service, 'workflow-teaching')).contract.detail.stopReason, 'execution-timeout');
});

test('with the switch on but no live executor a teaching fails on its step in plain words and asks the model nothing', async t => {
  const fake = model(), root = await privateRoot(t, 'workflow-runtime-none-');
  const service = new StudyService(root, { complete: fake.complete, runtimePilot: { workflow: true }, workOwner: Symbol('owner') });
  t.after(() => service.dispose());
  await service.store.update(state => {
    state.sources.push({ id: 'source', title: '缓存资料', text: `${quote}。` });
    state.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '问', answer: '答', explanation: quote, citations: [{ sourceId: 'source', quote }] }] });
  });
  const template = await service.call('workflow.save', { title: '讲解', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
  const session = await service.call('workflow.session.start', { templateId: template.id, topic: '缓存', scope: [{ deckId: 'deck' }], requestId: 's' });
  await teach(service.call.bind(service), session);
  const after = await finished(service.call.bind(service), session.id);
  assert.deepEqual([after.records.lesson.teaching.status, after.records.lesson.teaching.message], ['failed', '后台执行器暂时不可用，请稍后再试']);
  assert.equal(fake.lessons.length, 0);
});

test('with the switch off there is no Job at all', async t => {
  const fake = model(), { service, session } = await library(t, { complete: fake.complete }, 1, 'legacy');
  await teach(service.call.bind(service), session);
  await finished(service.call.bind(service), session.id);
  assert.equal(jobsOf(service, 'workflow-teaching').length, 0);
});
