/* S4-7: a request of the learner's assistant as a Job of the unified runtime (runtime.pilot.assist). The characterization suites (assist-host and the S4-0
   baseline) run on both sides of the switch through their `.runtime.test.mjs` twins; this file holds what only the runtime path has. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { createAssistService } from '../lib/assist.js';
import { createAssistChildren } from '../lib/assist-child.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { reply, library, nativeHost, request, ended } from './helpers/assist-library.mjs';

const jobsOf = service => [...service.runtime.work.jobs.values()].filter(job => job.type === 'assist');
const settledJob = (service, index = 0) => until(() => jobsOf(service)[index]?.contract.finishedAt && jobsOf(service)[index], 'the assist Job to settle');
async function setup(t, options = {}) {
  const f = await library(t, options, 'runtime'), assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  return { ...f, assist };
}

test('a direct request is one Job with a Step per model call; the task record the panel reads is unchanged and the usage is booked once', async t => {
  const f = await setup(t, { complete: async () => { reportUsage({ uncachedInputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }); return reply; } });
  const started = await f.assist.startAssist({}, request(f.service, f.root, { helpChoices: [] }));
  assert.deepEqual([started.runtime, started.status], ['direct', 'running']);
  await ended(f.assist, f.root);
  const [task] = f.assist.assistView(f.root).tasks, { contract } = await settledJob(f.service);
  assert.equal(task.status, 'done');
  assert.deepEqual([contract.kind, contract.status, contract.result.refs], ['assist', 'complete', [{ kind: 'card', id: 'c' }]]);
  assert.deepEqual(contract.calls.map(call => [call.stepKey, call.kind, call.feature, call.runner, call.tokens]), [['assist:1', 'other', 'coach', 'direct', 50]]);
  assert.equal(contract.detail.legacy.message, task.message, 'the Job and the task say the same');
  const { byFeature } = await usageLedger(f.root).summary({ days: 1 });
  assert.deepEqual([Object.keys(byFeature), byFeature.coach.calls], [['coach'], 1]);
});

test('a refused reply is repaired once as its own Step; nothing is saved twice', async t => {
  let calls = 0;
  const f = await setup(t, { complete: async () => (++calls === 1 ? '{"answer":' : reply) });
  await f.assist.startAssist({}, request(f.service, f.root, { helpChoices: [] }));
  await ended(f.assist, f.root);
  assert.equal(f.assist.assistView(f.root).tasks[0].status, 'done');
  const { contract } = await settledJob(f.service);
  assert.deepEqual(contract.calls.map(call => [call.stepKey, call.kind]), [['assist:1', 'other'], ['repair:1', 'repair']]);
  assert.equal((await f.service.store.read()).decks[0].cards[0].followups.length, 1);
});

test('a host teacher is observed as the host\'s own attempt of the same Job and Attempt, named by the child it really is', async t => {
  const f = await setup(t, { complete: async () => reply }), native = nativeHost();
  await f.assist.startAssist(native.ctx, request(f.service, f.root));
  await ended(f.assist, f.root);
  await f.assist.startAssist(native.ctx, request(f.service, f.root));
  await ended(f.assist, f.root);
  const [first, second] = [await settledJob(f.service, 0), await settledJob(f.service, 1)], attempt = job => job.contract.runtime.attempts.at(-1).attemptId;
  for (const job of [first, second]) {
    const [call] = job.contract.calls;
    assert.deepEqual([call.stepKey, call.runner, call.observation.boundary, call.jobId, call.attemptId], ['child:1', 'subagent', 'host-attempt', job.contract.jobId, attempt(job)]);
    assert.equal(job.contract.execution.mode, 'subagent');
  }
  assert.deepEqual([first, second].map(job => job.contract.calls[0].childId), f.assist.assistView(f.root).tasks.map(task => task.childId), 'the Call names the child the host service started and still owns');
});

test('stopping the library\'s assistant stops the Job and its real child, and the Job is not settled before the host has let the child go', async t => {
  const f = await setup(t, { complete: async () => reply }), held = gate(), disposing = gate();
  const native = nativeHost(reply, held.promise);
  const start = native.ctx.get('subagents').start;
  native.ctx.get = (original => key => (key === 'subagents' ? { ...original(key), start: async (...args) => { const run = await start(...args); const dispose = run.dispose; return { ...run, dispose: async () => { await disposing.promise; await dispose(); } }; } } : original(key)))(native.ctx.get);
  await f.assist.startAssist(native.ctx, request(f.service, f.root));
  await until(() => native.calls.started.length === 1, 'the child to be admitted');
  f.assist.clearAssist(f.root);
  await until(() => jobsOf(f.service)[0]?.contract.status === 'cancelling', 'the Job to be stopping');
  assert.equal(native.calls.started[0].signal.aborted, true, 'the stop reached the child request');
  assert.equal(jobsOf(f.service)[0].contract.finishedAt, undefined, 'cleanup of the child is not finished: the Job has not settled');
  disposing.release(); held.release();
  assert.equal((await settledJob(f.service)).contract.status, 'cancelled');
  assert.equal(native.calls.disposed.length, 1);
});

test('job.control cancel from the tools stops one request: its task ends with the same words, a sibling of the library goes on', async t => {
  const first = gate(), second = gate(); let seen = 0;
  const f = await setup(t, { complete: async (...args) => { const mine = seen++; await [first, second][mine].promise; return args.length ? reply : reply; } });
  await f.assist.startAssist({}, request(f.service, f.root, { text: 'One', helpChoices: [] }));
  await f.assist.startAssist({}, request(f.service, f.root, { text: 'Two', helpChoices: [] }));
  await until(() => seen === 2, 'both requests to reach the model');
  await f.service.call('job.control', { jobId: jobsOf(f.service)[0].contract.jobId, action: 'cancel' });
  await until(() => f.assist.assistView(f.root).tasks[0].status === 'failed', 'the stopped task to end');
  assert.match(f.assist.assistView(f.root).tasks[0].message, /后台助教已结束/);
  first.release(); second.release();
  await until(() => f.assist.assistView(f.root).tasks[1].status === 'done', 'the other task to finish');
  assert.equal((await settledJob(f.service, 0)).contract.status, 'cancelled');
});

test('with the switch on but no live executor the task fails in plain words and the model is never asked', async t => {
  let asked = 0;
  const root = await privateRoot(t, 'assist-runtime-none-'), complete = async () => { asked++; return reply; };
  const service = new StudyService(root, { complete, runtimePilot: { assist: true }, workOwner: Symbol('owner') });
  t.after(() => service.dispose());
  await service.store.update(state => {
    state.sources.push({ id: 's', title: 'Lecture', text: 'Bridge separates an abstraction from its implementation so the two can vary independently.' });
    state.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [{ id: 'c', kind: 'flashcard', topic: 'Bridge', prompt: 'What does Bridge separate?', answer: 'Two things.' }] });
  });
  const assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  await assist.startAssist({}, request(service, root, { card: { id: 'c', topic: 'Bridge', prompt: 'What does Bridge separate?' }, helpChoices: [] }));
  await ended(assist, root);
  assert.deepEqual([assist.assistView(root).tasks[0].status, assist.assistView(root).tasks[0].message], ['failed', '后台执行器暂时不可用，请稍后再试']);
  assert.equal(asked, 0);
});

test('with the switch off there is no Job at all', async t => {
  const f = await library(t, { complete: async () => reply }, 'legacy'), assist = createAssistService({ children: createAssistChildren() });
  t.after(() => assist.dispose());
  await assist.startAssist({}, request(f.service, f.root, { helpChoices: [] }));
  await ended(assist, f.root);
  assert.equal(jobsOf(f.service).length, 0);
});
