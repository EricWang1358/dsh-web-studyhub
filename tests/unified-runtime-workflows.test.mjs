/* S5: under unified runtime (runtime.pilot.workflow), reading historical workflow sessions creates no Jobs, and retired workflow teaching and
   skeleton actions refuse cleanly at the door without enqueuing runtime Jobs or calling the model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { model, library, teach, article, quote } from './helpers/workflow-library.mjs';

const runtimeLibrary = (t, options, sessions = 1) => library(t, options, sessions, 'runtime');
const jobsOf = (service, type) => [...service.runtime.work.jobs.values()].filter(job => job.type === type);

test('reading historical sessions starts no runtime Job, and retired teaching/skeleton mutations refuse before creating Jobs', async t => {
  const fake = model();
  const { service, session } = await runtimeLibrary(t, { complete: fake.complete });
  await service.store.update(state => {
    const live = state.workflowSessions.find(item => item.id === session.id);
    live.records.lesson = { content: article, citations: [{ sourceId: 'source', quote }], teaching: { status: 'done', mode: 'lesson' } };
  });
  const call = service.call.bind(service);
  const readBack = await call('workflow.session.get', { id: session.id });
  assert.equal(readBack.session.records.lesson.content, article);
  assert.equal(jobsOf(service, 'workflow-teaching').length, 0);
  await assert.rejects(() => teach(call, session), { code: 'WORKFLOW_RETIRED' });
  await assert.rejects(() => call('workflow.skeleton.generate', { id: session.id }), { code: 'WORKFLOW_RETIRED' });
  await assert.rejects(() => call('workflow.session.advance', { id: session.id, version: session.version, outcome: 'skipped', requestId: 'move' }), { code: 'WORKFLOW_RETIRED' });
  assert.equal(jobsOf(service, 'workflow-teaching').length, 0);
  assert.equal(jobsOf(service, 'workflow-skeleton').length, 0);
  assert.equal(fake.lessons.length, 0);
});
