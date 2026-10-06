import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList } from '../lib/coverage-run.js';
import { shortfallOf } from '../lib/shortfall.js';
import { settleJob, until } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { sectionedModel } from './helpers/coverage-fixture.mjs';

/* A run that ended before it was done (the time limit, a refused key, the host) and kept a draft is CONTINUED, not started again: one action, 接着做, on the job's contract
   (`actions.retry` -> job.control retry), which starts a continuation of the SAME draft: every approved question stays, only what is missing is made, the settings are the run's own.
   A plain run (a count, no plan) continues the questions it was asked for and did not get (2 more of 15); a coverage run continues its rounds; 为没覆盖的部分补题 is the other,
   deliberate thing, and on a draft that has sections without a question it runs ROUNDS one after another (at most 30 questions each) until the coverage is full.
   The number of questions the draft was asked for is ONE number on the job, the contract and the shortfall (lib/shortfall.js). Fake models only. */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const PLAN = 'Plan a source-grounded assessment';
const refusal = () => Object.assign(new Error('401 Unauthorized: Invalid API key'), { status: 401 });
const TOTAL_MS = 20 * 60 * 1000;

async function library(t, { model = clusteringModel(), wrap, coverage = { roundLimit: 8 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-failed-continue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage });
  t.after(() => service.dispose());
  service.complete = wrap ? wrap(model.complete, service) : model.complete;
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, ids: world.sources.map(source => source.id), model };
}
const draftOf = async service => (await service.call('export')).drafts[0];
const jobOf = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId);

/** The 20-minute total limit of a plain run, made to strike after 200 ms (only that timer). */
function shortLimit(t) {
  const real = globalThis.setTimeout, limit = { on: true };
  globalThis.setTimeout = (fn, ms, ...rest) => real(fn, ms === TOTAL_MS && limit.on ? 200 : ms, ...rest);
  t.after(() => { globalThis.setTimeout = real; });
  return limit;
}
/** A model that writes the first batch of a plain run and then waits for ever for the second (until the run is aborted): the time limit stops it with 13 of 15 kept. */
const hangsAfterFirstBatch = (complete, service) => async (system, prompt, context = {}) => {
  if (/^Prepare supported/.test(system) && /^Part [2-9]\//.test(context.stage || '') && context.signal) await new Promise((_, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
  return complete(system, prompt, context);
};
const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const PLAIN = { kind: 'quiz', count: 6, performance: { concurrency: 1, batchSize: 4, jobTimeoutMinutes: 20, fillRounds: 0, ...EFFORTS } };

test('a plain run stopped by the time limit keeps its draft and offers 接着做 on its contract: the questions it was asked for and did not get', async (t) => {
  shortLimit(t);
  const { service, ids } = await library(t, { wrap: hangsAfterFirstBatch });
  const started = await service.call('generate', { sourceIds: ids, ...PLAIN });
  const ended = await settleJob(service, started.jobId);
  assert.equal(ended.status, 'failed', ended.stage);
  assert.match(ended.stage, /budget/i);
  const draft = await draftOf(service);
  assert.equal(draft.cards.length, 4, 'the first batch is kept');
  assert.equal(draft.editorial.requested, 6);
  const { contract } = await jobOf(service, started.jobId);
  assert.equal(contract.status, 'failed');
  assert.equal(contract.actions.retry.available, true, '接着做 is offered after a time limit that kept a draft');
  assert.deepEqual([contract.progress.done, contract.progress.total], [4, 6], 'the job and the draft say the same goal');
  assert.equal(contract.actions.pause.available, false, 'a plain run still has nothing to pause between');
});

/** Hangs the second batch while `state.hang` is on; the time limit (200 ms) ends the run. */
const hangWhile = state => (complete) => async (system, prompt, context = {}) => {
  if (state.hang && /^Prepare supported/.test(system) && /^Part [2-9]\//.test(context.stage || '') && context.signal) await new Promise((_, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
  return complete(system, prompt, context);
};

test('接着做 on a plain run continues the SAME draft: the 4 kept questions stay, 2 more are made with the run\'s own settings, and the failed record stays in the list as continued', async (t) => {
  const limit = shortLimit(t);
  const state = { hang: true };
  const { service, ids } = await library(t, { model: sectionedModel(), wrap: hangWhile(state) });
  const started = await service.call('generate', { sourceIds: ids, ...PLAIN });
  assert.equal((await settleJob(service, started.jobId)).status, 'failed');
  const before = await draftOf(service), keptIds = before.cards.map(card => card.id);
  state.hang = false;
  limit.on = false;
  const retried = await service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.ok(retried.jobId && retried.jobId !== started.jobId, 'a new job continues the draft');
  const next = await settleJob(service, retried.jobId);
  assert.equal(next.status, 'complete', next.stage);
  const after = await draftOf(service);
  assert.equal((await service.call('export')).drafts.length, 1, 'one draft: nothing was started again');
  assert.equal(after.id, before.id);
  assert.deepEqual(after.cards.slice(0, 4).map(card => card.id), keptIds, 'every approved question stays, in place');
  assert.ok(after.cards.length > 4 && after.cards.length <= 6, `only the missing ones were made (4 -> ${after.cards.length}; a duplicate of a kept question is skipped)`);
  assert.equal(after.editorial.requested, 6);
  assert.equal(after.editorial.generation.kind, 'quiz', 'the run\'s own settings');
  const newer = await jobOf(service, retried.jobId), older = await jobOf(service, started.jobId);
  assert.deepEqual([newer.contract.progress.done, newer.contract.progress.total], [after.cards.length, 6]);
  assert.equal(older.contract.status, 'failed', 'the failed record stays');
  assert.deepEqual([older.contract.progress.done, older.contract.progress.total], [4, 6], 'and keeps its own numbers');
  assert.equal(older.contract.actions.retry.available, false, 'its button is gone');
  assert.equal(older.contract.actions.retry.reason.code, 'continued', 'with the reason: it was continued');
  assert.equal(older.contract.continuedBy, retried.jobId, 'and a way to the task that continued it');
});

test('a run that finished with every question has nothing to continue: the reason is a code', async (t) => {
  const { service, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, ...PLAIN });
  await settleJob(service, started.jobId);
  const done = await jobOf(service, started.jobId);
  assert.equal(done.contract.status, 'complete');
  assert.equal(done.contract.actions.retry.available, false);
  assert.equal(done.contract.actions.retry.reason.code, 'not-retryable');
});

test('one goal: a top-up that ends without finishing says the same number of questions as the draft (not 13 kept + the questions of its round)', async (t) => {
  const limit = shortLimit(t); limit.on = false;
  const state = { hang: false, calls: 0 };
  const wrap = complete => async (system, prompt, context = {}) => {
    if (state.hang && /^Prepare supported/.test(system) && context.signal) await new Promise((_, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
    return complete(system, prompt, context);
  };
  const { service, ids } = await library(t, { wrap });
  const first = await service.call('generate', { sourceIds: ids, ...PLAIN });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = await draftOf(service);
  assert.equal(draft.cards.length, 6);
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.coverage.covered < view.coverage.leaves, 'a clustering planner leaves sections without a question');
  state.hang = true;
  const top = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: view.round.picks.map(pick => pick.key) } });
  // The 20-minute limit is not armed for a round of a run, so the run is stopped by the learner after it has started.
  await until(async () => (await jobOf(service, top.jobId)).status === 'running' && (await jobOf(service, top.jobId)).steps?.length > 0 || (await jobOf(service, top.jobId)).contract.calls.length > 0, 'the top-up to be at work');
  await service.call('job.cancel', { jobId: top.jobId });
  const ended = await settleJob(service, top.jobId);
  assert.ok(['cancelled', 'failed'].includes(ended.status), ended.status);
  const job = await jobOf(service, top.jobId), after = await draftOf(service);
  const found = shortfallOf({ draft: after, coverage: (await service.call('coverage.get', { draftId: after.id })).coverage });
  assert.equal(job.contract.progress.total, found.questionsGoal, `the console says ${job.contract.progress.total}, the banner ${found.questionsGoal}: one number`);
  assert.equal(job.contract.progress.done, found.questionsKept);
});

test('为没覆盖的部分补题 on a draft with sections without a question runs ROUNDS of at most the round limit, one after another, until every section has a question (the one executor of a coverage run)', async (t) => {
  const { service, ids } = await library(t);
  const first = await service.call('generate', { sourceIds: ids, ...PLAIN });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = await draftOf(service), before = await service.call('coverage.get', { draftId: draft.id });
  const open = before.coverage.leaves - before.coverage.covered;
  assert.ok(open > 8, `more sections without a question (${open}) than one round of 8 holds`);
  assert.equal(before.round.allQuestions, open, 'what it takes to reach every section: one question each');
  assert.equal(before.round.rounds, Math.ceil(open / 8), 'and in how many rounds');
  // No `autoComplete`: a plain draft has no earlier choice to respect, so the rounds go on by themselves.
  const top = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: {} });
  assert.equal(top.autoComplete, true, 'automatic completion is ON by default for this top-up');
  assert.equal(top.plan.rounds, before.round.rounds, 'the plan says how many rounds it takes');
  const job = await settleJob(service, top.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const after = await draftOf(service), spec = after.editorial.coverageSpec, view = await service.call('coverage.get', { draftId: after.id });
  assert.equal(spec.topup, true);
  assert.equal(spec.rounds.length, before.round.rounds);
  assert.ok(roundList(spec).every(round => round.status === 'done'), JSON.stringify(roundList(spec).map(round => round.status)));
  assert.ok(roundList(spec).every(round => round.questions <= 8), 'no round makes more than the round limit');
  assert.equal(view.coverage.covered, view.coverage.leaves, 'the coverage is full');
  assert.equal(after.editorial.coverageRun.stop.reason, 'complete');
  assert.equal(after.editorial.requested, 6, 'what the draft was asked for does not move');
  const { contract } = await jobOf(service, top.jobId);
  assert.ok(contract.detail.run.total >= 2, 'the console sees rounds');
  const found = shortfallOf({ draft: after, coverage: view.coverage, round: view.round });
  assert.deepEqual([contract.progress.done, contract.progress.total, contract.progress.percent], [found.questionsKept, found.questionsGoal, found.percent], 'one number everywhere');
  assert.equal(found.ready, true);
});

test('the same top-up on a draft whose run is manual (自动补到完整 off) stays one round: the learner\'s choice is respected', async (t) => {
  const { service, ids } = await library(t);
  const first = await service.call('generate', { sourceIds: ids, coverageLevel: 'lean', kind: 'quiz' });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = await draftOf(service);
  assert.equal(draft.editorial.coverageRun.autoComplete, false);
  const top = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: {} });
  assert.equal(top.autoComplete, false);
});

test('a coverage run whose round hit its time limit (manual run) keeps its draft and offers 接着做: the rounds go on from the next one that is not done', async (t) => {
  const state = { hang: false };
  const wrap = complete => async (system, prompt, context = {}) => {
    if (state.hang && system.startsWith(PLAN) && context.signal) await new Promise((_, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
    return complete(system, prompt, context);
  };
  // The round limit is read when a round starts, from this object: the rounds that have to FINISH get a limit no machine load can reach, and only the round that is meant to run out of time
  // gets a short one. (A short limit for the whole test made the first run and the retry race the real clock: they failed whenever the machine was busy.)
  const coverage = { roundLimit: 8, roundTimeoutMs: 120_000 }, SHORT_MS = 150;
  const { service, ids } = await library(t, { coverage, wrap });
  const first = await service.call('generate', { sourceIds: ids, coverageLevel: 'lean', kind: 'quiz' });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = await draftOf(service);
  state.hang = true; coverage.roundTimeoutMs = SHORT_MS;
  const top = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { autoComplete: false } });
  const ended = await settleJob(service, top.jobId, { timeoutMs: 30_000 });
  assert.equal(ended.status, 'failed', ended.stage);
  const { contract } = await jobOf(service, top.jobId);
  assert.equal(contract.actions.retry.available, true, 'a round that ran out of time is continued, not forgotten');
  state.hang = false; coverage.roundTimeoutMs = 120_000;
  const retried = await service.call('job.control', { jobId: top.jobId, action: 'retry' });
  assert.equal((await settleJob(service, retried.jobId)).status, 'complete');
});

test('a plain run that ends short without failing (a part was refused, the rest passed) is still continued on its draft: the shortfall offers 接着做 with no job record at all', async (t) => {
  const state = { revoked: true };
  const wrap = complete => async (system, prompt, context = {}) => {
    if (state.revoked && /^Prepare supported/.test(system) && /^Part [2-9]\//.test(context.stage || '')) throw refusal();
    return complete(system, prompt, context);
  };
  const { service, ids } = await library(t, { model: sectionedModel(), wrap });
  const started = await service.call('generate', { sourceIds: ids, ...PLAIN });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete', 'a run whose other part passed is complete, and short');
  const draft = await draftOf(service);
  assert.equal(draft.cards.length, 4);
  const view = await service.call('coverage.get', { draftId: draft.id });
  const found = shortfallOf({ draft, coverage: view.coverage, round: view.round });
  assert.deepEqual([found.questionsKept, found.questionsGoal, found.action, found.continueKind, found.planned], [4, 6, 'continue', 'count', false], 'the draft itself says what it owes, whatever happened to the job');
  state.revoked = false;
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion });
  assert.equal((await settleJob(service, next.jobId)).status, 'complete');
  assert.ok((await draftOf(service)).cards.length > 4);
});
