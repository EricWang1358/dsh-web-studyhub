/* S4-8 / S5: the daily recap may prefer a host sub-agent behind runtime.pilot.dailyRecapAgent, while retired workflow teaching and skeleton
   refuse at the door without starting any host sub-agent or direct model call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { until } from './helpers/wait.mjs';
import { writing, course, seeded, answer, noteOf, done, model as recapModel } from './helpers/recap-library.mjs';
import { library as workflowLibrary, model as workflowModel, teach } from './helpers/workflow-library.mjs';

function host({ replyFor, release = Promise.resolve(), parent = true } = {}) {
  const started = [], disposed = [];
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async (_kind, request) => {
    started.push(request);
    const id = `child-${started.length}`, text = replyFor(request.prompt.map(block => block.text).join('\n'));
    return { id, result: release.then(() => ({ stopReason: 'completed', output: [{ type: 'text', text }] })), dispose: async () => { disposed.push(id); } };
  } };
  return { started, disposed, ctx: { sessions: { get: () => undefined }, get: key => (key === 'agents' ? { get: () => (parent ? { id: 'parent' } : undefined) } : key === 'subagents' ? subagents : undefined) } };
}

const jobsOf = (service, type) => [...service.runtime.work.jobs.values()].filter(job => job.type === type);
const settledJob = (service, type) => until(() => jobsOf(service, type)[0]?.contract.finishedAt && jobsOf(service, type)[0], `the ${type} Job to settle`);
const recapOn = async (t, { pilotPaths = [], nativeHost, complete = recapModel().complete } = {}) => {
  const service = await seeded(t, { complete, pilotPaths, nativeHost }, 'runtime');
  await answer(service, 40);
  const started = await service.call('note.daily.generate', { course });
  return { service, started, ended: await done(service, started.id, started.jobId) };
};
const runners = job => job.contract.calls.map(call => call.runner);

test('with dailyRecapAgent off the recap asks the model directly, even when the host has a sub-agent to offer', async t => {
  const recapHost = host({ replyFor: () => writing }), fake = recapModel();
  const recap = await recapOn(t, { nativeHost: recapHost, complete: fake.complete });
  assert.equal(recap.ended.generation.status, 'done');
  assert.deepEqual([...new Set(runners(await settledJob(recap.service, 'daily-recap')))], ['direct']);
  assert.equal(recapHost.started.length, 0);
  assert.ok(fake.calls.length > 0);
});

test('the recap switch routes every recap call to the host sub-agent with its identity and releases each child', async t => {
  const recapHost = host({ replyFor: () => writing }), fake = recapModel();
  const recap = await recapOn(t, { pilotPaths: ['dailyRecapAgent'], nativeHost: recapHost, complete: fake.complete });
  assert.equal(recap.ended.generation.status, 'done');
  const { contract } = await settledJob(recap.service, 'daily-recap');
  assert.deepEqual(contract.calls.map(call => [call.stepKey, call.runner, call.executionMode, call.parentId]), [1, 2, 3].map(n => [`recap:${n}`, 'subagent', 'agent-preferred', 'parent']));
  assert.deepEqual(contract.calls.map(call => call.childId), ['child-1', 'child-2', 'child-3']);
  assert.equal(contract.execution.mode, 'subagent');
  assert.equal(fake.calls.length, 0);
  assert.ok(recapHost.started.every(request => request.toolFilter?.allow?.length === 0));
  assert.deepEqual(recapHost.disposed, ['child-1', 'child-2', 'child-3']);
  assert.equal((await noteOf(recap.service, recap.started.id)).generation.status, 'done');
});

test('retired workflow teaching and skeleton refuse before starting any sub-agent or runtime job', async t => {
  const workflowHost = host({ replyFor: () => writing }), lessons = workflowModel();
  const f = await workflowLibrary(t, { complete: lessons.complete, pilotPaths: ['workflowAgent'], nativeHost: workflowHost }, 1, 'runtime');
  await assert.rejects(() => teach(f.service.call.bind(f.service), f.session), { code: 'WORKFLOW_RETIRED' });
  await assert.rejects(() => f.service.call('workflow.skeleton.generate', { id: f.session.id }), { code: 'WORKFLOW_RETIRED' });
  assert.equal(workflowHost.started.length, 0);
  assert.equal(lessons.lessons.length, 0);
  assert.equal(jobsOf(f.service, 'workflow-teaching').length, 0);
  assert.equal(jobsOf(f.service, 'workflow-skeleton').length, 0);
});

test('a preferred sub-agent that is not there falls back to the direct call, and the Call says why', async t => {
  const none = host({ replyFor: () => writing, parent: false }), fake = recapModel();
  const recap = await recapOn(t, { pilotPaths: ['dailyRecapAgent'], nativeHost: none, complete: fake.complete });
  assert.equal(recap.ended.generation.status, 'done');
  const { contract } = await settledJob(recap.service, 'daily-recap');
  assert.deepEqual([...new Set(runners({ contract }))], ['direct']);
  assert.ok(contract.calls.every(call => call.fallbackReason === 'agent-unavailable' && call.executionMode === 'agent-preferred'));
  assert.deepEqual([none.started.length, fake.calls.length > 0], [0, true]);
});

test('stopping the Job stops its sub-agent: the child is released and the late answer is not written', async t => {
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
  assert.deepEqual(held.disposed, ['child-1']);
  assert.equal(held.started.length, 1);
  const note = await noteOf(service, started.id);
  assert.notEqual(note.generation.status, 'done');
  assert.ok(!note.content?.includes?.(writing));
});
