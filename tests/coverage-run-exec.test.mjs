import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { reportUsage } from '../lib/usage-scope.js';
import { createRoundClock } from '../lib/contexts/generation/generate/round-clock.js';
import { listOf } from '../lib/contexts/generation/coverage-runs.js';
import { admitCall, holdClock, queuedRun, startParallel, stepBack } from '../lib/job-parallel.js';
import { jobContract } from '../lib/job-contract.js';
import { roundList, finishRound, FILL_ROUNDS, REPEAT_LIMIT } from '../lib/coverage-run.js';
import { settleJob, until, sleep } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { stuckRun, refusePlannerUntilFill } from './helpers/staggered-refusals.mjs';
import { pinStaged } from './helpers/staged-strategy.mjs';

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

const cleanup = new WeakMap();
function trackCleanup(t, root, service) {
  let entry = cleanup.get(t);
  if (!entry) {
    entry = { roots: new Set(), services: [] };
    cleanup.set(t, entry);
    t.after(async () => {
      for (const svc of [...entry.services].reverse()) await svc.dispose();
      for (const dir of entry.roots) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
  }
  if (root) entry.roots.add(root);
  if (service) entry.services.push(service);
}

let seedFilesPromise = null;
async function walkFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath, relPath));
    else files.push({ relPath, data: await readFile(fullPath) });
  }
  return files;
}

async function copySeedFiles(root, seedFiles) {
  const dirs = [...new Set(seedFiles.map(file => dirname(join(root, file.relPath))))];
  await Promise.all(dirs.map(dir => mkdir(dir, { recursive: true })));
  await Promise.all(seedFiles.map(file => writeFile(join(root, file.relPath), file.data)));
}

/** Seed world.sources once per process so each test starts from in-memory file copies instead of repeating 12 source.add calls. */
function ensureSeedFiles() {
  if (!seedFilesPromise) {
    seedFilesPromise = (async () => {
      const seedRoot = await mkdtemp(join(tmpdir(), 'study-coverage-seed-'));
      const service = new StudyService(seedRoot, { coverage: { roundLimit: 8 } });
      try {
        for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
        await service.dispose();
        const seedFiles = await walkFiles(seedRoot);
        return { seedFiles, ids: world.sources.map(source => source.id) };
      } finally {
        await rm(seedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    })();
  }
  return seedFilesPromise;
}

async function library(t, { coverage = { roundLimit: 8 }, model = clusteringModel(), wrap, root, weightOf, seed = true } = {}) {
  const customRoot = Boolean(root);
  root ||= await mkdtemp(join(tmpdir(), 'study-coverage-exec-'));
  trackCleanup(t, root, null);
  let ids = world.sources.map(source => source.id);
  if (seed) {
    if (!customRoot) {
      const seeded = await ensureSeedFiles();
      ids = seeded.ids;
      await copySeedFiles(root, seeded.seedFiles);
    } else {
      const prep = new StudyService(root, { coverage });
      try {
        for (const source of world.sources) await prep.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
      } finally {
        await prep.dispose();
      }
    }
  }
  const service = new StudyService(root, { coverage });
  await pinStaged(service);
  trackCleanup(t, root, service);
  service.complete = wrap ? wrap(model.complete, service) : model.complete;
  service.light = async (system, prompt) => {
    const evidence = JSON.parse(prompt.split('\n\n')[0]).sections;
    return JSON.stringify({ sections: evidence.map(item => ({ id: item.id, importance: weightOf?.(item) ?? 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  };
  return { service, model, root, ids };
}
const draftOf = async service => (await service.call('export')).drafts[0];
const contractOfJob = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.contract;
const statuses = draft => roundList(draft.editorial.coverageSpec).map(round => round.status);
const eventCodes = contract => contract.events.map(event => event.code);
/** Counts every model call the run makes, and holds nothing: what a pause must stop is the NEXT one. */
const counting = (complete, counter) => async (system, prompt, context = {}) => { counter.calls += 1; return complete(system, prompt, context); };

test('each round receives its whole time budget and a paused round keeps its remaining time', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const plan = {}, controller = new AbortController();
  const clock = createRoundClock({ job: {}, controller, plan, roundMs: 100 });
  for (let round = 0; round < 3; round++) {
    plan.t0 = Date.now();
    clock.restartMeasure();
    clock.arm();
    t.mock.timers.tick(75);
    assert.equal(clock.signal.aborted, false);
    assert.equal(clock.workedMs(), 75);
    clock.disarm();
  }
  plan.t0 = Date.now();
  clock.restartMeasure();
  clock.arm();
  t.mock.timers.tick(40);
  clock.hold();
  t.mock.timers.tick(1000);
  assert.equal(clock.workedMs(), 40);
  assert.equal(clock.idleMs(), 1000);
  assert.equal(clock.signal.aborted, false);
  clock.resume();
  t.mock.timers.tick(59);
  assert.equal(clock.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(clock.signal.reason.code, 'GENERATION_BUDGET');
  assert.equal(clock.workedMs(), 100);
  assert.equal(clock.idleMs(), 1000);
  assert.equal(clock.workedMs() + clock.idleMs(), Date.now() - plan.t0);
  assert.equal(controller.signal.aborted, false);
  clock.disarm();
});

test('coverage-run-exec flake-repro: sub-ms rounds and hold-lag drift flake legacy checks, hardened clock & listOf stay exact and catch bugs', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });

  // (a1)+(b1) Real sub-ms round through createRoundClock -> finishRound -> listOf:
  // when a fast mock round starts and finishes within the same millisecond, workedMs() returns 0.
  // Legacy `round.ms > 0` failed and legacy `round.ms ? { ms: round.ms } : {}` dropped `ms` to undefined;
  // hardened `listOf` preserves `ms: 0` while omitting `ms` on pending rounds.
  const subPlan = { t0: Date.now() };
  const subClock = createRoundClock({ job: {}, controller: new AbortController(), plan: subPlan, roundMs: 100 });
  subClock.restartMeasure();
  subClock.arm();
  const subWorkedMs = subClock.workedMs(); // 0 ms elapsed on fast round
  subClock.disarm();
  const spec = {
    rounds: [
      { round: 1, questions: 4, sectionIds: ['s1'], status: 'running', startedAt: new Date(Date.now()).toISOString() },
      { round: 2, questions: 4, sectionIds: ['s2'], status: 'pending' },
    ],
  };
  const finished = finishRound(spec, 0, {
    status: 'done',
    kept: 4,
    covered: 1,
    ms: subWorkedMs,
    at: new Date(Date.now()).toISOString(),
  });
  const projected = listOf(finished);
  assert.equal(roundList(finished)[0].ms, 0, 'sub-ms round produces 0 ms from createRoundClock.workedMs()');
  assert.equal(projected[0].ms, 0, 'listOf must preserve ms: 0 on finished sub-ms rounds');
  assert.ok(Number.isFinite(projected[0].ms) && projected[0].ms >= 0);
  assert.equal(projected[1].ms, undefined, 'pending rounds without recorded ms still omit ms');

  // (a2)+(b2) Real createRoundClock pause-exclusion under 5 ms onPaused microtask lag:
  // external observer stamps `since` 5 ms before `clock.hold()` fires, causing legacy `-2ms` drift
  // check to flake, while `createRoundClock` accounts workedMs + idleMs === totalElapsed with 0 ms error.
  const plan = { t0: Date.now() };
  const controller = new AbortController();
  const clock = createRoundClock({ job: {}, controller, plan, roundMs: 100 });
  clock.restartMeasure();
  clock.arm();
  t.mock.timers.tick(20);
  const externalSince = Date.now();
  t.mock.timers.tick(5); // 5 ms lag before clock.hold() runs
  clock.hold();
  t.mock.timers.tick(200);
  const externalIdleMs = Date.now() - externalSince; // 205 ms
  clock.resume();
  t.mock.timers.tick(20);
  const totalElapsed = Date.now() - plan.t0; // 245 ms
  const worked = clock.workedMs(); // 45 ms
  clock.disarm();
  assert.throws(
    () => assert.ok(totalElapsed - worked >= externalIdleMs - 2, `drift: ${totalElapsed - worked} < ${externalIdleMs - 2}`),
    /drift:/,
    'legacy external-Date.now() `-2ms` gate fails under 5 ms hold lag',
  );
  assert.equal(clock.idleMs(), 200);
  assert.equal(worked + clock.idleMs(), totalElapsed, 'workedMs + idleMs must equal total elapsed exactly');
  assert.equal(clock.signal.aborted, false, '200 ms pause did not consume the 100 ms round budget');

  // (c) Genuine clock regression: omitting hold() during a 200 ms pause leaks pause duration into workedMs
  // and trips GENERATION_BUDGET abort on the real createRoundClock.
  const brokenPlan = { t0: Date.now() };
  const brokenClock = createRoundClock({ job: {}, controller: new AbortController(), plan: brokenPlan, roundMs: 100 });
  brokenClock.restartMeasure();
  brokenClock.arm();
  t.mock.timers.tick(20);
  // Missing brokenClock.hold() -> pause duration consumes budget and leaks into workedMs
  t.mock.timers.tick(200);
  assert.equal(brokenClock.signal.aborted, true, 'failing to hold the clock during a pause must trip budget abort');
  assert.equal(brokenClock.signal.reason.code, 'GENERATION_BUDGET');
  assert.equal(brokenClock.idleMs(), 0, 'broken clock failed to account for idle time');
  assert.ok(brokenClock.workedMs() > 100, 'broken clock leaked pause duration into workedMs');
  brokenClock.disarm();
});

test('a round that begins while the clock is held counts its time from its own start: the wait before it and the hold after it are not worked time', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const plan = { t0: Date.now() }, controller = new AbortController();
  const clock = createRoundClock({ job: {}, controller, plan, roundMs: 10_000 });
  clock.restartMeasure();
  clock.arm();
  t.mock.timers.tick(100);
  clock.hold(); // the queue holds the job as its last call ends
  t.mock.timers.tick(5); // the round settles while held
  plan.t0 = Date.now();
  clock.restartMeasure(); // the next round begins, still held
  t.mock.timers.tick(500);
  assert.equal(clock.workedMs(), 0, 'nothing ran since the round began');
  assert.equal(clock.idleMs(), 500, 'the round has stood still since it began; the 5 ms before it belong to the round before');
  clock.resume();
  t.mock.timers.tick(10);
  assert.equal(clock.workedMs(), 10, 'the 500 ms the round was held are not worked time');
  assert.equal(clock.idleMs(), 500);
  assert.equal(clock.workedMs() + clock.idleMs(), Date.now() - plan.t0);
  clock.disarm();
});

test('a round that begins while the clock runs starts with no idle time, even when the round before it was paused', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const plan = { t0: Date.now() }, controller = new AbortController();
  const clock = createRoundClock({ job: {}, controller, plan, roundMs: 10_000 });
  clock.restartMeasure();
  clock.arm();
  t.mock.timers.tick(30);
  clock.hold();
  t.mock.timers.tick(50);
  clock.resume();
  t.mock.timers.tick(5);
  plan.t0 = Date.now();
  clock.restartMeasure();
  t.mock.timers.tick(20);
  assert.equal(clock.idleMs(), 0, 'the pause of the round before is not this round\'s');
  assert.equal(clock.workedMs(), 20);
  assert.equal(clock.workedMs() + clock.idleMs(), Date.now() - plan.t0);
  clock.disarm();
});

test('through the library queue: a round that begins while its job is held (sent back after a rate limit) records only the time it worked after the hold', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const job = { id: `round-clock-held-${process.pid}-${Date.now()}`, root: 'round-clock-held', status: 'running', parallel: true };
  queuedRun(job, async () => {});
  const plan = { t0: Date.now() }, controller = new AbortController();
  const clock = createRoundClock({ job, controller, plan, roundMs: 10_000 });
  clock.restartMeasure();
  clock.arm();
  // The executor's wiring (lib/contexts/generation/generate/execute.js startClocks).
  const letGo = holdClock(job, { stop: () => clock.hold(), resume: () => clock.resume() });
  const leave = admitCall(job, controller.signal);
  t.mock.timers.tick(100);
  assert.deepEqual(stepBack(new Map([[job.id, job]]), job, Object.assign(new Error('Too Many Requests'), { status: 429 })), [job.id]);
  leave(); // the last call in flight ends: the queue freezes the clock
  t.mock.timers.tick(5);
  plan.t0 = Date.now();
  clock.restartMeasure(); // round-begin.js measureFrom, while still held
  t.mock.timers.tick(500);
  startParallel(job); // the hold ends: the queue thaws the clock
  t.mock.timers.tick(10);
  assert.equal(clock.workedMs(), 10, `the round worked 10 ms after a 500 ms hold, recorded ${clock.workedMs()} ms`);
  assert.equal(clock.idleMs(), 500);
  letGo();
  clock.disarm();
});

describe('coverage run executor', { concurrency: 3 }, () => {

test('the executor records each completed round and ends a stalled round at its budget', async t => {
  // Every model call takes at least MODEL_MS, so every round has worked time to record: a round that records 0 ms is a bug, not a fast machine.
  const MODEL_MS = 5;
  const { service, ids } = await library(t, { wrap: complete => async (...args) => { await sleep(MODEL_MS); return complete(...args); } });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const rounds = roundList((await draftOf(service)).editorial.coverageSpec);
  assert.deepEqual(rounds.map(round => round.status), ['done', 'done', 'done']);
  for (const round of rounds) {
    assert.ok(Number.isFinite(round.ms) && round.ms >= 0, `round ${round.round} must record non-negative finite ms, got ${round.ms}`);
    const span = Date.parse(round.finishedAt) - Date.parse(round.startedAt);
    assert.ok(span >= 0 && round.ms <= span, `round ${round.round} worked ${round.ms}ms must be within wall span ${span}ms`);
    assert.ok(round.ms > 0, `round ${round.round} called the model (>= ${MODEL_MS} ms a call) and must record its worked time, got ${round.ms}ms`);
  }
  const completedContract = await contractOfJob(service, started.jobId);
  assert.ok(
    completedContract.detail.run.list.every(row => Number.isFinite(row.ms) && row.ms >= 0),
    'projected run list must preserve round ms (including 0 ms sub-ms rounds)',
  );
  const stuck = await library(t, { coverage: { roundLimit: 8, roundTimeoutMs: 300 }, wrap: complete => async (system, prompt, context = {}) => {
    if (system.startsWith(PLAN) && context.signal) {
      if (context.signal.aborted) throw context.signal.reason;
      await new Promise((_, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }); });
    }
    return complete(system, prompt, context);
  } });
  const startedStuck = await stuck.service.call('generate', { sourceIds: stuck.ids, coverageLevel: 'standard', kind: 'quiz' });
  const ended = await settleJob(stuck.service, startedStuck.jobId, { timeoutMs: 20_000 });
  assert.equal(ended.status, 'failed', 'a round that never answers ends the job at the round limit');
  assert.match(ended.stage, /round|轮|budget/i);
});

test('the executor excludes a confirmed pause from the time recorded for the round', async (t) => {
  const hold = gate();
  const { service, ids } = await library(t, { wrap: complete => gated({ complete }, { at: 1, hold }).complete });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  await until(() => hold.entered, 'round 1 to be in flight');
  await service.call('job.control', { jobId: started.jobId, action: 'pause' });
  hold.open();
  await until(async () => (await contractOfJob(service, started.jobId)).status === 'paused', 'the pause to be reached');
  // `onPaused` -> `clock.hold()` runs on a microtask after `job.pausedAt` is stamped (lib/job-control.js);
  // yield one macrotask turn so `clock.hold()` is strictly ordered before measuring the pause window.
  await new Promise(resolve => setImmediate(resolve));
  const since = Date.now();
  await sleep(200);
  const pauseWindowMs = Date.now() - since;
  await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', `the round must not have timed out while paused: ${job.stage}`);
  const rounds = roundList((await draftOf(service)).editorial.coverageSpec);
  assert.deepEqual(rounds.map(round => round.status), ['done', 'done', 'done']);
  const elapsed = Date.parse(rounds[0].finishedAt) - Date.parse(rounds[0].startedAt);
  assert.ok(Number.isFinite(rounds[0].ms) && rounds[0].ms >= 0);
  assert.ok(
    elapsed - rounds[0].ms >= pauseWindowMs,
    `the saved round took ${elapsed}ms including ${pauseWindowMs}ms confirmed pause, and reported ${rounds[0].ms}ms worked`,
  );
});

test('a round larger than the 30 questions of a production round is accepted when the seam says so: the button of a manual run is not refused by a limit the plan did not use', async (t) => {
  const big = mergedTranscript();
  const root = await mkdtemp(join(tmpdir(), 'study-coverage-limit-'));
  const service = new StudyService(root, { coverage: { roundLimit: 40 } });
  await pinStaged(service);
  trackCleanup(t, root, service);
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
  // Deterministic barrier per cycle replaces hardcoded sleep(40)/sleep(80) so all 3 pause/resume
  // cycles reliably execute without racing round completion under load.
  let armedGate = gate();
  let activeGate = armedGate;
  const { service, ids } = await library(t, {
    wrap: complete => counting(async (system, prompt, context) => {
      if (armedGate) {
        const hold = armedGate;
        armedGate = null;
        hold.entered = true;
        await hold.promise;
      }
      return complete(system, prompt, context);
    }, counter),
  });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  let pausesReached = 0;
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await until(() => activeGate.entered, `model call to reach barrier for pause ${cycle}`);
    await service.call('job.control', { jobId: started.jobId, action: 'pause' });
    assert.equal((await contractOfJob(service, started.jobId)).status, 'pausing', `cycle ${cycle}: waiting for in-flight call`);
    activeGate.open();
    await until(async () => (await contractOfJob(service, started.jobId)).status === 'paused', `pause ${cycle} to be reached`);
    pausesReached += 1;
    const frozen = counter.calls;
    for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(counter.calls, frozen, `nothing starts during pause ${cycle}`);
    assert.equal((await contractOfJob(service, started.jobId)).status, 'paused');
    if (cycle < 3) {
      activeGate = gate();
      armedGate = activeGate;
    }
    await service.call('job.control', { jobId: started.jobId, action: 'resume' });
  }
  assert.equal(pausesReached, 3, 'all three pause/resume cycles must execute');
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.deepEqual(statuses(await draftOf(service)), ['done', 'done', 'done']);
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
  trackCleanup(t, null, reopened);
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

});
