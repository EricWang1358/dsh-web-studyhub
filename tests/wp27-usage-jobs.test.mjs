import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { importExample } from '../ui/json-prompts.js';
import { jobTextModel } from '../lib/audio-job.js';
import { withUsageSink, reportUsage } from '../lib/usage-scope.js';

// WP27: a job knows what it used (per step and in all), the library keeps the
// per-feature tally, and neither a failing ledger nor a model that reports
// nothing can change what a job does. The fake model reports usage the way a
// provider does through modelCompletion.
const SENTENCE = 'Microservices split a system into independently deployable services that own their data. ';
const materials = [
  { title: 'Architectural styles', text: SENTENCE.repeat(6) + 'Event-driven architecture lets services react to events published by others, which decouples producers from consumers.' },
  { title: 'Cloud persistence', text: 'Polyglot persistence chooses a different data store for each workload. Relational databases give ACID transactions for payments and settlements. '.repeat(3) },
];
async function library(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-wp27-jobs-'));
  const service = new StudyService(root, { complete: createFakeModel({ usage: true }), ...options });
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const sourceIds = [];
  for (const item of materials) sourceIds.push((await service.call('source.add', { ...item, courses: ['Cloud Native'] })).id);
  return { service, sourceIds, root };
}
const wait = (service, jobId) => service.call('job.wait', { jobId, timeoutSeconds: 30 });
const sum = (items) => items.reduce((total, item) => ({ uncachedInputTokens: total.uncachedInputTokens + item.uncachedInputTokens,
  outputTokens: total.outputTokens + item.outputTokens, cacheReadTokens: total.cacheReadTokens + item.cacheReadTokens,
  cacheWriteTokens: total.cacheWriteTokens + item.cacheWriteTokens, calls: total.calls + item.calls }),
{ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 });

test('a generation job keeps the usage of every step and of the whole job', async (t) => {
  const { service, sourceIds } = await library(t);
  const started = await service.call('generate', { sourceIds, count: 6, kind: 'quiz', language: 'English', course: 'Cloud Native' });
  const job = await wait(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const steps = job.steps.filter((step) => step.tokenUsage);
  assert.ok(steps.length >= 3, 'plan, author and review each report');
  assert.deepEqual(job.tokenUsage, sum(steps.map((step) => step.tokenUsage)), 'the job is the sum of its steps');
  assert.equal(job.tokenUsage.calls, steps.length);
  assert.ok(job.tokenUsage.uncachedInputTokens > 0 && job.tokenUsage.outputTokens > 0);
  assert.ok(job.tokenUsage.cacheReadTokens > 0, 'the repeated system prompt is served from cache after the first call');
  assert.equal(job.usage, undefined, 'job.usage stays the audio quota tally');
  assert.doesNotMatch(JSON.stringify(job.tokenUsage), /price|cost|usd/i);
});

test('a job carries its estimate, and the run stays inside the estimated calls', async (t) => {
  const { service, sourceIds } = await library(t);
  const started = await service.call('generate', { sourceIds, count: 6, kind: 'quiz', language: 'English', course: 'Cloud Native' });
  const job = await wait(service, started.jobId);
  assert.ok(job.estimate, 'the estimate made at the start is kept for comparison');
  assert.ok(job.estimate.totalTokens.low > 0 && job.estimate.totalTokens.low <= job.estimate.totalTokens.high);
  assert.ok(job.tokenUsage.calls >= job.estimate.calls.low && job.tokenUsage.calls <= job.estimate.calls.high, `${job.tokenUsage.calls} calls vs ${JSON.stringify(job.estimate.calls)}`);
  assert.equal(job.estimate.stages, undefined, 'only the totals are kept on the job');
});

test('the ledger tallies the job under its feature and summarizes by day', async (t) => {
  const { service, sourceIds } = await library(t);
  const job = await wait(service, (await service.call('generate', { sourceIds, count: 5, kind: 'quiz', language: 'English', course: 'Cloud Native' })).jobId);
  const summary = await service.call('usage.summary', { days: 7 });
  assert.deepEqual(summary.byFeature.generate, job.tokenUsage);
  assert.deepEqual(summary.total, job.tokenUsage);
  assert.equal(summary.byFeature.case, undefined);
  assert.equal(summary.days, 7);
  assert.equal(summary.daily.length, 1);
  assert.equal(summary.audio, undefined, 'audio minutes live on the audio dashboard, not here');
  const month = await service.call('usage.summary', { days: 30 });
  assert.deepEqual(month.total, summary.total);
  const bad = await service.call('usage.summary', { days: 'soon' });
  assert.equal(bad.days, 30, 'an unusable window falls back to 30 days');
});

test('a case paper is tallied as a case, a light helper call as generation', async (t) => {
  const { service, sourceIds } = await library(t);
  const job = await wait(service, (await service.call('generate', { kind: 'case', sourceIds, questions: 2, totalMarks: 20, language: 'English', course: 'Cloud Native' })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok(job.tokenUsage.calls >= 2);
  const afterCase = await service.call('usage.summary', { days: 7 });
  assert.deepEqual(afterCase.byFeature.case, job.tokenUsage);
  await service.call('generate.suggest', { sourceIds, course: 'Cloud Native' });
  const afterSuggest = await service.call('usage.summary', { days: 7 });
  assert.ok(afterSuggest.byFeature.generate.calls >= 1, '帮我想想 is a question-writing helper');
  assert.deepEqual(afterSuggest.byFeature.case, job.tokenUsage, 'the case tally is untouched');
});

test('a coach helper call is tallied as coach, in the light model path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-wp27-coach-'));
  const service = new StudyService(root, { completeLight: async () => {
    reportUsage({ uncachedInputTokens: 700, outputTokens: 60, cacheReadTokens: 300, cacheWriteTokens: 0 }, { calls: 1 });
    return JSON.stringify({ questions: ['为什么成对？', '怎样处理失败？', '能举例吗？'] });
  } });
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const quote = '方法成对出现，前者失败抛异常，后者返回特殊值。';
  await service.call('source.add', { id: 's1', title: 'Queue', text: quote });
  await service.call('draft.save', { deck: { id: 'd1', title: 'Java', cards: [{ id: 'f1', kind: 'flashcard', topic: '队列', objective: '区分失败行为', prompt: 'add 和 offer 失败时有何不同？',
    answer: 'add 抛异常，offer 返回特殊值。', hint: '有两条失败路径。', explanation: quote, misconception: '以为都会抛异常。', citations: [{ sourceId: 's1', quote }] }] } });
  await service.call('draft.publish', { id: 'd1' });
  await service.call('card.followup.suggest', { deckId: 'd1', cardId: 'f1' });
  const summary = await service.call('usage.summary', { days: 7 });
  assert.deepEqual(summary.byFeature.coach, { uncachedInputTokens: 700, outputTokens: 60, cacheReadTokens: 300, cacheWriteTokens: 0, calls: 1 });
  assert.equal(summary.byFeature.generate, undefined);
});

test('publication review is tallied as review work and lands on the publish job', async (t) => {
  const { service } = await library(t);
  const data = JSON.parse(importExample('flashcard'));
  const draft = await service.call('draft.import', { text: JSON.stringify(data) });
  const started = await service.call('draft.publish.start', { id: draft.id, draftVersion: draft.draftVersion });
  const job = await wait(service, started.jobId);
  assert.ok(['complete', 'failed'].includes(job.status), job.stage);
  const summary = await service.call('usage.summary', { days: 7 });
  if (job.tokenUsage) assert.deepEqual(summary.byFeature.repair, job.tokenUsage);
  assert.equal(summary.byFeature.generate, undefined, 'review before publishing is not question writing');
});

test('usage that cannot be recorded never changes the job', async (t) => {
  const { service, sourceIds, root } = await library(t);
  // A directory where the ledger file belongs: every write fails.
  await mkdir(join(root, 'model-usage.json'));
  const job = await wait(service, (await service.call('generate', { sourceIds, count: 4, kind: 'quiz', language: 'English', course: 'Cloud Native' })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok(job.tokenUsage.calls >= 3, 'the job still knows what it used');
  const summary = await service.call('usage.summary', { days: 7 });
  assert.equal(summary.total.calls, 0, 'and the unreadable ledger reads as empty');
});

test('a model that reports no usage leaves the job without a tally and still finishing', async (t) => {
  const { service, sourceIds } = await library(t, { complete: createFakeModel() });
  const job = await wait(service, (await service.call('generate', { sourceIds, count: 4, kind: 'quiz', language: 'English', course: 'Cloud Native' })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(job.tokenUsage, undefined);
  assert.ok(job.estimate, 'the estimate does not depend on the model reporting');
});

test('usage.estimate answers without a model call', async (t) => {
  let calls = 0;
  const { service, sourceIds } = await library(t, { complete: async () => { calls++; return '{}'; } });
  const estimate = await service.call('usage.estimate', { feature: 'generate', sourceIds, count: 10, kind: 'mixed', language: 'English' });
  assert.equal(calls, 0);
  assert.equal(estimate.feature, 'generate');
  assert.ok(estimate.calls.low >= 3 && estimate.totalTokens.low > 0);
  assert.equal((await service.call('usage.estimate', { feature: 'generate', sourceIds: [], count: 10 })).calls.low, 0);
  await assert.rejects(service.call('usage.estimate', { feature: 'generate' }), /sourceIds/);
  const suggest = await service.call('usage.estimate', { feature: 'suggest', sourceIds, course: 'Cloud Native' });
  assert.equal(suggest.calls.low, 1);
  await assert.rejects(service.call('usage.estimate', { feature: 'teleport' }), /feature/);
  const audio = await service.call('usage.estimate', { feature: 'audio', minutes: 60, language: 'en' });
  assert.ok(audio.stages.some((stage) => stage.id === 'proofread'));
});

test('usage.estimate for a case grades what the learner typed', async (t) => {
  const { service, sourceIds } = await library(t);
  const job = await wait(service, (await service.call('generate', { kind: 'case', sourceIds, questions: 2, totalMarks: 20, language: 'English', course: 'Cloud Native' })).jobId);
  const state = await service.store.read();
  const draft = state.drafts.find((item) => item.id === job.draftId);
  const published = await service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion });
  const cardId = (await service.call('deck.get', { id: published.deckId })).cards[0].id;
  const short = await service.call('usage.estimate', { feature: 'grade', deckId: published.deckId, cardId, answerChars: 200 });
  const long = await service.call('usage.estimate', { feature: 'grade', deckId: published.deckId, cardId, answerChars: 6000 });
  assert.equal(short.calls.low, 1);
  assert.ok(long.inputTokens.low > short.inputTokens.low);
});

test('a host text job records its usage on the audio job without touching the quota tally', async () => {
  const job = { id: 'audio-job', language: 'en', status: 'running', steps: {} };
  const complete = async (_system, _prompt, options) => {
    reportUsage({ uncachedInputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, { calls: 1 });
    options.onEvent?.({ status: 'running' });
    return '{"corrections":[]}';
  };
  const { model } = jobTextModel(job, { textProvider: 'host', textModel: 'm', proofreadReasoning: 'default', translateReasoning: 'low' }, { complete, fetch: async () => { throw new Error('no network'); } });
  const reply = await withUsageSink({ key: 'outer', sink: () => {} }, () => model('system', 'prompt', { kind: 'proofread', stage: 'Proofread 1/1' }));
  assert.equal(reply, '{"corrections":[]}');
  assert.deepEqual(job.tokenUsage, { uncachedInputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 });
  assert.equal(job.usage, undefined);
});
