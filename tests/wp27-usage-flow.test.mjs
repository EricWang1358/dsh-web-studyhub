import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { saveWorkflow, startSession } from '../lib/workflows.js';

// WP27 / S5: read-only lesson token estimate and historical tokenUsage on a retired learning-flow session.
const quote = '缓存命中要求请求可以使用已保存的结果，且结果没有过期。';
const usage = (uncachedInputTokens, outputTokens, cacheReadTokens = 0) => ({ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });

async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'study-wp27-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete });
  let session;
  await service.store.update((s) => {
    s.sources.push({ id: 'source', title: '缓存资料', text: quote + '未命中时仍需访问原始服务。' });
    s.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '如何判断可复用？', answer: '检查请求和有效期', explanation: quote, citations: [{ sourceId: 'source', quote }] }] });
    const template = saveWorkflow(s, { title: '讲解与复述', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
    session = startSession(s, { templateId: template.id, topic: '缓存', scope: [{ deckId: 'deck' }], requestId: 'start' });
  });
  return { service, session };
}

test('a lesson estimate is two calls built from the lesson input, and asks no model', async (t) => {
  let asked = 0;
  const { service, session } = await setup(t, async () => { asked++; return '{}'; });
  const estimate = await service.call('workflow.teaching.estimate', { id: session.id, stepId: 'lesson', mode: 'lesson' });
  assert.equal(asked, 0);
  assert.equal(estimate.feature, 'flow');
  assert.equal(estimate.calls.low, 2);
  assert.deepEqual([...new Set(estimate.stages.map((stage) => stage.id))].sort(), ['article', 'review']);
  assert.ok(estimate.inputTokens.low > 0 && estimate.outputTokens.low > 0);
  const remedy = await service.call('workflow.teaching.estimate', { id: session.id, stepId: 'lesson', mode: 'remedy' });
  assert.ok(remedy.outputTokens.high < estimate.outputTokens.high, 'a remedy is shorter than a lesson');
  await assert.rejects(service.call('workflow.teaching.estimate', { id: session.id, stepId: 'lesson', mode: 'nonsense' }), /讲解方式|mode/);
});

test('historical teaching tokenUsage remains readable while workflow.teaching.start refuses as retired', async (t) => {
  let called = 0;
  const { service, session } = await setup(t, async () => { called++; return '{}'; });
  await service.store.update((s) => {
    const live = s.workflowSessions.find((item) => item.id === session.id);
    live.records.lesson = {
      content: '历史讲解正文',
      teaching: { status: 'done', mode: 'lesson', tokenUsage: { ...usage(1850, 740, 400), calls: 2 } },
    };
  });
  await assert.rejects(() => service.call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson' }), { code: 'WORKFLOW_RETIRED' });
  assert.equal(called, 0);
  const { session: loaded } = await service.call('workflow.session.get', { id: session.id });
  assert.deepEqual(loaded.records.lesson.teaching.tokenUsage, { ...usage(1850, 740, 400), calls: 2 });
});
