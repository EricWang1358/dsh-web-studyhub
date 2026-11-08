/* S5: learning-workflow model mutations (workflow.teaching.* and workflow.skeleton.generate) are retired across both legacy and runtime doors,
   while historical lesson records and estimates remain readable without starting background jobs or calling the model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SWITCH_MODE } from './helpers/runtime-switch.mjs';
import { panelDoor } from './helpers/model-family-baseline.mjs';
import { model, library, teach, article, quote } from './helpers/workflow-library.mjs';

test('historical teaching records remain readable while workflow.teaching.start and advance are refused', async t => {
  const fake = model();
  const { service, session } = await library(t, { complete: fake.complete });
  await service.store.update(state => {
    const live = state.workflowSessions.find(item => item.id === session.id);
    live.records.lesson = {
      content: article,
      citations: [{ sourceId: 'source', quote }],
      materialBy: 'ai',
      teaching: { mode: 'lesson', status: 'done', tokenUsage: { uncachedInputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 } },
    };
  });
  await assert.rejects(() => teach(service.call.bind(service), session), { code: 'WORKFLOW_RETIRED' });
  await assert.rejects(() => service.call('workflow.session.advance', { id: session.id, version: session.version, outcome: 'skipped', requestId: 'move' }), { code: 'WORKFLOW_RETIRED' });
  assert.equal(fake.lessons.length, 0);
  const loaded = (await service.call('workflow.session.get', { id: session.id })).session;
  assert.equal(loaded.records.lesson.content, article);
  assert.equal(loaded.records.lesson.teaching.status, 'done');
  assert.equal(loaded.records.lesson.teaching.tokenUsage.calls, 2);
});

test('both direct runtime calls and panelDoor refuse retired workflow teaching while read-only estimate works', async t => {
  const direct = model(), viaPanel = model();
  const a = await library(t, { complete: direct.complete }), b = await library(t);
  const panel = panelDoor(t, b.root, { complete: viaPanel.complete, ...(SWITCH_MODE === 'runtime' ? { pilot: { workflow: true } } : {}) });
  await assert.rejects(() => teach(a.service.call.bind(a.service), a.session), { code: 'WORKFLOW_RETIRED' });
  await assert.rejects(() => teach(panel, b.session), { code: 'STUDY_ERROR', message: /学习流已退役.*course\.method/ });
  assert.deepEqual([direct.lessons.length, viaPanel.lessons.length], [0, 0]);
  assert.deepEqual((await a.service.call('snapshot', {})).jobs, []);
  const estimate = await panel('workflow.teaching.estimate', { id: b.session.id, stepId: 'lesson', mode: 'lesson' });
  assert.equal(estimate.feature, 'flow');
  assert.equal(estimate.calls.low, 2);
});
