import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const original = { kind: 'flashcard', count: 7, language: 'English', difficulty: 'foundation', focus: 'Explain independent deployment',
  concurrency: 1, batchSize: 2, jobTimeoutMinutes: 5, fillRounds: 2, ...EFFORTS, notation: 'auto' };
const performance = ({ concurrency, batchSize, jobTimeoutMinutes, fillRounds = 2 }) => ({ concurrency, batchSize, jobTimeoutMinutes, fillRounds, ...EFFORTS });
const text = 'Microservices split a system into independently deployable services that own their data. ' +
  'Event-driven architecture lets services react to events published by others, which decouples producers from consumers. ' +
  'Relational databases give ACID transactions for payments and settlements. ';

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-generation-runtime-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const calls = [], active = new Map(), peak = new Map(), gates = [];
  const fake = createFakeModel({ latencyMs: 5, usage: true });
  let nextGate;
  const complete = async (system, prompt, context = {}) => {
    const jobId = context.jobId;
    calls.push({ jobId, system, prompt });
    active.set(jobId, (active.get(jobId) || 0) + 1);
    peak.set(jobId, Math.max(peak.get(jobId) || 0, active.get(jobId)));
    try {
      const gate = nextGate; nextGate = undefined;
      if (gate) { gate.enter(); await gate.wait; }
      return await fake(system, prompt, context);
    } finally { active.set(jobId, active.get(jobId) - 1); }
  };
  const service = new StudyService(root, { complete, coach: false, language: 'zh' });
  t.after(async () => {
    for (const gate of gates) gate.release();
    await service.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const source = await service.call('source.add', { title: 'Service architecture', text: text.repeat(3) });
  return { service, sourceIds: [source.id], calls, peak,
    pauseNext() {
      assert.equal(nextGate, undefined);
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
      nextGate = { enter, wait, release }; gates.push(nextGate);
      return { entered, release };
    } };
}
const wait = async (service, jobId) => {
  const job = await service.call('job.wait', { jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete', job.stage);
  return job;
};
const draftFor = async (service, job) => (await service.call('export')).drafts.find(draft => draft.id === job.draftId);
const checkJob = (job, expected, parts) => {
  assert.equal(job.kind, expected.kind);
  assert.equal(job.count, expected.count);
  assert.equal(job.parts, parts);
  assert.equal(job.concurrency, expected.concurrency);
  assert.equal(job.batchSize, expected.batchSize);
  assert.equal(job.totalTimeoutSeconds, expected.jobTimeoutMinutes * 60);
};
const checkContent = (draft, expected) => {
  for (const key of ['kind', 'language', 'difficulty', 'focus']) assert.equal(draft.editorial.generation[key], expected[key], key);
  assert.deepEqual(draft.editorial.generation.performance, performance(expected));
};

test('saved defaults drive queued content, batch sizes and concurrency even after settings change', async t => {
  const ctx = await library(t), { service, sourceIds } = ctx;
  await service.call('settings', { generation: original });
  const gate = ctx.pauseNext();
  const blocker = await service.call('generate', { sourceIds, count: 1, title: 'First job' });
  await gate.entered;
  const queued = await service.call('generate', { sourceIds, title: 'Uses saved defaults' });
  assert.equal(queued.status, 'queued');
  await service.call('settings', { generation: { kind: 'quiz', count: 30, language: '中文', difficulty: 'advanced', focus: 'A different focus',
    concurrency: 6, batchSize: 5, jobTimeoutMinutes: 60 } });
  gate.release(); await wait(service, blocker.jobId);
  const job = await wait(service, queued.jobId), draft = await draftFor(service, job);
  checkJob(job, original, 4); checkContent(draft, original);
  assert.equal(ctx.peak.get(job.id), 1, 'the model calls obey the saved concurrency budget');
  assert.equal(draft.cards.length, 7);
  assert.ok(draft.cards.every(card => card.kind === 'flashcard'));
  assert.deepEqual(draft.editorial.partReport.parts.map(part => part.asked), [2, 2, 2, 1]);
});

test('explicit content and performance override one job without rewriting saved defaults', async t => {
  const ctx = await library(t), { service, sourceIds } = ctx;
  await service.call('settings', { generation: original });
  const explicit = { kind: 'quiz', count: 5, language: '中文', difficulty: 'application', focus: 'Compare storage trade-offs',
    concurrency: 2, batchSize: 3, jobTimeoutMinutes: 6 };
  const started = await service.call('generate', { sourceIds, title: 'One-off choices', ...explicit, performance: performance(explicit) });
  const job = await wait(service, started.jobId), draft = await draftFor(service, job);
  checkJob(job, explicit, 2); checkContent(draft, explicit);
  assert.equal(ctx.peak.get(job.id), 2, 'two batches can work while respecting the one-off budget');
  assert.equal(draft.cards.length, 5);
  assert.ok(draft.cards.every(card => card.kind === 'quiz'));
  assert.deepEqual(draft.editorial.partReport.parts.map(part => part.asked), [3, 2]);
  assert.deepEqual((await service.call('snapshot')).settings.generation, original);
});

test('usage estimates follow the saved batch size and match the actual fake-model call counts', async t => {
  const ctx = await library(t), { service, sourceIds } = ctx;
  const results = [];
  for (const batchSize of [5, 1]) {
    await service.call('settings', { generation: { kind: 'quiz', count: 6, language: 'English', batchSize } });
    const before = ctx.calls.length;
    const estimate = await service.call('usage.estimate', { feature: 'generate', sourceIds });
    assert.equal(ctx.calls.length, before, 'estimating uses no model');
    const job = await wait(service, (await service.call('generate', { sourceIds, title: `Batch size ${batchSize}` })).jobId);
    const actualCalls = ctx.calls.filter(call => call.jobId === job.id).length;
    assert.equal(actualCalls, estimate.calls.low, 'the deterministic model needs no repair calls');
    assert.deepEqual(job.estimate.calls, estimate.calls);
    assert.equal(job.tokenUsage.calls, actualCalls);
    assert.equal(job.parts, Math.ceil(6 / batchSize));
    assert.equal((await draftFor(service, job)).cards.length, 6);
    results.push({ estimate: estimate.calls.low, actual: actualCalls });
  }
  assert.ok(results[1].estimate > results[0].estimate, 'smaller batches expose their extra model calls before starting');
  assert.ok(results[1].actual > results[0].actual);
});

test('queued continuation retains original content and performance; legacy drafts use 3/5/20', async t => {
  const ctx = await library(t), { service, sourceIds } = ctx;
  await service.call('settings', { generation: original });
  const initial = await wait(service, (await service.call('generate', { sourceIds, count: 2, title: 'Original draft' })).jobId);
  const draft = await draftFor(service, initial);
  const partial = await service.call('draft.save', { deck: { ...draft, editorial: { ...draft.editorial, requested: 8 } } });
  await service.call('settings', { generation: { kind: 'quiz', count: 30, language: '中文', difficulty: 'advanced', focus: 'Changed today',
    concurrency: 6, batchSize: 1, jobTimeoutMinutes: 60 } });
  const gate = ctx.pauseNext();
  const blocker = await service.call('generate', { sourceIds, count: 1, title: 'Blocks continuation' });
  await gate.entered;
  const estimate = await service.call('usage.estimate', { feature: 'generate', resumeDraftId: partial.id });
  const started = await service.call('generate', { resumeDraftId: partial.id, draftVersion: partial.draftVersion });
  assert.equal(started.status, 'queued');
  await service.call('settings', { generation: { concurrency: 2, batchSize: 5, jobTimeoutMinutes: 10 } });
  gate.release(); await wait(service, blocker.jobId);
  const job = await wait(service, started.jobId), completed = await draftFor(service, job);
  checkJob(job, { ...original, count: 6 }, 3); checkContent(completed, original);
  assert.equal(completed.id, partial.id); assert.equal(completed.cards.length, 8);
  assert.deepEqual(completed.cards.slice(0, draft.cards.length), draft.cards, 'approved cards survive continuation');
  assert.equal(ctx.peak.get(job.id), 1); assert.deepEqual(job.estimate.calls, estimate.calls);

  const legacyGeneration = { ...draft.editorial.generation }; delete legacyGeneration.performance;
  const legacy = await service.call('draft.save', { deck: { ...draft, id: 'legacy-generation', draftVersion: 0, cards: draft.cards.slice(0, 1),
    editorial: { ...draft.editorial, requested: 7, generated: 1, generation: legacyGeneration } } });
  await service.call('settings', { generation: { concurrency: 6, batchSize: 1, jobTimeoutMinutes: 60 } });
  const resumed = await wait(service, (await service.call('generate', { resumeDraftId: legacy.id, draftVersion: legacy.draftVersion })).jobId);
  const expected = { ...original, count: 6, concurrency: 3, batchSize: 5, jobTimeoutMinutes: 20 };
  const legacyCompleted = await draftFor(service, resumed);
  checkJob(resumed, expected, 2); checkContent(legacyCompleted, expected);
  assert.ok(ctx.peak.get(resumed.id) <= 3);

  const more = await service.call('draft.save', { deck: { ...legacyCompleted, editorial: { ...legacyCompleted.editorial, requested: 12 } } });
  const oneOff = { concurrency: 2, batchSize: 2, jobTimeoutMinutes: 7 };
  const oneOffEstimate = await service.call('usage.estimate', { feature: 'generate', resumeDraftId: more.id, performance: oneOff });
  const overridden = await wait(service, (await service.call('generate', { resumeDraftId: more.id, draftVersion: more.draftVersion,
    performance: oneOff })).jobId);
  const overriddenDraft = await draftFor(service, overridden);
  checkJob(overridden, { ...original, ...oneOff, count: 5 }, 3); checkContent(overriddenDraft, { ...original, ...oneOff });
  assert.equal(ctx.peak.get(overridden.id), 2);
  assert.equal(overriddenDraft.cards.length, 12);
  assert.deepEqual(overriddenDraft.cards.slice(0, legacyCompleted.cards.length), legacyCompleted.cards);
  assert.deepEqual(overridden.estimate.calls, oneOffEstimate.calls);
});

test('a case paper keeps its two-question shape instead of inheriting the ordinary card count', async t => {
  const ctx = await library(t), { service, sourceIds } = ctx;
  await service.call('settings', { generation: { count: 30, language: 'English', concurrency: 1, batchSize: 1, jobTimeoutMinutes: 5 } });
  const estimate = await service.call('usage.estimate', { feature: 'case', sourceIds });
  const started = await service.call('generate', { sourceIds, kind: 'case', title: 'Case defaults' });
  const job = await wait(service, started.jobId), draft = await draftFor(service, job);
  assert.equal(job.kind, 'case'); assert.equal(job.count, 2);
  assert.equal(job.parts, 1, 'a complete scenario remains one part even with batch size 1');
  assert.equal(job.batchSize, 2, 'the single case batch contains the whole two-question paper');
  assert.equal(job.concurrency, 1);
  assert.equal(ctx.peak.get(job.id), 1);
  assert.equal(draft.cards.length, 2); assert.equal(draft.format, 'case-study');
  assert.equal(draft.case.totalMarks, 20);
  assert.deepEqual(job.estimate.calls, estimate.calls);
  assert.equal(job.tokenUsage.calls, estimate.calls.low);
});

test('corrupt retained draft performance falls back safely while explicit overrides remain strict', async t => {
  const ctx = await library(t), { service, sourceIds } = ctx;
  const initial = await wait(service, (await service.call('generate', { sourceIds, count: 1, kind: 'flashcard' })).jobId);
  const draft = await draftFor(service, initial);
  const saved = await service.call('draft.save', { deck: { ...draft, editorial: { ...draft.editorial, requested: 2,
    generation: { ...draft.editorial.generation, performance: { concurrency: 99, batchSize: -1 } } } } });
  const resumed = await wait(service, (await service.call('generate', { resumeDraftId: saved.id, draftVersion: saved.draftVersion })).jobId);
  checkJob(resumed, { kind: 'flashcard', count: 1, concurrency: 3, batchSize: 5, jobTimeoutMinutes: 20 }, 1);
  assert.deepEqual((await draftFor(service, resumed)).editorial.generation.performance,
    { concurrency: 3, batchSize: 5, jobTimeoutMinutes: 20, fillRounds: 2, ...EFFORTS });
});

test('invalid one-off performance is rejected before jobs, drafts or model calls are created', async t => {
  const ctx = await library(t), { service, sourceIds } = ctx;
  const before = await service.call('export');
  const jobsBefore = (await service.call('snapshot')).jobs.map(job => job.id);
  for (const invalid of [null, [], { concurrency: 7 }, { batchSize: 0 }, { jobTimeoutMinutes: 4 }, { phaseTimeoutMinutes: 10 }]) {
    await assert.rejects(service.call('generate', { sourceIds, count: 2, performance: invalid }), /generation/i);
    await assert.rejects(service.call('usage.estimate', { feature: 'generate', sourceIds, performance: invalid }), /generation/i);
    assert.deepEqual((await service.call('snapshot')).jobs.map(job => job.id), jobsBefore);
    assert.deepEqual(await service.call('export'), before);
    assert.equal(ctx.calls.length, 0);
  }
});
