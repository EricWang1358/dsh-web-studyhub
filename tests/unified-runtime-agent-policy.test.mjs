/* S4-8: the daily recap and the learning workflow may prefer a host sub-agent for their model calls, each behind its own default-off switch
   (runtime.pilot.dailyRecapAgent, runtime.pilot.workflowAgent), independent of the switches that run them as Jobs. The sub-agent is the host's (a fake parent session
   and sub-agent service here); the Calls say which runner answered, and an agent that is not there falls back to the direct call with the reason. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './helpers/wait.mjs';
import { writing, course, seeded, answer, noteOf, done, model as recapModel } from './helpers/recap-library.mjs';
import { library as workflowLibrary, model as workflowModel, teach, finished, article, approved, quote } from './helpers/workflow-library.mjs';

/** A host with a parent session and a sub-agent service; `replyFor(text)` is what the child answers to what it was given, once `release` resolves. */
function host({ replyFor, release = Promise.resolve(), parent = true } = {}) {
  const started = [], disposed = [];
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async (_kind, request) => {
    started.push(request);
    const id = `child-${started.length}`, text = replyFor(request.prompt.map(block => block.text).join('\n'));
    return { id, result: release.then(() => ({ stopReason: 'completed', output: [{ type: 'text', text }] })), dispose: async () => { disposed.push(id); } };
  } };
  return { started, disposed, ctx: { sessions: { get: () => undefined }, get: key => (key === 'agents' ? { get: () => (parent ? { id: 'parent' } : undefined) } : key === 'subagents' ? subagents : undefined) } };
}
const teachingReply = text => (text.includes('Independently') ? approved : JSON.stringify({ markdown: article, citations: [{ sourceId: 'source', quote }] }));

const jobsOf = (service, type) => [...service.runtime.work.jobs.values()].filter(job => job.type === type);
const settledJob = (service, type) => until(() => jobsOf(service, type)[0]?.contract.finishedAt && jobsOf(service, type)[0], `the ${type} Job to settle`);
const recapOn = async (t, { pilotPaths = [], nativeHost, complete = recapModel().complete } = {}) => {
  const service = await seeded(t, { complete, pilotPaths, nativeHost }, 'runtime');
  await answer(service, 40);
  const started = await service.call('note.daily.generate', { course });
  return { service, started, ended: await done(service, started.id, started.jobId) };
};
const teachingOn = async (t, { pilotPaths = [], nativeHost, complete = workflowModel().complete } = {}) => {
  const f = await workflowLibrary(t, { complete, pilotPaths, nativeHost }, 1, 'runtime'), call = f.service.call.bind(f.service);
  await teach(call, f.session);
  return { ...f, call, ended: await finished(call, f.session.id) };
};
const runners = job => job.contract.calls.map(call => call.runner);

test('with both policies off the recap and the teaching ask the model directly, even when the host has a sub-agent to offer', async t => {
  const recapHost = host({ replyFor: () => writing }), workflowHost = host({ replyFor: teachingReply }), fake = recapModel(), lessons = workflowModel();
  const recap = await recapOn(t, { nativeHost: recapHost, complete: fake.complete });
  assert.equal(recap.ended.generation.status, 'done');
  assert.deepEqual([...new Set(runners(await settledJob(recap.service, 'daily-recap')))], ['direct']);
  const teaching = await teachingOn(t, { nativeHost: workflowHost, complete: lessons.complete });
  assert.equal(teaching.ended.records.lesson.teaching.status, 'done');
  assert.deepEqual([...new Set(runners(await settledJob(teaching.service, 'workflow-teaching')))], ['direct']);
  assert.deepEqual([recapHost.started.length, workflowHost.started.length], [0, 0], 'no child was started');
  assert.ok(fake.calls.length > 0 && lessons.lessons.length > 0, 'the model path answered');
});

test('the recap switch alone: every recap call is the host sub-agent\'s, with its identity; a teaching in a library with only the other switch stays direct', async t => {
  const recapHost = host({ replyFor: () => writing }), fake = recapModel();
  const recap = await recapOn(t, { pilotPaths: ['dailyRecapAgent'], nativeHost: recapHost, complete: fake.complete });
  assert.equal(recap.ended.generation.status, 'done');
  const { contract } = await settledJob(recap.service, 'daily-recap');
  assert.deepEqual(contract.calls.map(call => [call.stepKey, call.runner, call.executionMode, call.parentId]), [1, 2, 3].map(n => [`recap:${n}`, 'subagent', 'agent-preferred', 'parent']));
  assert.deepEqual(contract.calls.map(call => call.childId), ['child-1', 'child-2', 'child-3']);
  assert.equal(contract.execution.mode, 'subagent');
  assert.equal(fake.calls.length, 0, 'the direct model was not asked');
  assert.ok(recapHost.started.every(request => request.toolFilter?.allow?.length === 0), 'a writing child is given no tools');
  assert.deepEqual(recapHost.disposed, ['child-1', 'child-2', 'child-3'], 'every child is released when its call ends');
  assert.equal((await noteOf(recap.service, recap.started.id)).generation.status, 'done');
  // The other family, with only ITS switch off (and the recap's on), is unchanged.
  const workflowHost = host({ replyFor: teachingReply }), teaching = await teachingOn(t, { pilotPaths: ['dailyRecapAgent'], nativeHost: workflowHost });
  assert.deepEqual([...new Set(runners(await settledJob(teaching.service, 'workflow-teaching')))], ['direct']);
  assert.equal(workflowHost.started.length, 0);
});

test('the workflow switch alone: the author and the review (and a skeleton) are the host sub-agent\'s; a recap in a library with only the other switch stays direct', async t => {
  const workflowHost = host({ replyFor: teachingReply });
  const teaching = await teachingOn(t, { pilotPaths: ['workflowAgent'], nativeHost: workflowHost });
  assert.deepEqual([teaching.ended.records.lesson.teaching.status, teaching.ended.records.lesson.content], ['done', article]);
  const { contract } = await settledJob(teaching.service, 'workflow-teaching');
  assert.deepEqual(contract.calls.map(call => [call.stepKey, call.kind, call.runner, call.executionMode]), [['author:1', 'author', 'subagent', 'agent-preferred'], ['review:1', 'review', 'subagent', 'agent-preferred']]);
  assert.ok(contract.calls.every(call => call.parentId === 'parent' && call.childId));
  const skeleton = JSON.stringify({ title: '缓存的主线', overview: '先命中，再过期。', nodes: [{ id: 'hit', term: '缓存命中', meaning: '请求可以使用已保存的结果。', cards: ['card'] }], relations: [] });
  const planner = host({ replyFor: () => skeleton }), planning = await workflowLibrary(t, { complete: workflowModel().complete, pilotPaths: ['workflowAgent'], nativeHost: planner }, 1, 'runtime');
  await planning.service.call('workflow.skeleton.generate', { id: planning.session.id });
  const plan = await settledJob(planning.service, 'workflow-skeleton');
  assert.deepEqual([plan.contract.status, plan.contract.calls.map(call => [call.stepKey, call.runner, call.childId])], ['complete', [['skeleton:1', 'subagent', 'child-1']]]);
  const recapHost = host({ replyFor: () => writing }), recap = await recapOn(t, { pilotPaths: ['workflowAgent'], nativeHost: recapHost });
  assert.deepEqual([...new Set(runners(await settledJob(recap.service, 'daily-recap')))], ['direct']);
  assert.equal(recapHost.started.length, 0);
});

test('a preferred sub-agent that is not there falls back to the direct call, and the Call says why', async t => {
  const none = host({ replyFor: () => writing, parent: false }), fake = recapModel();
  const recap = await recapOn(t, { pilotPaths: ['dailyRecapAgent'], nativeHost: none, complete: fake.complete });
  assert.equal(recap.ended.generation.status, 'done', 'the recap is still written');
  const { contract } = await settledJob(recap.service, 'daily-recap');
  assert.deepEqual([...new Set(runners({ contract }))], ['direct']);
  assert.ok(contract.calls.every(call => call.fallbackReason === 'agent-unavailable' && call.executionMode === 'agent-preferred'));
  assert.deepEqual([none.started.length, fake.calls.length > 0], [0, true]);
  // With no host at all (the model path of a panel with no session) the policy changes nothing either.
  const bare = await teachingOn(t, { pilotPaths: ['workflowAgent'] });
  assert.equal(bare.ended.records.lesson.teaching.status, 'done');
  assert.ok((await settledJob(bare.service, 'workflow-teaching')).contract.calls.every(call => call.runner === 'direct' && call.fallbackReason === 'agent-unavailable'));
});

test('stopping the Job stops its sub-agent: the child is released, the late answer is not written, and nothing of the other family moves', async t => {
  const release = Promise.withResolvers(), held = host({ replyFor: () => writing, release: release.promise });
  const service = await seeded(t, { complete: recapModel().complete, pilotPaths: ['dailyRecapAgent'], nativeHost: held }, 'runtime');
  await answer(service, 40);
  const started = await service.call('note.daily.generate', { course });
  await until(() => held.started.length >= 1, 'the child to be started');
  const [job] = jobsOf(service, 'daily-recap');
  await service.call('job.control', { jobId: job.contract.jobId, action: 'cancel' });
  assert.equal((await settledJob(service, 'daily-recap')).contract.status, 'cancelled');
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(held.disposed, ['child-1'], 'the one child that was running is released');
  assert.equal(held.started.length, 1, 'nothing was asked after the stop');
  const note = await noteOf(service, started.id);
  assert.notEqual(note.generation.status, 'done');
  assert.ok(!note.content?.includes?.(writing), 'the late answer of the child was not written');
});
