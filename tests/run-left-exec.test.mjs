import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { reportUsage } from '../lib/usage-scope.js';
import { usageLedger } from '../lib/model-usage.js';
import { roundList } from '../lib/coverage-run.js';
import { settleJob, until } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel, sectionOfQuote } from './helpers/clustering-model.mjs';

/* What a top-up of an almost covered draft says is LEFT (the owner's screen of 2026-10-08: 「还要 1 轮、约 30 题」, 「1 / 约 30」 and 「预计还要约 3.1M tok」 for a round whose planner had
   returned 3 knowledge points, 「已用 5M tok」 beside a usage panel of 212,255). The draft: a standard plan of two rounds (30 + 21 questions), the second refused by its planner, then a fill
   round that writes its sections again except one, for which the planner finds no point (it fails twice and the run stops with that section left). The learner presses 为没覆盖的部分补题
   for it: the button lands in round 2 (failed, it holds the section), whose plan was 21 questions; the job asks for the one section only. Everything the console says is left must be that section. */

const world = mergedTranscript({ recordings: 2, parts: 16, paragraphs: 4 });
const PLAN = 'Plan a source-grounded assessment', REVIEW = 'Act as a strict assessment editor';

const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };

/** `pick(keys, quotas)`: the section of round 2 that is left; `planKeep`: in the top-up, the planner returns at most that many points for it, however often it is asked (a plan that comes back short). */
async function almostCovered(t, { pick = keys => keys.at(-1), planKeep = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-run-left-'));
  // One fill round: the story is a run that ended with one section left; the run may now write a section again in further fill rounds (lib/coverage-run.js FILL_ROUNDS), which is not what this test is about.
  const service = new StudyService(root, { coverage: { roundLimit: 30, fillRounds: 1 } });
  const model = clusteringModel(), world2 = { phase: 1, last: null, holdPlan: null, holdReview: null, returned: 0 };
  /* One cleanup, in this order (t.after hooks run in the order they were registered, so two hooks would remove the folder first). A failed check must not leave the job held for ever, so the gates open first;
     then the service stops; then the usage ledger, which writes the tally of every call after the call and is not waited for by the job, is let to finish its queue (on a slow disk it is still writing when the
     job has ended, and the folder then still gets a file while it is removed: ENOTEMPTY, the CI failure of 2026-10-08); then the folder goes. */
  t.after(async () => {
    world2.holdPlan?.open(); world2.holdReview?.open();
    await service.dispose();
    await usageLedger(root).summary();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const inLast = target => !!world2.last && world2.last.endsWith(`#${sectionOfQuote(target?.citations?.[0]?.quote || '')}`);
  /** The planner's answer with at most `keep` points (over every call) in the section that is left. */
  const planned = async (system, prompt, context, keep) => {
    const reply = JSON.parse(await model.complete(system, prompt, context));
    if (Array.isArray(reply.targets)) reply.targets = reply.targets.filter(target => !inLast(target) || world2.returned++ < keep);
    return JSON.stringify(reply);
  };
  const spec = async () => (await service.call('export')).drafts[0]?.editorial?.coverageSpec;
  service.complete = async (system, prompt, context = {}) => {
    // Every call costs: the first job's tokens are the run's history, the second job's are its own.
    reportUsage({ uncachedInputTokens: 1000, outputTokens: 100 });
    if (world2.phase === 1 && system.startsWith(PLAN)) {
      const plan = await spec(), rounds = plan?.rounds || [];
      world2.last ||= rounds[1] ? pick(rounds[1].sectionIds, new Map((plan.quotas || []).map(item => [item.sectionId, item.quota]))) : null;
      // Round 2 of the plan is refused by its planner (it fails and keeps nothing)...
      if (rounds[1]?.status === 'running') return JSON.stringify({ error: 'insufficient evidence' });
      // ...and the fill round that writes its sections again finds a point in every one of them except one section of round 2 (`pick`).
      if (rounds[2]?.fill && rounds[2].status === 'running') return planned(system, prompt, context, 0);
    }
    if (world2.phase === 2 && system.startsWith(PLAN) && world2.holdPlan && !world2.holdPlan.entered) { world2.holdPlan.entered = true; await world2.holdPlan.promise; }
    if (world2.phase === 2 && system.startsWith(REVIEW) && world2.holdReview && !world2.holdReview.entered) { world2.holdReview.entered = true; await world2.holdReview.promise; }
    if (world2.phase === 2 && system.startsWith(PLAN) && Number.isInteger(planKeep)) return planned(system, prompt, context, planKeep);
    return model.complete(system, prompt, context);
  };
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const first = await service.call('generate', { sourceIds: world.sources.map(source => source.id), coverageLevel: 'standard', kind: 'quiz' });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  return { service, draft, world: world2, first };
}

const contractOf = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.contract;

test('a top-up of the one section left of a failed round: what is left is that section (before the plan returns, then the points it returned), not the 21 questions round 2 was planned for', async (t) => {
  const { service, draft, world: phase } = await almostCovered(t);
  const spec = draft.editorial.coverageSpec, rounds = roundList(spec);
  assert.deepEqual(rounds.map(round => `${round.fill ? 'fill:' : ''}${round.status}`), ['done', 'failed', 'fill:done'], 'the draft: round 2 failed, its fill round left one section');
  assert.equal(rounds[1].questions, 21, 'round 2 was planned for 21 questions');
  const view = await service.call('coverage.get', { draftId: draft.id });
  const left = view.round.picks.map(pick => pick.key);
  assert.deepEqual(left, [phase.last], 'one section is left: the last of round 2');
  assert.equal(view.coverage.leaves - view.coverage.covered, 1);
  const quota = spec.quotas.find(item => item.sectionId === phase.last).quota;
  assert.ok(quota >= 1 && quota < 21);
  const runBefore = draft.editorial.coverageRun.tokensUsed;
  assert.ok(runBefore > 0, 'the run spent tokens before this job');

  phase.phase = 2; phase.holdPlan = gate(); phase.holdReview = gate();
  const started = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: left, autoComplete: true } });
  await until(() => phase.holdPlan.entered, 'the top-up to ask its planner');
  let contract = await contractOf(service, started.jobId);
  assert.equal(contract.detail.run.round, 2, 'the button ran round 2 again (it holds the section)');
  assert.equal(contract.detail.run.questionsLeft, quota, `before the planner answers, what is left is the section's quota (${quota}), not round 2's 21`);
  assert.equal(contract.detail.own.asked, quota, '本任务 0 / 约 quota');
  assert.equal(contract.detail.run.left, 1, 'one round');
  assert.ok(!(contract.detail.run.tokensUsed > contract.usage.tokens), `已用 in the run line is this job's (${contract.usage.tokens}), not the run's ${runBefore}`);
  assert.equal(contract.detail.run.ownTokens, true, 'and is said to be this job\'s');
  // The estimate before the run priced this job's one round; it is not scaled by the 21 questions round 2 was planned for.
  const priced = contract.detail.estimate?.totalTokens;
  assert.ok(priced?.high > 0, 'the job has an estimate');
  assert.ok(contract.detail.run.estimateTokens <= priced.high, `出题前估 ${contract.detail.run.estimateTokens} is the job's own estimate (at most ${priced.high})`);

  phase.holdPlan.open();
  await until(() => phase.holdReview.entered, 'the top-up to reach its first review (its plan has returned)');
  contract = await contractOf(service, started.jobId);
  const points = (contract.detail.targets?.list || []).filter(entry => entry.round === 2);
  assert.ok(points.length >= 1 && points.length <= quota, `the planner returned ${points.length} point(s) for the section`);
  assert.equal(contract.detail.run.questionsLeft, points.length, 'once the plan has returned, what is left is its points that are not decided yet');
  assert.equal(contract.detail.own.asked, points.length, '本任务 0 / 约 points');
  assert.equal(contract.detail.run.tokensUsed, contract.usage.tokens, '已用 is this job\'s tokens, the same number as the usage panel');
  assert.equal(contract.detail.run.list[1].questions, quota, 'the round says what it asked for this time');

  phase.holdReview.open();
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const after = await contractOf(service, started.jobId), final = (await service.call('export')).drafts[0];
  assert.equal(final.editorial.coverageRun.tokensUsed, runBefore + after.usage.tokens, 'the run keeps counting every job (its budget is the run\'s)');
  assert.equal(after.detail.run.tokensUsed, after.usage.tokens);
  assert.equal(after.detail.own.made, points.length);
  assert.equal(after.detail.own.asked, points.length, 'the job made what it was asked for');
});

test('a plan that comes back short: once the planner has answered, the round makes what it returned, and the console says that, not what it asked', async (t) => {
  // The section left is one the plan gave 2 questions; in the top-up the planner finds 1 point in it, however often it is asked.
  const { service, draft, world: phase } = await almostCovered(t, { pick: (keys, quotas) => keys.find(key => quotas.get(key) >= 2), planKeep: 1 });
  const quota = draft.editorial.coverageSpec.quotas.find(item => item.sectionId === phase.last).quota;
  assert.equal(quota, 2);
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.deepEqual(view.round.picks.map(pick => pick.key), [phase.last]);
  phase.phase = 2; phase.holdPlan = gate(); phase.holdReview = gate(); phase.returned = 0;
  const started = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: [phase.last], autoComplete: true } });
  await until(() => phase.holdPlan.entered, 'the top-up to ask its planner');
  let contract = await contractOf(service, started.jobId);
  assert.deepEqual([contract.detail.run.questionsLeft, contract.detail.own.asked], [2, 2], 'before the plan: what it asked for, the quota of the section');
  phase.holdPlan.open();
  await until(() => phase.holdReview.entered, 'the first review (the plan has returned, short)');
  contract = await contractOf(service, started.jobId);
  const short = (contract.detail.targets?.short || []).filter(item => item.round === 2);
  assert.deepEqual(short.map(item => [item.needed, item.got]), [[2, 1]], 'the plan says it came back short: 1 of 2');
  assert.equal(contract.detail.run.questionsLeft, 1, 'what is left is the one point it returned');
  assert.equal(contract.detail.own.asked, 1, '本任务 0 / 约 1: the round makes what its plan returned');
  phase.holdReview.open();
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const after = await contractOf(service, started.jobId);
  assert.deepEqual([after.detail.own.made, after.detail.own.asked], [1, 1]);
  assert.equal(after.detail.run.tokensUsed, after.usage.tokens);
});
