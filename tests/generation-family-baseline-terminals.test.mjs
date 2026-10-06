import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { jobContract } from '../lib/job-contract.js';
import { settleJob, until } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { sectionedModel } from './helpers/coverage-fixture.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { qualityReview } from './helpers/assessment.mjs';
import { gate, openLibrary, soon } from './helpers/generation-baseline.mjs';

/* S3-0 baseline, how a generation-family job ENDS as the public contract says it (lib/job-contract.js): complete, partial, failed, stopped by the learner, stopped by the owner unloading.
   The first three are distinct today. The last two are NOT: the unload of the generation plugin sets `cancelRequestedAt` like a click on stop does, so the contract says
   `endReason: user-cancel` for both and the executor's host-stopped branch (`interrupted`, operations.js) cannot be reached by an unload. Described as current behaviour (defect D-3, owner S3-3/S3-6). */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const ids = world.sources.map(source => source.id);
const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const PLAIN = { sourceIds: ids, kind: 'quiz', count: 6, performance: { concurrency: 1, batchSize: 4, jobTimeoutMinutes: 20, fillRounds: 0, ...EFFORTS } };
const summary = job => { const c = jobContract(job); return { job: job.status, status: c.status, endReason: c.endReason ?? null, completeness: c.result.completeness, error: c.error?.message ?? null, retry: c.actions.retry.available }; };

async function library(t, { model = sectionedModel(), wrap } = {}) {
  const hold = gate(), box = {};
  const complete = wrap ? wrap(model.complete, hold, box) : model.complete;
  const opened = await openLibrary(t, { model: complete, hold, options: { coverage: { roundLimit: 8 } } });
  box.service = opened.service;
  opened.service.light = async (_system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: 'r' })) });
  for (const source of world.sources) await opened.service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { ...opened, hold, work: opened.service.runtime.work };
}
const heldAtPlan = (complete, hold) => async (system, prompt, context = {}) => {
  if (system.startsWith('Plan a source-grounded assessment') && !hold.entered) { hold.entered = true; await hold.promise; }
  return complete(system, prompt, context);
};
const ended = (work, jobId) => until(() => { const job = work.jobs.get(jobId); return job && !['queued', 'running', 'cancelling'].includes(job.status) && job; }, `job ${jobId} to end`, { timeoutMs: 20_000 });

test('complete, partial and failed are three different contract outcomes', async t => {
  const full = await library(t);
  const done = await settleJob(full.service, (await full.service.call('generate', PLAIN)).jobId);
  assert.deepEqual(summary(full.work.jobs.get(done.id)), { job: 'complete', status: 'complete', endReason: null, completeness: 'complete', error: null, retry: false });
  // A second part whose review stays unreadable (no fill rounds) leaves a short draft (4 of 6): the job still ENDS complete, and says partial in its result.
  const short = await library(t, { model: sectionedModel({ failReview: (() => { let n = 0; return () => ++n >= 2; })() }) });
  const partial = await settleJob(short.service, (await short.service.call('generate', PLAIN)).jobId);
  assert.deepEqual(summary(short.work.jobs.get(partial.id)), { job: 'complete', status: 'complete', endReason: null, completeness: 'partial', error: null, retry: false },
    'a short draft is complete+partial and offers no 接着做 (retryable is only set on the failure path)');
  assert.ok((await short.service.call('export')).drafts[0].cards.length < 6);
  // Nothing usable at all: failed, with the reason as its error.
  const none = await library(t, { model: sectionedModel({ failReview: () => true }) });
  const failed = await settleJob(none.service, (await none.service.call('generate', PLAIN)).jobId);
  const result = summary(none.work.jobs.get(failed.id));
  assert.deepEqual([result.job, result.status, result.endReason, result.completeness], ['failed', 'failed', null, null]);
  assert.ok(result.error);
});

test('draft.repair: every card fixed is complete; some fixed is complete+partial (its status is "partial"); none fixed is failed', async t => {
  const source = { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
  const card = (id, n) => ({ id, kind: 'flashcard', topic: 'Architecture', objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?`, answer: 'Principles.', hint: 'Constraints.',
    explanation: 'The notes say principles guide design and change.', misconception: 'Only parts matter.', citations: [{ sourceId: 's', quote: source.text }] });
  const run = async (broken, count) => {
    const opened = await openLibrary(t, { model: async (system, prompt) => {
      if (!system.startsWith('Repair one draft card')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
      const input = JSON.parse(prompt);
      return JSON.stringify({ card: { ...input.card, ...(broken.includes(input.card.id) ? { id: 'changed' } : { explanation: `Fixed: ${input.card.explanation}` }) } });
    } });
    await opened.service.call('source.add', source);
    const cards = ['a', 'b'].slice(0, count).map((id, n) => card(id, n + 1));
    const saved = await opened.service.call('draft.save', { deck: { id: 'd', title: 'T', cards, editorial: { generation: { sourceIds: ['s'], kind: 'flashcard' }, rejectedIssues: Object.fromEntries(cards.map(item => [item.id, ['explanationQuality failed']])) } } });
    const started = await opened.service.call('draft.repair', { id: 'd', draftVersion: saved.draftVersion });
    await settleJob(opened.service, started.jobId);
    return summary(opened.service.runtime.work.jobs.get(started.jobId));
  };
  assert.deepEqual(await run([], 2), { job: 'complete', status: 'complete', endReason: null, completeness: 'complete', error: null, retry: false });
  assert.deepEqual(await run(['b'], 2), { job: 'partial', status: 'complete', endReason: null, completeness: 'partial', error: null, retry: false },
    'the legacy status "partial" is folded into complete + completeness, and nothing says which card is left except the draft');
  const none = await run(['a'], 1);
  assert.deepEqual([none.job, none.status, none.completeness, none.retry], ['failed', 'failed', null, false]);
});

test('learner stop and plugin unload end the same way for the contract (DEFECT D-3); only the prose differs, and a coverage run keeps its draft marker "running" only because the unloaded owner can no longer save', async t => {
  const stopped = await library(t, { wrap: (complete, hold) => heldAtPlan(complete, hold) });
  const first = await stopped.service.call('generate', PLAIN);
  await soon(() => stopped.hold.entered, 'the first call to be held');
  await stopped.service.call('job.cancel', { jobId: first.jobId });
  stopped.hold.open();
  const byLearner = await ended(stopped.work, first.jobId);
  const learner = { ...summary(byLearner), stage: byLearner.stage };

  const unloaded = await library(t, { wrap: (complete, hold) => heldAtPlan(complete, hold) });
  const second = await unloaded.service.call('generate', PLAIN);
  await soon(() => unloaded.hold.entered, 'the first call to be held');
  await unloaded.service.runtime.disposeContext('generation');
  unloaded.hold.open();
  const byOwner = await ended(unloaded.work, second.jobId);
  const owner = { ...summary(byOwner), stage: byOwner.stage };
  assert.deepEqual([learner.status, learner.endReason], ['cancelled', 'user-cancel']);
  assert.deepEqual([owner.status, owner.endReason], ['cancelled', 'user-cancel'], 'the contract cannot tell an unload from a click on stop');
  assert.ok(byLearner.cancelRequestedAt && byOwner.cancelRequestedAt, 'both set the same marker that makes the executor treat the stop as the learner\'s');
  assert.notEqual(learner.stage, owner.stage);
  assert.match(owner.stage, /plugin unloaded/);

  // A coverage run: after an unload the job says cancelled/user-cancel, the draft marker says running; the second is what a restart restores as interrupted (tests/coverage-run-exec.test.mjs).
  const run = await library(t, { model: clusteringModel(), wrap: (complete, hold, box) => async (system, prompt, context = {}) => {
    if (!hold.entered && system.startsWith('Plan a source-grounded assessment') && (await box.service.call('export')).drafts[0]?.editorial.coverageSpec?.rounds[1]?.status === 'running') { hold.entered = true; await hold.promise; }
    return complete(system, prompt, context);
  } });
  const covering = await run.service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await soon(() => run.hold.entered, 'round 2 to be in flight');
  await run.service.runtime.disposeContext('generation');
  run.hold.open();
  const job = await ended(run.work, covering.jobId);
  assert.deepEqual([summary(job).status, summary(job).endReason], ['cancelled', 'user-cancel']);
  assert.equal((await new Store(run.root).read()).drafts[0].editorial.coverageRun.state, 'running', 'the owner could not write its stop: the draft still says the run was in flight');
});
