import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { reportUsage } from '../lib/usage-scope.js';

// WP27: the lesson of a learning flow. The estimate comes from the lesson's own
// input and prompts; what the lesson used is kept on the step's teaching record.
const quote = '缓存命中要求请求可以使用已保存的结果，且结果没有过期。';
const article = '## 从一次请求开始\n\n' + '这是根据缓存复用条件构造的例子：先检查请求是否能使用保存的结果，再检查结果是否仍然有效。两项条件都满足时可以复用；否则回到原始服务取得结果。'.repeat(5) +
  '\n\n## 一步一步推演\n\n' + '假设有效期是六十秒，这是为说明机制而设定的演示条件。十秒后的相同请求可以按这个策略复用，七十秒后的请求则需要回源。检查每一步的条件，而不是看到缓存就直接返回。'.repeat(3) +
  '\n\n## 边界与易错点\n\n' + '有效期是业务选择的策略，并不能保证结果在所有场景里绝对最新。这里的例子是补充演示，资料本身仅给出复用和有效性的条件。'.repeat(3);
const generated = JSON.stringify({ markdown: article, citations: [{ sourceId: 'source', quote }] });
const approved = JSON.stringify({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] });
const usage = (uncachedInputTokens, outputTokens, cacheReadTokens = 0) => ({ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0 });

async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), 'study-wp27-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete });
  await service.store.update((s) => {
    s.sources.push({ id: 'source', title: '缓存资料', text: quote + '未命中时仍需访问原始服务。' });
    s.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '如何判断可复用？', answer: '检查请求和有效期', explanation: quote, citations: [{ sourceId: 'source', quote }] }] });
  });
  const template = await service.call('workflow.save', { title: '讲解与复述', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
  const session = await service.call('workflow.session.start', { templateId: template.id, topic: '缓存', scope: [{ deckId: 'deck' }], requestId: 'start' });
  return { service, session };
}
async function settled(service, id) {
  for (let n = 0; n < 200; n++) {
    const result = await service.call('workflow.session.get', { id });
    if (result.session.records.lesson?.teaching?.status !== 'running') return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Teaching did not settle');
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

test('the lesson keeps what it used on its teaching record and in the ledger', async (t) => {
  let called = 0;
  const { service, session } = await setup(t, async (_system, prompt) => {
    called++;
    const first = called === 1;
    reportUsage(first ? usage(900, 700, 0) : usage(950, 40, 400), { calls: 1 });
    void prompt;
    return first ? generated : approved;
  });
  await service.call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson' });
  const { session: done } = await settled(service, session.id);
  assert.equal(done.records.lesson.teaching.status, 'done');
  assert.deepEqual(done.records.lesson.teaching.tokenUsage, { ...usage(1850, 740, 400), calls: 2 });
  const summary = await service.call('usage.summary', { days: 7 });
  assert.deepEqual(summary.byFeature.flow, { ...usage(1850, 740, 400), calls: 2 });
});

test('a lesson with a model that reports nothing has no usage and works as before', async (t) => {
  let called = 0;
  const { service, session } = await setup(t, async () => (++called === 1 ? generated : approved));
  await service.call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson' });
  const { session: done } = await settled(service, session.id);
  assert.equal(done.records.lesson.teaching.status, 'done');
  assert.equal(done.records.lesson.teaching.tokenUsage, undefined);
});
