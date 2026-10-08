import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { reportUsage } from '../lib/usage-scope.js';
import { jobContract } from '../lib/job-contract.js';
import { roundList, FILL_ROUNDS, REPEAT_LIMIT } from '../lib/coverage-run.js';
import { settleJob, until, sleep } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { stuckRun, refusePlannerUntilFill } from './helpers/staggered-refusals.mjs';

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
  const startedWith = draft.cards.length;
  assert.equal((await settleJob(service, next.jobId)).status, 'complete');
  const continuing = await contractOfJob(service, next.jobId);
  assert.equal(continuing.detail.keptAtStart, startedWith, 'a continued run says how many questions its draft held when it started: a pace is measured from there');
  assert.ok(Date.parse(continuing.detail.runStartedAt) >= Date.parse(continuing.startedAt), 'and has its own run clock');
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
  assert.ok(rounds.filter(round => round.fill).length <= FILL_ROUNDS, 'bounded');
  assert.ok(rounds.every(round => round.status === 'done'));
  assert.equal(draft.editorial.coverageRun.state, 'complete');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.covered, view.coverage.leaves);
});

test('自动补到完整 goes on while a fill round gains a section: a section that failed its planned round AND the first fill round is written by the NEXT fill round (2 fill rounds and 2 attempts, the old limits, stopped at 92% with sections-left)', async (t) => {
  let refused = 0;
  // The test above, with twice the refusals: three sections fail the planned round; the first fill round gets two of them and fails the third (two more refusals); the second fill round writes that one.
  // (11 of the 12 sections is the 92% of the owner's report.)
  const model = clusteringModel({ refuse: request => { const single = request.assignments?.length === 1 && request.assignments[0].quota === 2; if (single && refused < 6) { refused += 1; return true; } return false; } });
  const { service, ids } = await library(t, { model, coverage: { roundLimit: 12 } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), spec = draft.editorial.coverageSpec, rounds = roundList(spec), fills = rounds.filter(round => round.fill);
  assert.equal(draft.editorial.coverageRun.stop.reason, 'complete', 'the run did not stop with a section left');
  assert.equal(draft.editorial.coverageRun.state, 'complete');
  assert.equal(refused, 6);
  assert.equal(fills.length, 2, 'the second fill round was run');
  assert.ok(rounds.every(round => round.status === 'done'), statuses(draft).join(', '));
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.covered, view.coverage.leaves, 'every section has a question');
  const twice = Object.entries(spec.attempts).filter(([, record]) => record.n === 2);
  assert.equal(twice.length, 1, 'one section failed its planned round and the first fill round');
  assert.deepEqual(twice[0][1].rounds.map(item => !!item.fill), [false, true]);
  assert.deepEqual(fills[1].sectionIds, [twice[0][0]], 'the second fill round was asked for exactly that section');
  assert.ok(twice[0][1].n < REPEAT_LIMIT, 'two failed attempts are below the limit after which a run leaves a section to the learner');
});

test('the bounds hold: a section that never comes out is asked for by its planned round and REPEAT_LIMIT - 1 fill rounds, no more; the run then stops with sections-left', async (t) => {
  // The planner refuses the stuck section every time; the helpers before it come out one fill round later each (tests/helpers/staggered-refusals.mjs), so every fill round gains a section and the run goes on.
  const { stuck, freeFrom } = stuckRun();
  const { service, ids } = await library(t, { wrap: refusePlannerUntilFill({ ...freeFrom, [stuck]: Infinity }), coverage: { roundLimit: 12 } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), spec = draft.editorial.coverageSpec, run = draft.editorial.coverageRun, fills = roundList(spec).filter(round => round.fill);
  assert.ok(fills.length <= FILL_ROUNDS, 'bounded');
  assert.equal(fills.length, REPEAT_LIMIT - 1, 'each fill round gained a section, so the run went on until the stuck section had REPEAT_LIMIT failed attempts');
  assert.ok(fills.every(round => round.covered >= 1));
  assert.ok(Object.values(spec.attempts).every(record => record.n <= REPEAT_LIMIT), 'no section was asked for more than REPEAT_LIMIT times');
  const key = Object.keys(spec.attempts).find(name => name.endsWith(`.p${stuck}`));
  assert.equal(spec.attempts[key].n, REPEAT_LIMIT);
  assert.equal(run.state, 'stopped');
  assert.equal(run.stop.reason, 'sections-left');
  assert.equal(run.stop.left, 1);
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.covered, view.coverage.leaves - 1, 'the other sections have a question');
});

test('a section refused every time ends the run within the bounds: the fill round that gains nothing stops it (no-progress), and no section has more than REPEAT_LIMIT attempts', async (t) => {
  // Whenever the planner is asked alone for one of the sections of the first round (the quota of the first assignments fills a call of 10) it refuses; a fill round wins what a group ask plans, and the round that wins nothing ends the run.
  const model = clusteringModel({ refuse: request => request.assignments?.length === 1 && request.assignments[0].quota === 2 });
  const { service, ids } = await library(t, { model, coverage: { roundLimit: 12 } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), spec = draft.editorial.coverageSpec, run = draft.editorial.coverageRun, fills = roundList(spec).filter(round => round.fill);
  assert.ok(fills.length >= 1 && fills.length <= FILL_ROUNDS, `${fills.length} fill rounds`);
  assert.ok(['no-progress', 'sections-left'].includes(run.stop.reason), run.stop.reason);
  assert.ok(Object.values(spec.attempts).every(record => record.n <= REPEAT_LIMIT), 'no section was asked for more than REPEAT_LIMIT times');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.coverage.covered < view.coverage.leaves, 'the refused section has no question');
  assert.equal(run.stop.left, view.coverage.leaves - view.coverage.covered);
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

/** Counts every model call the run makes, and holds nothing: what a pause must stop is the NEXT one. */
const counting = (complete, counter) => async (system, prompt, context = {}) => { counter.calls += 1; return complete(system, prompt, context); };

test('pause stops new model calls and waits for the running ones, not for the round: the call in flight finishes, nothing else starts, resume goes on; no round runs twice', async (t) => {
  const hold = gate(), counter = { calls: 0 }, plans = [];
  const model = clusteringModel({ onPlan: request => plans.push(request.assignments?.map(item => item.sectionId).join() ?? '') });
  let held;
  const { service, ids } = await library(t, { model, wrap: complete => { held = gated({ complete: counting(complete, counter) }, { at: 1, hold }); return held.complete; } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'the first planning call to be in flight');
  let contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.actions.pause.mode, 'checkpoint');
  assert.equal(contract.actions.pause.available, true);
  assert.equal(contract.actions.resume.available, false);
  assert.ok(contract.actions.set.settings.some(item => item.key === 'autoComplete' && item.type === 'bool' && item.value === true));
  const reply = await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal(reply.changed.paused, true);
  contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.status, 'pausing', 'asked, not reached: a model call is still running');
  assert.ok(contract.actions.pause.waiting.count >= 1, 'and it says what it waits for: the calls in flight');
  hold.open();
  await until(async () => (await contractOfJob(service, started.jobId)).status === 'paused', 'the pause to be reached once that call is done');
  const callsAtPause = counter.calls;
  assert.ok(callsAtPause >= 1, 'the planning call that was in flight when the pause was asked ran to its end');
  await sleep(250);
  assert.equal(counter.calls, callsAtPause, 'nothing new starts while it is paused, in the middle of round 1');
  contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.status, 'paused');
  assert.equal(contract.actions.resume.available, true);
  assert.equal(contract.detail.run.pausedAfter, undefined, 'it stands inside round 1, not after a round');
  assert.ok(eventCodes(contract).includes('paused'));
  assert.ok(!eventCodes(contract).includes('run-paused'), 'no round ended: the run did not reach a boundary');
  await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'done', 'done']);
  const done = await contractOfJob(service, started.jobId);
  assert.deepEqual(done.events.filter(event => event.code === 'round-start').map(event => event.args.round), [1, 2, 3], 'every round started exactly once, in order');
  assert.ok(plans.length > 0);
  assert.equal(draft.cards.length, draft.editorial.coverageSpec.goal);
});

test('a pause inside round 2 does not wait for the round: the round stays running on the draft, the questions that passed stay, and resume finishes the same round', async (t) => {
  const hold = gate(), counter = { calls: 0 };
  const { service, ids } = await library(t, { wrap: (complete, svc) => gatedAtRound(counting(complete, counter), svc, { round: 2, hold }) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 2 to be in flight');
  const before = await draftOf(service);
  assert.deepEqual(statuses(before), ['done', 'running', 'pending']);
  const cardsOfRound1 = before.cards.map(card => card.id);
  await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal((await contractOfJob(service, started.jobId)).status, 'pausing');
  hold.open();
  await until(async () => (await contractOfJob(service, started.jobId)).status === 'paused', 'the pause to be reached inside round 2');
  const callsAtPause = counter.calls;
  await sleep(250);
  assert.equal(counter.calls, callsAtPause, 'round 2 was not finished: its remaining calls are held');
  const paused = await draftOf(service);
  assert.deepEqual(statuses(paused), ['done', 'running', 'pending'], 'round 2 is still the round in flight');
  assert.deepEqual(paused.cards.map(card => card.id).slice(0, cardsOfRound1.length), cardsOfRound1, 'what passed review is kept');
  await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.deepEqual(statuses(await draftOf(service)), ['done', 'done', 'done']);
  const done = await contractOfJob(service, started.jobId);
  assert.deepEqual(done.events.filter(event => event.code === 'round-start').map(event => event.args.round), [1, 2, 3], 'round 2 was resumed, not started again');
});

test('cancel while paused inside a round ends the run as stopped by the learner, with what passed review kept', async (t) => {
  const hold = gate();
  const { service, ids } = await library(t, { wrap: (complete, svc) => gatedAtRound(complete, svc, { round: 2, hold }) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 2 to be in flight');
  const kept = (await draftOf(service)).cards.map(card => card.id);
  await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  hold.open();
  await until(async () => (await contractOfJob(service, started.jobId)).status === 'paused', 'the pause to be reached');
  await service.call('job.control', { jobId: started.jobId, action: 'cancel' });
  const job = await settleJob(service, started.jobId, { timeoutMs: 20_000 });
  assert.equal(job.status, 'cancelled');
  const draft = await draftOf(service);
  assert.deepEqual(draft.cards.map(card => card.id).slice(0, kept.length), kept);
  assert.equal(draft.editorial.coverageRun.state, 'stopped');
  assert.equal(draft.editorial.coverageRun.stop.reason, 'learner');
});

test('pause and resume more than once in one round: each pause is reached with no call running, and the run still ends complete', async (t) => {
  const counter = { calls: 0 };
  // Every call takes a moment, so the run is still working when each of the three pauses is asked.
  const { service, ids } = await library(t, { wrap: complete => counting(async (system, prompt, context) => { await sleep(40); return complete(system, prompt, context); }, counter) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => counter.calls >= 1, 'the first model call');
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await service.call('job.control', { jobId: started.jobId, action: 'pause' });
    await until(async () => ['paused', 'complete'].includes((await contractOfJob(service, started.jobId)).status), `pause ${cycle} to be reached`);
    if ((await contractOfJob(service, started.jobId)).status === 'complete') break;
    const frozen = counter.calls;
    await sleep(80);
    assert.equal(counter.calls, frozen, `nothing starts during pause ${cycle}`);
    await service.call('job.control', { jobId: started.jobId, action: 'resume' });
    await until(() => counter.calls > frozen, `the run to go on after resume ${cycle}`);
  }
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.deepEqual(statuses(await draftOf(service)), ['done', 'done', 'done']);
});

test('the time limit of a round is the time it works: a pause longer than the limit does not cost the round, and the round records only the time it worked', async (t) => {
  const hold = gate(), roundMs = 3000;
  const { service, ids } = await library(t, { coverage: { roundLimit: 8, roundTimeoutMs: roundMs }, wrap: complete => gated({ complete }, { at: 1, hold }).complete });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 1 to be in flight');
  await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  hold.open();
  await until(async () => (await contractOfJob(service, started.jobId)).status === 'paused', 'the pause to be reached');
  const since = Date.now();
  await until(() => Date.now() - since > roundMs + 500, 'the pause to outlast the limit of a round', { intervalMs: 50 });
  await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', `the round must not have timed out while paused: ${job.stage}`);
  const rounds = roundList((await draftOf(service)).editorial.coverageSpec);
  assert.deepEqual(rounds.map(round => round.status), ['done', 'done', 'done']);
  assert.ok(rounds[0].ms < roundMs, `the pause is not in the ${rounds[0].ms} ms the round took`);
  assert.ok(Date.parse(rounds[0].finishedAt) - Date.parse(rounds[0].startedAt) > roundMs, 'although it ended long after it started');
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
  assert.equal(contract.actions.pause.available, false, 'it has ended: nothing to pause');
  assert.equal(contract.actions.pause.reason.code, 'job-ended', 'it has ended: the job is over, nothing to pause');
  const onGate = gate();
  const second = await library(t, { wrap: complete => gated({ complete }, { at: 1, hold: onGate }).complete });
  const startedOff = await second.service.call('generate', { sourceIds: second.ids, coverageLevel: 'standard', kind: 'quiz', autoComplete: false });
  await until(() => onGate.entered, 'the manual round to be in flight');
  const live = await contractOfJob(second.service, startedOff.jobId);
  assert.equal(live.actions.pause.available, true, 'manual: pause stops the calls, so it needs no boundary between rounds');
  await second.service.call('job.control', { jobId: startedOff.jobId, action: 'set', patch: { autoComplete: true } });
  onGate.open();
  assert.equal((await settleJob(second.service, startedOff.jobId)).status, 'complete');
  const done = await draftOf(second.service);
  assert.deepEqual(statuses(done), ['done', 'done', 'done'], 'ticked in the middle of round 1: it went on to the end');
});

test('a round has its own time limit; the run has none: three rounds take longer than one round is allowed', async (t) => {
  // Every round waits 2.5 s once (its first planning call): a round takes 2.5 s plus the run's own overhead (up to ~3 s more on a slow Windows runner), the three of them more than the 6 s one round may take, and one round alone less.
  const slowRounds = (complete, service) => {
    const slept = new Set();
    return async (system, prompt, context = {}) => {
      if (system.startsWith(PLAN)) {
        const running = ((await service.call('export')).drafts[0]?.editorial.coverageSpec?.rounds || []).findIndex(round => round.status === 'running'), key = Math.max(0, running);
        if (!slept.has(key)) { slept.add(key); await sleep(2500); }
      }
      return complete(system, prompt, context);
    };
  };
  const { service, ids } = await library(t, { coverage: { roundLimit: 8, roundTimeoutMs: 6000 }, wrap: slowRounds });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), spec = draft.editorial.coverageSpec;
  assert.ok(Date.parse(spec.rounds[2].finishedAt) - Date.parse(spec.rounds[0].startedAt) > 6000, 'the run lasted longer than one round may');
  assert.ok(spec.rounds.every(round => round.ms >= 2400 && round.ms < 6000), JSON.stringify(spec.rounds.map(round => round.ms)));
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
  // This fixture copied a live service to simulate a crash. Its original producer
  // must finish its bookkeeping before the after hook removes that source folder.
  await settleJob(crashed.service, started.jobId);
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
  assert.equal(manual.actions.pause.available, true, 'a run that does not go on by itself pauses at its calls too');
  const interrupted = jobContract({ id: 'd', status: 'interrupted', retryable: true, coverageRun: { autoComplete: true, round: 2, rounds: 3, state: 'running', list: [] } });
  assert.equal(interrupted.actions.retry.available, true);
  assert.equal(jobContract({ id: 'e', status: 'interrupted', retryable: true }).actions.retry.available, true, 'a plain generation that kept a draft is continued too (the executor marks it retryable)');
  assert.equal(jobContract({ id: 'f', status: 'failed' }).actions.retry.reason.code, 'not-retryable', 'one that kept nothing to continue says why');
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
