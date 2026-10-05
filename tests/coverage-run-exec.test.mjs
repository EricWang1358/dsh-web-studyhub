import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { reportUsage } from '../lib/usage-scope.js';
import { jobContract } from '../lib/job-contract.js';
import { roundList } from '../lib/coverage-run.js';
import { settleJob, until, sleep } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';

/* The EXECUTOR of a coverage run (phase 3b): the rounds of the plan one after another on the same draft, each round the coverage top-up (the enforced assignments, at most one round of questions),
   the draft as the checkpoint (editorial.coverageSpec.rounds[i].status and editorial.coverageRun), pause between rounds, resume, restart, the stop conditions and their true reasons.
   A fake model that clusters on purpose (tests/helpers/clustering-model.mjs); the round size is injected so a run is a few seconds: new StudyService(root, { coverage: { roundLimit } }). */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const PLAN = 'Plan a source-grounded assessment';

const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };
/** A model that holds the n-th planning call (1-based) until the gate is opened, and counts the planning calls. */
function gated(model, { at, hold }) {
  let plans = 0;
  const complete = async (system, prompt, context = {}) => {
    if (system.startsWith(PLAN)) { plans += 1; if (plans === at) { hold.entered = true; await hold.promise; } }
    return model.complete(system, prompt, context);
  };
  return { complete, plans: () => plans };
}

/** A model that holds the first planning call made while round `round` (2 or later) is the one the draft says is running, until the gate is opened: the draft names the round, so the test does not count calls. */
function gatedAtRound(complete, service, { round, hold }) {
  return async (system, prompt, context = {}) => {
    if (!hold.entered && system.startsWith(PLAN)) {
      const spec = (await service.call('export')).drafts[0]?.editorial.coverageSpec;
      if (spec?.rounds[round - 1]?.status === 'running') { hold.entered = true; await hold.promise; }
    }
    return complete(system, prompt, context);
  };
}

async function library(t, { coverage = { roundLimit: 8 }, model = clusteringModel(), wrap, root, weightOf, seed = true } = {}) {
  root ||= await mkdtemp(join(tmpdir(), 'study-coverage-exec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage });
  t.after(() => service.dispose());
  service.complete = wrap ? wrap(model.complete, service) : model.complete;
  service.light = async (system, prompt) => {
    const evidence = JSON.parse(prompt.split('\n\n')[0]).sections;
    return JSON.stringify({ sections: evidence.map(item => ({ id: item.id, importance: weightOf?.(item) ?? 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  };
  if (seed) for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, model, root, ids: world.sources.map(source => source.id) };
}
const draftOf = async service => (await service.call('export')).drafts[0];
const contractOfJob = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.contract;
const statuses = draft => roundList(draft.editorial.coverageSpec).map(round => round.status);
const eventCodes = contract => contract.events.map(event => event.code);

test('every round runs, in order, on the same draft: the approved questions stay, what was asked for does not move, and the draft says what each round did', async (t) => {
  const { service, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  assert.equal(started.plan.rounds, 3);
  assert.equal(started.autoComplete, true, '标准 goes on by itself');
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const state = await service.call('export'), draft = state.drafts[0], spec = draft.editorial.coverageSpec;
  assert.equal(state.drafts.length, 1, 'one draft, not one per round');
  assert.deepEqual(statuses(draft), ['done', 'done', 'done']);
  assert.equal(draft.editorial.requested, spec.rounds[0].questions, 'what the draft was asked for is the first round: it did not grow');
  assert.equal(draft.cards.length, spec.goal, 'the plan was written in full');
  const times = spec.rounds.map(round => Date.parse(round.finishedAt));
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'the rounds ran in order');
  assert.ok(spec.rounds.every((round, at) => Date.parse(round.startedAt) >= (at ? times[at - 1] : 0)), 'and never overlapped');
  assert.ok(spec.rounds.every(round => round.planned === round.questions && round.kept === round.questions && round.covered >= 1));
  assert.equal(spec.rounds.reduce((sum, round) => sum + round.covered, 0), 12, 'every section is covered by exactly one round');
  assert.deepEqual({ state: draft.editorial.coverageRun.state, auto: draft.editorial.coverageRun.autoComplete, jobId: draft.editorial.coverageRun.jobId }, { state: 'complete', auto: true, jobId: started.jobId });
  assert.equal(draft.editorial.coverageRun.stop.reason, 'complete');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.covered, view.coverage.leaves, 'the coverage reached the target of the level');
  assert.equal(view.round.sections, 0, 'nothing is left for a top-up');
  const contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.detail.run.rounds, 3);
  assert.equal(contract.detail.run.state, 'complete');
  assert.deepEqual(contract.detail.run.list.map(round => round.status), ['done', 'done', 'done']);
  const codes = eventCodes(contract);
  assert.equal(codes.filter(code => code === 'round-start').length, 3);
  assert.equal(codes.filter(code => code === 'round-end').length, 3);
  assert.equal(contract.events.filter(event => event.code === 'run-stop').map(event => event.args.reason).join(), 'complete', 'one line says why the run ended');
  assert.equal(contract.progress.percent, 100);
});

test('manual: the run does round 1 and waits; the one top-up button runs the next planned round, and the plan stays', async (t) => {
  const { service, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  assert.equal(started.autoComplete, false);
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  let draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'pending', 'pending']);
  assert.equal(draft.editorial.coverageRun.state, 'waiting');
  assert.equal(draft.editorial.coverageRun.autoComplete, false);
  const spec = draft.editorial.coverageSpec, view = await service.call('coverage.get', { draftId: draft.id });
  assert.deepEqual(view.round.picks.map(pick => pick.key).sort(), [...spec.rounds[1].sectionIds].sort(), 'the button is the next round of the plan');
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: view.round.picks.map(pick => pick.key) } });
  assert.equal((await settleJob(service, next.jobId)).status, 'complete');
  draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'done', 'pending'], 'each press runs exactly one round');
  assert.equal(draft.editorial.coverageRun.state, 'waiting');
  assert.deepEqual(draft.editorial.coverageSpec.quotas, spec.quotas);
  assert.equal(draft.editorial.requested, spec.rounds[0].questions);
  const again = await service.call('coverage.get', { draftId: draft.id });
  assert.deepEqual(again.round.picks.map(pick => pick.key).sort(), [...spec.rounds[2].sectionIds].sort());
  const last = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: again.round.picks.map(pick => pick.key) } });
  await settleJob(service, last.jobId);
  draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'done', 'done']);
  assert.equal(draft.editorial.coverageRun.state, 'complete', 'the last press completes the run');
});

test('接着做 from a waiting run (coverage.run) runs the rest by itself; the learner can ask for it even when it was manual', async (t) => {
  const { service, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  await settleJob(service, started.jobId);
  const draft = await draftOf(service);
  const rest = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: true } });
  assert.equal(rest.autoComplete, true);
  assert.equal(rest.plan.round, 2, 'it starts at the next round that is not done');
  assert.equal((await settleJob(service, rest.jobId)).status, 'complete');
  const after = await draftOf(service);
  assert.deepEqual(statuses(after), ['done', 'done', 'done']);
  assert.equal(after.cards.length, after.editorial.coverageSpec.goal);
  await assert.rejects(service.call('generate', { resumeDraftId: after.id, draftVersion: after.draftVersion, coverage: { run: true } }), /计划已经完成|plan is complete/);
  await assert.rejects(service.call('generate', { resumeDraftId: after.id, draftVersion: after.draftVersion, coverage: { run: 'yes' } }), /coverage/);
});

test('the target of the level: rounds whose sections were all covered meanwhile are skipped, and the run says it reached the target', async (t) => {
  const { service, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  await settleJob(service, started.jobId);
  let draft = await draftOf(service);
  const spec = draft.editorial.coverageSpec;
  // The learner presses the button for the LAST round of the plan by hand (the sections of round 3)...
  const third = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: spec.rounds[2].sectionIds } });
  await settleJob(service, third.jobId);
  draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'pending', 'done'], 'an explicit choice of sections marks the round those sections belong to');
  // ...and then lets the run go on: round 2 is the only one left.
  const rest = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: true } });
  assert.equal((await settleJob(service, rest.jobId)).status, 'complete');
  draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'done', 'done']);
  assert.equal(draft.editorial.coverageRun.state, 'complete');
  assert.equal(draft.editorial.coverageRun.stop.reason, 'complete');
});

test('a round that makes no progress stops the run, with its reason, instead of asking again and again', async (t) => {
  const hits = { plans: 0 };
  const model = clusteringModel({ refuse: () => { hits.plans += 1; return hits.plans > 1; } });
  const { service, ids } = await library(t, { model });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', 'the run ended, partly done: it is not a failure of the learner');
  const draft = await draftOf(service), run = draft.editorial.coverageRun;
  assert.deepEqual(statuses(draft), ['done', 'failed', 'pending']);
  assert.equal(run.state, 'stopped');
  assert.equal(run.stop.reason, 'no-progress');
  assert.equal(draft.editorial.coverageSpec.rounds[1].covered, 0);
  const bound = hits.plans;
  await sleep(150);
  assert.equal(hits.plans, bound, 'nothing asks again once it has stopped');
  assert.ok(bound <= 16, `the failing round asked ${bound - 1} times (its own retries) and no more`);
  const contract = await contractOfJob(service, started.jobId);
  const stop = contract.events.find(event => event.code === 'run-stop');
  assert.equal(stop.args.reason, 'no-progress');
  assert.equal(stop.args.round, 2);
  assert.equal(contract.result.completeness, 'partial');
  assert.equal(contract.detail.run.stop.reason, 'no-progress');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.coverage.covered < view.coverage.leaves, 'the sections that did not come out are still listed for the top-up');
});

test('a section that failed after its retries is retried by a fill round, at most FILL_ROUNDS of them; the run goes on to its end', async (t) => {
  let refused = 0;
  // One section of the first round is asked in a planning call of its own (the quota of the first assignments fills a call of 10): refuse it as often as one round retries a part,
  // so the first round keeps everything else, and that section is planned-and-failed when the planned rounds are done.
  const model = clusteringModel({ refuse: request => { const single = request.assignments?.length === 1 && request.assignments[0].quota === 2; if (single && refused < 3) { refused += 1; return true; } return false; } });
  const { service, ids } = await library(t, { model, coverage: { roundLimit: 12 } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), rounds = roundList(draft.editorial.coverageSpec);
  assert.equal(refused, 3);
  assert.ok(rounds.some(round => round.fill), 'a fill round was appended');
  assert.ok(rounds.filter(round => round.fill).length <= 2, 'bounded');
  assert.ok(rounds.every(round => round.status === 'done'));
  assert.equal(draft.editorial.coverageRun.state, 'complete');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.covered, view.coverage.leaves);
});

test('a token budget the learner set stops the run at a round boundary and says so; the rest is one press away', async (t) => {
  const { service, ids } = await library(t, { wrap: complete => async (system, prompt, context) => { reportUsage({ uncachedInputTokens: 1000, outputTokens: 100 }); return complete(system, prompt, context); } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', tokenBudget: 5000 });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete');
  const draft = await draftOf(service), run = draft.editorial.coverageRun;
  assert.equal(run.stop.reason, 'budget');
  assert.equal(run.state, 'stopped');
  assert.equal(run.tokenBudget, 5000);
  assert.ok(run.tokensUsed >= 5000, `${run.tokensUsed} tokens are spent`);
  assert.deepEqual(statuses(draft), ['done', 'pending', 'pending'], 'it stopped after the round in which the budget was spent');
  assert.equal(draft.editorial.coverageSpec.rounds[0].tokens > 0, true, 'the round says what it cost');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.round.sections > 0 && view.canTopUp);
});

test('pause: the running round finishes, no new round starts, 暂停于第 1 轮之后; resume goes on; no round runs twice', async (t) => {
  const hold = gate(), plans = [];
  const model = clusteringModel({ onPlan: request => plans.push(request.assignments?.map(item => item.sectionId).join() ?? '') });
  let held;
  const { service, ids } = await library(t, { model, wrap: complete => { held = gated({ complete }, { at: 1, hold }); return held.complete; } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 1 to be in flight');
  let contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.actions.pause.mode, 'checkpoint');
  assert.equal(contract.actions.pause.available, true);
  assert.equal(contract.actions.resume.available, false);
  assert.ok(contract.actions.set.settings.some(item => item.key === 'autoComplete' && item.type === 'bool' && item.value === true));
  const reply = await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal(reply.changed.paused, true);
  contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.status, 'pausing', 'asked, not reached: the round is still running');
  hold.open();
  await until(async () => (await contractOfJob(service, started.jobId)).status === 'paused', 'the pause to be reached');
  await sleep(200);
  let draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'pending', 'pending'], 'round 1 finished, round 2 did not start');
  assert.equal(draft.editorial.coverageRun.state, 'paused');
  contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.status, 'paused');
  assert.equal(contract.actions.resume.available, true);
  assert.equal(contract.detail.run.pausedAfter, 1, '暂停于第 1 轮之后');
  assert.ok(eventCodes(contract).includes('run-paused'));
  const askedWhilePaused = held.plans();
  await sleep(150);
  assert.equal(held.plans(), askedWhilePaused, 'nothing runs while it is paused');
  await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'done', 'done']);
  const done = await contractOfJob(service, started.jobId);
  assert.deepEqual(done.events.filter(event => event.code === 'round-start').map(event => event.args.round), [1, 2, 3], 'every round started exactly once, in order');
  assert.ok(plans.length > 0);
  assert.equal(draft.cards.length, draft.editorial.coverageSpec.goal);
});

test('stop here (cancel) keeps everything approved: the rounds done stay, the round in flight is marked, the run says the learner stopped it', async (t) => {
  const hold = gate();
  const { service, ids } = await library(t, { wrap: (complete, service) => gatedAtRound(complete, service, { round: 2, hold }) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 2 to be in flight');
  const before = await draftOf(service);
  assert.deepEqual(statuses(before), ['done', 'running', 'pending']);
  const cards = before.cards.map(card => card.id);
  await service.call('job.control', { jobId: started.jobId, action: 'cancel' });
  hold.open();
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'cancelled');
  const draft = await draftOf(service);
  assert.deepEqual(draft.cards.map(card => card.id).slice(0, cards.length), cards, 'every approved question is still there');
  assert.deepEqual(statuses(draft).slice(0, 1), ['done']);
  assert.notEqual(statuses(draft)[1], 'running', 'the round that was in flight is not left "running"');
  assert.equal(draft.editorial.coverageRun.state, 'stopped');
  assert.equal(draft.editorial.coverageRun.stop.reason, 'learner');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.canTopUp && view.round.sections > 0, 'the rest is one press away');
});

test('resuming twice does not run a round twice: one run per draft', async (t) => {
  const { service, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  await settleJob(service, started.jobId);
  const draft = await draftOf(service);
  const args = { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: true } };
  const results = await Promise.allSettled([service.call('generate', args), service.call('generate', args)]);
  assert.deepEqual(results.map(item => item.status).sort(), ['fulfilled', 'rejected']);
  assert.match(String(results.find(item => item.status === 'rejected').reason.message), /正在生成|already|生成/);
  const job = await settleJob(service, results.find(item => item.status === 'fulfilled').value.jobId);
  assert.equal(job.status, 'complete');
  const after = await draftOf(service);
  assert.equal(after.cards.length, after.editorial.coverageSpec.goal, 'every round exactly once');
  assert.deepEqual(statuses(after), ['done', 'done', 'done']);
});

test('the toggle 自动补到完整 can be flipped any time: off makes the run wait after the current round; on makes a manual run go on', async (t) => {
  const offGate = gate();
  const first = await library(t, { wrap: complete => gated({ complete }, { at: 1, hold: offGate }).complete });
  const startedOn = await first.service.call('generate', { sourceIds: first.ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => offGate.entered, 'round 1 to be in flight');
  const reply = await first.service.call('job.control', { jobId: startedOn.jobId, action: 'set', patch: { autoComplete: false } });
  assert.deepEqual(reply.changed, { autoComplete: false });
  offGate.open();
  assert.equal((await settleJob(first.service, startedOn.jobId)).status, 'complete');
  const waiting = await draftOf(first.service);
  assert.deepEqual(statuses(waiting), ['done', 'pending', 'pending'], 'it stopped after the current round');
  assert.equal(waiting.editorial.coverageRun.state, 'waiting');
  assert.equal(waiting.editorial.coverageRun.autoComplete, false);
  const contract = await contractOfJob(first.service, startedOn.jobId);
  assert.equal(contract.detail.run.auto, false);
  assert.equal(contract.actions.pause.available, false, 'a run that does not go on has no boundary to pause at');
  assert.equal(contract.actions.pause.reason.code, 'job-ended', 'it has ended: the job is over, nothing to pause');
  const onGate = gate();
  const second = await library(t, { wrap: complete => gated({ complete }, { at: 1, hold: onGate }).complete });
  const startedOff = await second.service.call('generate', { sourceIds: second.ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  await until(() => onGate.entered, 'the manual round to be in flight');
  const live = await contractOfJob(second.service, startedOff.jobId);
  assert.equal(live.actions.pause.available, false, 'manual: no boundary to pause at yet');
  assert.equal(live.actions.pause.reason.code, 'manual-run');
  await second.service.call('job.control', { jobId: startedOff.jobId, action: 'set', patch: { autoComplete: true } });
  onGate.open();
  assert.equal((await settleJob(second.service, startedOff.jobId)).status, 'complete');
  const done = await draftOf(second.service);
  assert.deepEqual(statuses(done), ['done', 'done', 'done'], 'ticked in the middle of round 1: it went on to the end');
});

test('a round has its own time limit; the run has none: three rounds take longer than one round is allowed', async (t) => {
  // Every round waits 900 ms once (its first planning call), so a round takes about a second and the three of them more than the 2.6 s one round may take.
  const slowRounds = (complete, service) => {
    const slept = new Set();
    return async (system, prompt, context = {}) => {
      if (system.startsWith(PLAN)) {
        const running = ((await service.call('export')).drafts[0]?.editorial.coverageSpec?.rounds || []).findIndex(round => round.status === 'running'), key = Math.max(0, running);
        if (!slept.has(key)) { slept.add(key); await sleep(900); }
      }
      return complete(system, prompt, context);
    };
  };
  const { service, ids } = await library(t, { coverage: { roundLimit: 8, roundTimeoutMs: 2600 }, wrap: slowRounds });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), spec = draft.editorial.coverageSpec;
  assert.ok(Date.parse(spec.rounds[2].finishedAt) - Date.parse(spec.rounds[0].startedAt) > 2600, 'the run lasted longer than one round may');
  assert.ok(spec.rounds.every(round => round.ms >= 800 && round.ms < 2600), JSON.stringify(spec.rounds.map(round => round.ms)));
  const stuck = await library(t, { coverage: { roundLimit: 8, roundTimeoutMs: 300 }, wrap: complete => async (system, prompt, context = {}) => {
    if (system.startsWith(PLAN) && context.signal) await new Promise((_, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
    return complete(system, prompt, context);
  } });
  const startedStuck = await stuck.service.call('generate', { sourceIds: stuck.ids, coverageLevel: 'standard', kind: 'quiz' });
  const ended = await settleJob(stuck.service, startedStuck.jobId, { timeoutMs: 20_000 });
  assert.equal(ended.status, 'failed', 'a round that never answers ends the job at the round limit');
  assert.match(ended.stage, /round|轮|budget/i);
});

test('a restart does not lose a run: the draft is the checkpoint; a second service restores it as interrupted, 接着做 re-runs the round that was in flight and goes on', async (t) => {
  const hold = gate();
  const crashed = await library(t, { wrap: (complete, service) => gatedAtRound(complete, service, { round: 2, hold }) });
  const started = await crashed.service.call('generate', { sourceIds: crashed.ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 2 to be in flight');
  const mid = await draftOf(crashed.service);
  assert.deepEqual(statuses(mid), ['done', 'running', 'pending']);
  assert.equal(mid.editorial.coverageRun.state, 'running');
  // The host dies here: what is on disk now is all a restart has. (A copy of the folder; the first service is then let go.)
  const copy = await mkdtemp(join(tmpdir(), 'study-coverage-restart-'));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(crashed.root, copy, { recursive: true });
  const after = await library(t, { root: copy, seed: false });
  // The same library folder, a new process: the snapshot brings the run back as an interrupted job.
  const snapshot = await after.service.call('snapshot');
  const restored = snapshot.jobs.find(job => job.draftId === mid.id);
  assert.ok(restored, 'the interrupted run is on the task list');
  assert.equal(restored.contract.status, 'interrupted');
  assert.equal(restored.id, started.jobId, 'it is the same job');
  assert.equal(restored.contract.actions.retry.available, true, '接着做');
  assert.equal(restored.contract.detail.run.round, 2, '继续第 2 轮');
  assert.equal(restored.contract.detail.run.rounds, 3);
  assert.ok(restored.contract.error.message, 'it says why');
  assert.ok(eventCodes(restored.contract).includes('run-interrupted'));
  assert.equal((await after.service.call('snapshot')).jobs.filter(job => job.draftId === mid.id).length, 1, 'restoring it is idempotent');
  const reply = await after.service.call('job.control', { jobId: restored.id, action: 'retry' });
  assert.ok(reply.jobId);
  const job = await settleJob(after.service, reply.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const done = (await after.service.call('export')).drafts[0];
  assert.deepEqual(statuses(done), ['done', 'done', 'done'], 'the round that was in flight was run again, and the last one after it');
  assert.equal(done.cards.length, done.editorial.coverageSpec.goal, 'nothing doubled: the questions of round 1 were kept, round 2 and 3 written once');
  assert.equal(done.editorial.coverageRun.state, 'complete');
  const contract = await contractOfJob(after.service, reply.jobId);
  const rerun = contract.events.find(event => event.code === 'round-rerun');
  assert.equal(rerun?.args.round, 2, 'the log says round 2 is run again');
  assert.equal((await after.service.call('snapshot')).jobs.filter(job => job.draftId === mid.id && job.contract.status === 'interrupted').length, 0, 'the interrupted record is replaced by the new job');
  hold.open();
});

test('the contract: a coverage run declares the pause checkpoint, a plain generation does not, and each says why', async (t) => {
  const run = jobContract({ id: 'a', status: 'running', control: { values: {}, limits: {} }, coverageRun: { autoComplete: true, round: 1, rounds: 3, state: 'running', list: [] } });
  assert.equal(run.actions.pause.mode, 'checkpoint');
  assert.equal(run.actions.pause.available, true);
  const plain = jobContract({ id: 'b', status: 'running', control: { values: {}, limits: {} } });
  assert.equal(plain.actions.pause.mode, 'unsupported');
  assert.equal(plain.actions.pause.available, false);
  assert.equal(plain.actions.pause.reason.code, 'single-round');
  const manual = jobContract({ id: 'c', status: 'running', control: { values: {}, limits: {} }, coverageRun: { autoComplete: false, round: 1, rounds: 3, state: 'running', list: [] } });
  assert.equal(manual.actions.pause.reason.code, 'manual-run');
  const interrupted = jobContract({ id: 'd', status: 'interrupted', retryable: true, coverageRun: { autoComplete: true, round: 2, rounds: 3, state: 'running', list: [] } });
  assert.equal(interrupted.actions.retry.available, true);
  assert.equal(jobContract({ id: 'e', status: 'interrupted', retryable: true }).actions.retry.available, false, 'a plain generation has nothing to continue');
  assert.ok(t);
});

test('a host that is closed under a run (the plugin is unloaded) leaves the draft saying it was running: the same library, a new service, 接着做', async (t) => {
  const hold = gate();
  const closing = await library(t, { wrap: (complete, service) => gatedAtRound(complete, service, { round: 2, hold }) });
  const started = await closing.service.call('generate', { sourceIds: closing.ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 2 to be in flight');
  await closing.service.dispose();
  hold.open();
  await sleep(300);
  const reopened = new StudyService(closing.root);
  t.after(() => reopened.dispose());
  reopened.complete = clusteringModel().complete;
  const draft = (await reopened.call('export')).drafts[0];
  assert.equal(draft.editorial.coverageRun.state, 'running', 'closing the host is nobody stopping the run: the marker is left as it was');
  assert.deepEqual(statuses(draft), ['done', 'running', 'pending']);
  const restored = (await reopened.call('snapshot')).jobs.find(job => job.draftId === draft.id);
  assert.equal(restored.contract.status, 'interrupted');
  assert.equal(restored.id, started.jobId);
  const reply = await reopened.call('job.control', { jobId: restored.id, action: 'retry' });
  assert.equal((await settleJob(reopened, reply.jobId)).status, 'complete');
  const done = (await reopened.call('export')).drafts[0];
  assert.deepEqual(statuses(done), ['done', 'done', 'done']);
  assert.equal(done.cards.length, done.editorial.coverageSpec.goal);
});

test('a round larger than the 30 questions of a production round is accepted when the seam says so: the button of a manual run is not refused by a limit the plan did not use', async (t) => {
  const big = mergedTranscript();
  const root = await mkdtemp(join(tmpdir(), 'study-coverage-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 40 } });
  t.after(() => service.dispose());
  service.complete = clusteringModel().complete;
  for (const source of big.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const started = await service.call('generate', { sourceIds: big.sources.map(source => source.id), coverageLevel: 'lean', kind: 'quiz' });
  assert.equal(started.autoComplete, false);
  assert.ok(started.plan.questions > 30 && started.plan.questions <= 40, `round 1 holds ${started.plan.questions} questions`);
  await settleJob(service, started.jobId);
  const draft = await draftOf(service), view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.round.questions > 30, `round 2 holds ${view.round.questions} questions`);
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: view.round.picks.map(pick => pick.key) } });
  assert.equal((await settleJob(service, next.jobId)).status, 'complete');
  assert.deepEqual(statuses(await draftOf(service)).slice(0, 2), ['done', 'done']);
});
