import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';
import { legacyModels } from '../lib/contexts/generation/jobs/legacy-model.js';
import { pressureCause, workClock, clockSource } from '../lib/job-parallel.js';
import { loadUi } from './helpers/ui-module.mjs';
import { stagedModel } from './helpers/generation-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { until, settleJob, sleep } from './helpers/wait.mjs';

/* 3.0.2 要求并行: a queued job of the question family can be started beside the job ahead of it (`job.parallel`); a model error under pressure sends the parallel jobs
   back to the queue first, and they go on by themselves when the chain reaches them. Fake models only, with the timing under the test's hand. */

const soon = (condition, what) => until(condition, what, { timeoutMs: 60_000 });
const stageOf = system => (system.startsWith('Plan a source-grounded') ? 'plan' : system.startsWith('Prepare supported answers') ? 'blueprint' : system.startsWith('Act as a strict') ? 'review' : 'author');
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open, entered: false }; };
const rateLimit = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });
const refused = () => Object.assign(new Error('The API key was refused'), { code: 'INVALID_CREDENTIAL', status: 401 });

/** A model with the timing under the test's hand: `hold(jobId, stage)` stops the first such call at the model until it is opened, `fail(jobId, stage, error)` makes the first such call fail. */
function lab() {
  const staged = stagedModel(), calls = [], holds = [], fails = [], inflight = new Map();
  const complete = async (system, prompt, options = {}) => {
    const stage = stageOf(system), job = options.jobId;
    calls.push({ job, stage });
    inflight.set(job, (inflight.get(job) || 0) + 1);
    try {
      if (system.startsWith('Repair one draft card')) return JSON.stringify({ card: { ...JSON.parse(prompt).card, explanation: 'Fixed: the evidence ties angle 0 to design and later change.' } });
      const fail = fails.find(item => !item.used && item.job === job && item.stage === stage);
      if (fail) { fail.used = true; throw fail.error; }
      const hold = holds.find(item => !item.entered && (item.job === undefined || item.job === job) && item.stage === stage);
      if (hold) { hold.entered = true; await hold.promise; }
      options.signal?.throwIfAborted();
      return await staged.complete(system, prompt, options);
    } finally { inflight.set(job, inflight.get(job) - 1); }
  };
  return { complete, calls, inflight: job => inflight.get(job) || 0, callsOf: job => calls.filter(item => item.job === job).map(item => item.stage),
    openAll() { for (const item of holds) item.open(); },
    hold(job, stage) { const item = Object.assign(gate(), { job, stage }); holds.push(item); return item; },
    fail(job, stage, error) { fails.push({ job, stage, error }); } };
}

async function library(t, mode = 'legacy') {
  const model = lab(), root = await mkdtemp(join(tmpdir(), 'study-parallel-'));
  const runtime = createStudyRuntime(root, { complete: model.complete, ...switchOptions(mode, { complete: model.complete, paths: ['generation'] }) });
  t.after(async () => { model.openAll(); await runtime.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await new Store(root).update(state => { state.decks.push({ id: 'd', title: 'Architecture basics', cards: [{ id: 'old', kind: 'flashcard', objective: 'Original objective', prompt: 'Original question?', answer: 'Original' }] }); });
  for (const [id, text] of [['s1', 'Architecture sets principles that guide how a system is designed and changed.'], ['s2', 'Caching keeps recent answers close so repeated questions cost less time.'],
    ['s3', 'Queues let producers and consumers work at their own pace without waiting on each other.']]) await runtime.call('source.add', { id, title: id, text });
  const generate = source => runtime.call('generate', { sourceIds: [source], count: 1, kind: 'flashcard' });
  const jobs = async () => (await runtime.call('snapshot')).jobs;
  const job = async id => (await jobs()).find(item => item.id === id);
  const status = async id => (await job(id))?.status;
  return { runtime, model, generate, jobs, job, status, root };
}

test('by default a second job waits for the first: nothing is asked of the model until the one ahead is over', async t => {
  const { model, generate, status, runtime } = await library(t);
  const a = await generate('s1');
  const hold = model.hold(a.jobId, 'plan');
  const b = await generate('s2');
  await soon(() => hold.entered, 'the first job at the model');
  assert.equal(b.status, 'queued');
  assert.equal(b.queuedBehind, 1);
  await sleep(150);
  assert.deepEqual(model.callsOf(b.jobId), [], 'the queued job has asked nothing');
  assert.equal(await status(b.jobId), 'queued');
  hold.open();
  assert.equal((await settleJob(runtime, a.jobId)).status, 'complete');
  assert.equal((await settleJob(runtime, b.jobId)).status, 'complete');
});

test('job.parallel starts the queued job at once, beside the first; both finish, with the same result as serial runs', async t => {
  const { model, generate, job, runtime } = await library(t);
  const a = await generate('s1');
  const holdA = model.hold(a.jobId, 'plan');
  const b = await generate('s2');
  // The parallel job is held at its review call too: it must still be running (not over) when the card is read, however fast the machine is.
  const holdB = model.hold(b.jobId, 'review');
  await soon(() => holdA.entered, 'the first job at the model');
  const before = await job(b.jobId);
  assert.equal(before.contract.actions.parallel.available, true, 'a queued job offers 要求并行');
  assert.equal(before.contract.detail.queue.head.jobId, a.jobId, 'the console can name the job it waits behind');
  const reply = await runtime.call('job.parallel', { jobId: b.jobId });
  assert.equal(reply.jobId, b.jobId);
  assert.equal(reply.parallel, true);
  await soon(() => holdB.entered, 'the parallel job to run on while the first is held');
  assert.equal((await job(b.jobId)).contract.detail.parallel.at, (await job(b.jobId)).parallelAt, 'the card says it runs beside the queue, since when');
  assert.equal((await job(a.jobId)).status, 'running');
  assert.equal((await job(b.jobId)).contract.actions.parallel.available, false);
  assert.equal((await job(b.jobId)).contract.actions.parallel.reason.code, 'already-parallel');
  holdB.open();
  holdA.open();
  const endedA = await settleJob(runtime, a.jobId), endedB = await settleJob(runtime, b.jobId);
  assert.deepEqual([endedA.status, endedB.status], ['complete', 'complete']);
  const serial = await library(t);
  const first = await serial.generate('s1'), second = await serial.generate('s2');
  await settleJob(serial.runtime, first.jobId); await settleJob(serial.runtime, second.jobId);
  const cards = async (rt, jobId) => (await rt.call('draft.get', { id: (await rt.call('job.status', { jobId })).draftId })).cards.map(card => card.kind);
  assert.deepEqual(await cards(runtime, b.jobId), await cards(serial.runtime, second.jobId), 'the parallel run wrote what the serial run wrote');
  assert.equal((await job(b.jobId)).parallel, undefined, 'once it is over the mark is gone');
});

test('a job submitted later waits for the parallel job too: at most one job that did not ask for it runs at a time', async t => {
  const { model, generate, job, runtime } = await library(t);
  const a = await generate('s1'), holdA = model.hold(a.jobId, 'plan');
  const b = await generate('s2'), holdB = model.hold(b.jobId, 'blueprint');
  await soon(() => holdA.entered, 'the first job at the model');
  await runtime.call('job.parallel', { jobId: b.jobId });
  await soon(() => holdB.entered, 'the parallel job at its second call');
  const c = await generate('s3');
  assert.equal(c.status, 'queued');
  holdA.open();
  assert.equal((await settleJob(runtime, a.jobId)).status, 'complete');
  await sleep(200);
  assert.deepEqual(model.callsOf(c.jobId), [], 'the third job still waits: the parallel job is not over');
  assert.equal((await job(c.jobId)).status, 'queued');
  holdB.open();
  for (const id of [b.jobId, c.jobId]) assert.equal((await settleJob(runtime, id)).status, 'complete');
  // The jobs that did not ask for parallel (a and c) were never at the model together.
  const order = model.calls.filter(item => [a.jobId, c.jobId].includes(item.job)).map(item => item.job);
  assert.ok(order.lastIndexOf(a.jobId) < order.indexOf(c.jobId), 'job c asked nothing before job a had finished');
});

test('job.parallel is refused, in plain words, for a job that is not queued, not of a kind that can, or unknown', async t => {
  const { model, generate, runtime } = await library(t);
  const a = await generate('s1'), hold = model.hold(a.jobId, 'plan');
  await soon(() => hold.entered, 'the first job at the model');
  await assert.rejects(runtime.call('job.parallel', { jobId: a.jobId }), error => error.code === 'not-queued' && /已经开始/.test(error.message));
  await assert.rejects(runtime.call('job.parallel', { jobId: 'nobody' }), /not found/);
  runtime.work.jobs.set('audio-1', { id: 'audio-1', root: runtime.work.jobs.get(a.jobId).root, type: 'audio-import', status: 'queued', startedAt: new Date().toISOString() });
  await assert.rejects(runtime.call('job.parallel', { jobId: 'audio-1' }), error => error.code === 'capability-unsupported' && /不支持并行/.test(error.message));
  runtime.work.jobs.set('foreign', { id: 'foreign', root: 'another-library', status: 'queued', startedAt: new Date().toISOString() });
  await assert.rejects(runtime.call('job.parallel', { jobId: 'foreign' }), /not found/, 'a job of another library is not this library\'s to start');
  hold.open();
  await settleJob(runtime, a.jobId);
  await assert.rejects(runtime.call('job.parallel', { jobId: a.jobId }), error => error.code === 'job-ended');
});

test('job.parallel is refused for a job that writes what an active job writes, naming that job', async t => {
  const { model, job, runtime } = await library(t);
  const first = await runtime.call('supplement', { sourceIds: ['s1'], deckId: 'd', count: 1, kind: 'flashcard' });
  const hold = model.hold(first.jobId, 'plan');
  await soon(() => hold.entered, 'the first supplement at the model');
  const second = await runtime.call('supplement', { sourceIds: ['s2'], deckId: 'd', count: 1, kind: 'flashcard' });
  assert.equal(second.status, 'queued');
  const view = await job(second.jobId);
  assert.equal(view.contract.actions.parallel.available, false);
  assert.equal(view.contract.actions.parallel.reason.code, 'target-busy');
  assert.equal(view.contract.actions.parallel.reason.by.jobId, first.jobId, 'the contract says which job is in the way');
  await assert.rejects(runtime.call('job.parallel', { jobId: second.jobId }), error => error.code === 'target-busy' && error.message.includes('Architecture basics'));
  assert.deepEqual(model.callsOf(second.jobId), [], 'a refused request starts nothing');
  hold.open();
  await settleJob(runtime, first.jobId); await settleJob(runtime, second.jobId);
});

test('a rate limit in the job that did not ask for parallel sends the parallel job back to the queue first; it goes on by itself when the first job is over', async t => {
  const { model, generate, job, runtime } = await library(t);
  const a = await generate('s1'), holdA = model.hold(a.jobId, 'plan');
  const b = await generate('s2'), holdB = model.hold(b.jobId, 'plan');
  await soon(() => holdA.entered, 'the first job at the model');
  await runtime.call('job.parallel', { jobId: b.jobId });
  await soon(() => holdB.entered, 'the parallel job at its first call');
  model.fail(a.jobId, 'blueprint', rateLimit());
  holdA.open();
  await soon(async () => (await job(b.jobId)).status === 'queued', 'the parallel job to be sent back');
  const sent = await job(b.jobId);
  assert.equal(sent.parallel, undefined, 'it is no longer parallel');
  assert.equal(sent.contract.status, 'queued');
  assert.equal(sent.contract.detail.requeued.cause, 'rate-limit');
  assert.equal(sent.contract.detail.requeued.by, a.jobId);
  assert.equal(sent.contract.actions.parallel.available, true, 'the learner may ask again');
  assert.ok(sent.contract.actions.parallel.afterError, 'and is told it was just stepped back');
  const requeued = sent.contract.events.find(event => event.code === 'parallel-requeued');
  assert.ok(requeued, 'the log says so');
  assert.equal(requeued.args.by, a.jobId);
  const throttled = (await job(a.jobId)).contract.events.find(event => event.code === 'throttle' && event.args.reason === 'rate-limit');
  if (throttled) assert.ok(Date.parse(requeued.at) <= Date.parse(throttled.at), 'the parallel job stepped back before the failing job slowed down');
  // The call that was in flight finishes; no new call starts while it is held.
  holdB.open();
  await soon(() => model.inflight(b.jobId) === 0, 'the call in flight to finish');
  await sleep(250);
  assert.deepEqual(model.callsOf(b.jobId), ['plan'], 'a held job admits no new call');
  assert.equal((await job(b.jobId)).status, 'queued');
  const endedA = await settleJob(runtime, a.jobId);
  assert.equal(endedA.status, 'complete');
  const endedB = await settleJob(runtime, b.jobId);
  assert.equal(endedB.status, 'complete', 'it resumed by itself when the first job was over');
  const resumed = (await job(b.jobId)).contract.events.find(event => event.code === 'parallel-resumed');
  assert.ok(resumed, 'the log says it went on');
  assert.equal((await job(b.jobId)).contract.detail.requeued, undefined);
});

test('a rate limit in the parallel job itself sends it back to the queue, and it finishes after the first job', async t => {
  const { model, generate, job, runtime } = await library(t);
  const a = await generate('s1'), holdA = model.hold(a.jobId, 'plan');
  const b = await generate('s2');
  await soon(() => holdA.entered, 'the first job at the model');
  model.fail(b.jobId, 'blueprint', rateLimit());
  await runtime.call('job.parallel', { jobId: b.jobId });
  await soon(async () => (await job(b.jobId)).contract.detail.requeued?.cause === 'rate-limit', 'the parallel job to be sent back');
  assert.equal((await job(b.jobId)).status, 'queued');
  assert.equal((await job(b.jobId)).contract.detail.requeued.by, b.jobId);
  await sleep(400);
  assert.deepEqual(model.callsOf(b.jobId), ['plan', 'blueprint'], 'its retry waits in the queue');
  holdA.open();
  assert.equal((await settleJob(runtime, a.jobId)).status, 'complete');
  assert.equal((await settleJob(runtime, b.jobId)).status, 'complete');
});

test('a failure that is not pressure (a refused key) sends nobody back', async t => {
  const { model, generate, job, runtime } = await library(t);
  const a = await generate('s1'), holdA = model.hold(a.jobId, 'plan');
  const b = await generate('s2'), holdB = model.hold(b.jobId, 'plan');
  await soon(() => holdA.entered, 'the first job at the model');
  await runtime.call('job.parallel', { jobId: b.jobId });
  await soon(() => holdB.entered, 'the parallel job at its first call');
  model.fail(a.jobId, 'blueprint', refused());
  holdA.open();
  assert.equal((await settleJob(runtime, a.jobId)).status, 'failed');
  assert.equal((await job(b.jobId)).contract.detail.requeued, undefined);
  assert.equal((await job(b.jobId)).status, 'running', 'the parallel job is where it was');
  holdB.open();
  assert.equal((await settleJob(runtime, b.jobId)).status, 'complete');
  assert.equal((await job(b.jobId)).contract.events.some(event => event.code === 'parallel-requeued'), false);
});

test('a job can be stopped while it is held in the queue', async t => {
  const { model, generate, job, runtime } = await library(t);
  const a = await generate('s1'), holdA = model.hold(a.jobId, 'plan');
  const b = await generate('s2'), holdB = model.hold(b.jobId, 'plan');
  await soon(() => holdA.entered, 'the first job at the model');
  await runtime.call('job.parallel', { jobId: b.jobId });
  await soon(() => holdB.entered, 'the parallel job at its first call');
  model.fail(a.jobId, 'blueprint', rateLimit());
  holdA.open();
  await soon(async () => (await job(b.jobId)).contract.detail.requeued, 'the parallel job to be sent back');
  holdB.open();
  await soon(() => model.inflight(b.jobId) === 0, 'the call in flight to finish');
  await runtime.call('job.control', { jobId: b.jobId, action: 'cancel' });
  assert.equal((await settleJob(runtime, b.jobId)).status, 'cancelled');
  assert.deepEqual(model.callsOf(b.jobId), ['plan'], 'nothing was asked after the stop');
  assert.equal((await settleJob(runtime, a.jobId)).status, 'complete', 'the first job is not affected');
});

test('a held job can be made parallel again: it goes on beside the first job', async t => {
  const { model, generate, job, runtime } = await library(t);
  const a = await generate('s1'), holdA = model.hold(a.jobId, 'plan');
  const b = await generate('s2');
  await soon(() => holdA.entered, 'the first job at the model');
  model.fail(b.jobId, 'blueprint', rateLimit());
  await runtime.call('job.parallel', { jobId: b.jobId });
  await soon(async () => (await job(b.jobId)).contract.detail.requeued, 'the parallel job to be sent back');
  await runtime.call('job.parallel', { jobId: b.jobId });
  assert.equal((await job(b.jobId)).parallel, true);
  assert.equal((await job(b.jobId)).contract.detail.requeued, undefined);
  await soon(() => model.callsOf(b.jobId).includes('review'), 'the job to go on while the first is still held');
  assert.equal((await job(a.jobId)).status, 'running');
  holdA.open();
  assert.equal((await settleJob(runtime, a.jobId)).status, 'complete');
  assert.equal((await settleJob(runtime, b.jobId)).status, 'complete');
});

test('a queued background repair can be started beside the job ahead too', async t => {
  const { model, generate, job, runtime } = await library(t);
  const text = 'Architecture sets principles that guide how a system is designed and changed.';
  const saved = await runtime.call('draft.save', { deck: { id: 'fix', title: 'To repair', editorial: { generation: { sourceIds: ['s1'], kind: 'flashcard' }, rejectedIssues: { r1: ['explanationQuality failed'] } },
    cards: [{ id: 'r1', kind: 'flashcard', topic: 'Architecture', objective: 'Explain principle 2', prompt: 'What guides design question 2?', answer: 'Principles.', hint: 'Constraints.', explanation: 'Weak.', misconception: 'Only parts matter.', citations: [{ sourceId: 's1', quote: text }] }] } });
  const a = await generate('s2'), holdA = model.hold(a.jobId, 'plan');
  await soon(() => holdA.entered, 'the first job at the model');
  const repair = await runtime.call('draft.repair', { id: 'fix', draftVersion: saved.draftVersion });
  assert.equal(repair.status, 'queued');
  assert.equal((await job(repair.jobId)).contract.actions.parallel.available, true, JSON.stringify((await job(repair.jobId)).contract.actions.parallel));
  await runtime.call('job.parallel', { jobId: repair.jobId });
  assert.equal((await settleJob(runtime, repair.jobId)).status, 'complete', 'the repair ran while the first job was still held');
  assert.equal((await job(a.jobId)).status, 'running');
  holdA.open();
  assert.equal((await settleJob(runtime, a.jobId)).status, 'complete');
});

test('with the unified runtime on for generation, a queued job is the runtime\'s: job.parallel is refused and the contract offers nothing', async t => {
  const { model, generate, job, runtime } = await library(t, 'runtime');
  const hold = model.hold(undefined, 'plan'), a = await generate('s1');
  await soon(() => hold.entered, 'the first job at the model');
  const b = await generate('s2');
  assert.equal(b.status, 'queued');
  assert.equal((await job(b.jobId)).contract.actions.parallel, undefined, 'a contract of the runtime has no 要求并行');
  await assert.rejects(runtime.call('job.parallel', { jobId: b.jobId }), error => error.code === 'runtime-owned' && /统一任务运行时/.test(error.message));
  hold.open();
  await settleJob(runtime, a.jobId); await settleJob(runtime, b.jobId);
});

test('audio imports and PDF conversions are counted in `queuedBehind`, but they are not in the library queue: the job runs at once', async t => {
  const { model, generate, job, runtime } = await library(t);
  const root = [...runtime.work.jobs.values()][0]?.root ?? (await generate('s1'), [...runtime.work.jobs.values()][0].root);
  for (const [id, type] of [['audio-1', 'audio-import'], ['pdf-1', 'pdf-convert']]) runtime.work.jobs.set(id, { id, root, type, status: 'running', startedAt: new Date().toISOString() });
  const reply = await generate('s2');
  assert.equal(reply.queuedBehind >= 2, true, 'the number counts every active job of the library, audio and PDF included');
  assert.equal(reply.status, 'queued', 'the receipt says queued');
  await soon(() => model.callsOf(reply.jobId).length > 0, 'the job to ask the model without anything being released');
  assert.notEqual((await job(reply.jobId)).status, 'queued', 'the audio and PDF jobs do not hold the chain: the job is running');
  runtime.work.jobs.delete('audio-1'); runtime.work.jobs.delete('pdf-1');
  await settleJob(runtime, reply.jobId);
});

/* The time limit is the time a run WORKS: a job held in the queue does not spend it. The budget clocks read `clockSource`, so a test can move time by hand. */
function fakeClock(t) {
  const timers = new Set(), saved = { ...clockSource };
  let now = 0;
  Object.assign(clockSource, {
    now: () => now,
    // Only the long budget timers are the test's; anything shorter stays real.
    setTimeout: (fn, ms) => { if (ms < 60_000) return saved.setTimeout(fn, ms); const timer = { fn, at: now + ms, ms }; timers.add(timer); return timer; },
    clearTimeout: handle => { if (!timers.delete(handle)) saved.clearTimeout(handle); },
  });
  t.after(() => Object.assign(clockSource, saved));
  return { pending: () => [...timers], advance(ms) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.fn(); } } };
}

test('a work clock stops while its job is held and goes on with what was left', t => {
  const clock = fakeClock(t), fired = [], work = workClock({ id: 'unit-clock' }, 100_000, () => fired.push('expired'));
  clock.advance(40_000);
  assert.equal(clock.pending().length, 1);
  work.stop();
  assert.equal(clock.pending().length, 0, 'a stopped clock has no timer');
  clock.advance(3_600_000);
  assert.deepEqual(fired, [], 'nothing expires while it stands still');
  work.resume();
  assert.equal(clock.pending()[0].ms, 60_000, 'it goes on with the 60 s that were left');
  clock.advance(59_000);
  assert.deepEqual(fired, []);
  clock.advance(1_000);
  assert.deepEqual(fired, ['expired']);
  work.stop(); work.resume(); work.clear();
  assert.equal(clock.pending().length, 0, 'an expired or cleared clock stays quiet');
});

test('a job held longer than its time limit still completes after it goes on; its held time is recorded and its clock stood still', async t => {
  const clock = fakeClock(t);
  const { model, generate, job, runtime } = await library(t);
  const a = await runtime.call('generate', { sourceIds: ['s1'], count: 1, kind: 'flashcard', performance: { jobTimeoutMinutes: 180 } }), holdA = model.hold(a.jobId, 'plan'), holdReview = model.hold(a.jobId, 'review');
  const b = await generate('s2'), holdB = model.hold(b.jobId, 'plan');
  await soon(() => holdA.entered, 'the first job at the model');
  await runtime.call('job.parallel', { jobId: b.jobId });
  await soon(() => holdB.entered, 'the parallel job at its first call');
  const own = () => clock.pending().filter(timer => timer.ms === 20 * 60 * 1000), hers = () => clock.pending().filter(timer => timer.ms === 180 * 60 * 1000);
  assert.equal(own().length + hers().length, 2, 'both plain runs have their clock running');
  model.fail(a.jobId, 'blueprint', rateLimit());
  holdA.open();
  await soon(async () => (await job(b.jobId)).contract.detail.requeued, 'the parallel job to be sent back');
  assert.equal(own().length, 1, 'its call is still in flight, so it is still working: the clock runs until the last call ends');
  holdB.open();
  await soon(() => model.inflight(b.jobId) === 0, 'the call in flight to finish');
  await soon(() => own().length === 0, 'its clock to stand still once nothing is in flight');
  clock.advance(2 * 3_600_000);
  assert.equal((await job(b.jobId)).status, 'queued', 'two hours in the queue did not end it by its limit');
  holdReview.open();
  await settleJob(runtime, a.jobId);
  const ended = await settleJob(runtime, b.jobId);
  assert.equal(ended.status, 'complete', 'after the hold it finished instead of being stopped by a limit that ran meanwhile');
  const view = await job(b.jobId);
  assert.ok(view.contract.detail.heldMs > 0, 'the held time is in the contract, to be subtracted from 已用');
  assert.equal(view.contract.events.some(event => /budget/i.test(event.text || '')), false);
});

test('已用 does not count the time a job was held', async () => {
  const m = await loadUi(`export { elapsedMs } from './ui/tasks/task-facts.js';`);
  const contract = { status: 'running', startedAt: '2026-10-08T10:00:00.000Z', detail: { runStartedAt: '2026-10-08T10:00:00.000Z', heldMs: 600_000 } };
  assert.equal(m.elapsedMs(contract, true, Date.parse('2026-10-08T10:30:00.000Z')), 1_200_000, '30 minutes since it began, 10 of them held');
  assert.equal(m.elapsedMs({ ...contract, detail: { runStartedAt: contract.detail.runStartedAt } }, true, Date.parse('2026-10-08T10:30:00.000Z')), 1_800_000);
  assert.equal(m.elapsedMs({ ...contract, status: 'complete', finishedAt: '2026-10-08T10:20:00.000Z' }, false, Date.parse('2026-10-08T12:00:00.000Z')), 600_000);
});

test('pressure is a rate limit, an overload or a timeout; a refused key, a stop or an ordinary error is not', () => {
  assert.equal(pressureCause(rateLimit()), 'rate-limit');
  assert.equal(pressureCause(Object.assign(new Error('x'), { code: 'RATE_LIMIT' })), 'rate-limit');
  assert.equal(pressureCause(Object.assign(new Error('Service Unavailable'), { status: 503 })), 'overloaded');
  assert.equal(pressureCause(Object.assign(new Error('overloaded_error'), { status: 529 })), 'overloaded');
  assert.equal(pressureCause(Object.assign(new Error('Model timed out after 600s'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(pressureCause(Object.assign(new Error('gateway'), { status: 504 })), 'timeout');
  assert.equal(pressureCause(refused()), null);
  assert.equal(pressureCause(Object.assign(new Error('quota'), { code: 'QUOTA' })), null);
  assert.equal(pressureCause(Object.assign(new Error('aborted'), { name: 'AbortError' })), null);
  assert.equal(pressureCause(new Error('Model returned unparseable JSON')), null);
  assert.equal(pressureCause(null), null);
});

test('the model adapter tells the library about pressure before the error leaves it', async () => {
  const job = { id: 'j', steps: [] }, seen = [];
  const models = legacyModels({ job, control: { values: {} }, performance: {}, feature: 'generate', outputs: { open() {}, append() {}, close() {}, reasoning() {} }, messengers: new Map(),
    ask: async () => { throw rateLimit(); }, onPressure: error => seen.push(error.status) });
  let told = 0;
  await models.call('s', 'p', { stage: 'x', signal: new AbortController().signal }).catch(() => { told = seen.length; });
  assert.equal(told, 1, 'onPressure had run when the caller saw the error');
  const quiet = [];
  const refusedModels = legacyModels({ job: { id: 'k', steps: [] }, control: { values: {} }, performance: {}, feature: 'generate', outputs: { open() {}, append() {}, close() {}, reasoning() {} }, messengers: new Map(),
    ask: async () => { throw refused(); }, onPressure: error => quiet.push(error) });
  await refusedModels.call('s', 'p', { stage: 'x', signal: new AbortController().signal }).catch(() => {});
  assert.deepEqual(quiet, [], 'a refused key is not pressure');
});
