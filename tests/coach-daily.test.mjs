import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
import { dayOf, coachDailyLedger, DAILY } from '../lib/coach-daily.js';

// #234 為你定制: the day's variant preparation is ONE row of the 任务 console per day (not one per batch): its batches, its metrics (cards written and passed,
// practised and how well, what was skipped, the tokens in, out and from cache), a 7-day history, and the controls that make sense for it (pause today, limits, reasoning).
const source = { id: 'src', title: 'Memento notes',
  text: 'The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state. The Originator creates and restores its own snapshots.' };
const quiz = (n, prompt, topic = 'Memento') => ({ id: `q${n}`, kind: 'quiz', topic, objective: `objective ${n}`, prompt, answer: 'Caretaker',
  hint: 'Who keeps the history?', explanation: 'The Caretaker keeps history; the Originator restores state.', misconception: 'Treating the Memento as the history manager.',
  citations: [{ sourceId: 'src', quote: 'The Caretaker manages snapshot history without inspecting snapshot contents.' }],
  options: [{ id: 'a', text: 'Caretaker', correct: true, explanation: 'It manages history without reading snapshots.' },
    { id: 'b', text: 'Memento', correct: false, explanation: 'It is the snapshot, not its manager.' },
    { id: 'c', text: 'Originator', correct: false, explanation: 'It creates and restores snapshots.' }] });

async function setup(t, { cards = 10 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-coach-daily-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = [], options = [], base = createFakeModel({ log, usage: true });
  const model = async (...args) => { options.push(args[2] || {}); return base(...args); };
  const service = new StudyService(root, { complete: model, completeLight: model, coach: true, ...switchOptions(SWITCH_MODE, { complete: model, paths: ['coach'] }) });
  await service.call('source.add', source);
  await service.call('draft.save', { deck: { id: 'd', title: 'Patterns', cards: Array.from({ length: cards }, (_, i) => quiz(i + 1, `第 ${i + 1} 个关于 Memento 的问题：谁管理历史 ${i}？`, i < 3 ? '保护状态' : 'Memento')) } });
  await new StudyService(root).call('draft.publish', { id: 'd' });
  return { root, service, log, options, model };
}
const wrong = (run) => run.card.options.find((o) => o.text === 'Memento').id;
async function miss(service, count) {
  let run = await service.call('review.start', { deckId: 'd', mode: 'quiz', count });
  const refs = [];
  for (let i = 0; i < count; i++) {
    refs.push({ deckId: 'd', cardId: run.card.id });
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [wrong(run)] });
    if (i < count - 1) run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return refs;
}
const today = () => dayOf(Date.now());
const rowOf = async (service) => (await service.call('snapshot', {})).jobs.filter((job) => job.type === 'coach-daily');
const batchesOf = (log) => log.filter((x) => x.prompt.includes('为每个 target')).length;
const prepare = async (service, refs) => { await service.call('coach.variants', { cards: refs, consent: true }); return service.call('coach.prepare'); };

test('a day with one batch is one row: its batches, what was written and kept, and the tokens in, out and from cache', async (t) => {
  const { service } = await setup(t);
  const refs = await miss(service, 3);
  assert.deepEqual(await rowOf(service), [], 'no row before anything was prepared');
  await prepare(service, refs);
  const rows = await rowOf(service);
  assert.equal(rows.length, 1);
  const [job] = rows, contract = job.contract;
  assert.equal(job.id, `coach:${today()}`);
  assert.equal(contract.kind, 'coach-daily');
  assert.equal(contract.jobId, `coach:${today()}`);
  assert.equal(contract.status, 'complete', 'nothing is in flight: the day rests');
  assert.equal(contract.detail.date, today());
  assert.equal(contract.detail.batches.length, 1);
  assert.equal(contract.detail.batches[0].status, 'ok');
  assert.equal(contract.detail.batches[0].targets, 3);
  assert.equal(contract.detail.metrics.generated, 3);
  assert.equal(contract.detail.metrics.passed, 3);
  assert.ok(contract.detail.tokens.input > 0 && contract.detail.tokens.output > 0, 'the metered tokens of the batch');
  assert.ok(contract.detail.tokens.cache >= 0);
  assert.equal(contract.progress.done, 3);
  assert.equal(contract.progress.unit, 'cards');
  assert.equal(contract.calls.length, 1, 'a batch is a model call of the job');
  assert.equal(contract.calls[0].kind, 'prep');
  assert.equal(contract.calls[0].status, 'ok');
});

test('another batch the same day is the same row: the counts add up, the row never splits', async (t) => {
  const { service, log } = await setup(t, { cards: 10 });
  const refs = await miss(service, 5);
  await prepare(service, refs.slice(0, 2));
  await service.call('coach.variants', { cards: refs.slice(2, 5) });
  await service.call('coach.prepare');
  assert.equal(batchesOf(log), 2);
  const rows = await rowOf(service);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contract.detail.batches.length, 2);
  assert.equal(rows[0].contract.detail.metrics.passed, 5);
  assert.equal(rows[0].contract.calls.length, 2);
});

test('a batch that fails is recorded as failed, with its plain message, and the row says so', async (t) => {
  const { service, model } = await setup(t);
  const refs = await miss(service, 2);
  service.light = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9'); };
  await prepare(service, refs);
  const [job] = await rowOf(service);
  assert.equal(job.contract.detail.batches[0].status, 'failed');
  assert.equal(job.contract.detail.batches[0].reason, 'error');
  assert.ok(job.contract.detail.batches[0].message && !/ECONNREFUSED/.test(job.contract.detail.batches[0].message), 'no raw socket text');
  assert.equal(job.contract.detail.metrics.passed, 0);
  assert.equal(job.contract.calls[0].status, 'failed');
  service.light = model;
});

test('what was practised and how well comes from the attempts on the 为你定制 deck that day', async (t) => {
  const { service } = await setup(t);
  const refs = await miss(service, 2);
  await prepare(service, refs);
  const prepared = (await service.call('export')).prepared, keyOf = (r) => prepared.find((p) => p.card.id === r.card.id).card.options;
  let run = await service.call('coach.practice', {});
  run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [keyOf(run).find((o) => o.correct).id] });
  run = await service.call('review.move', { runId: run.id, direction: 1 });
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [keyOf(run).find((o) => !o.correct).id] });
  const [job] = await rowOf(service);
  assert.equal(job.contract.detail.metrics.practised, 2);
  assert.equal(job.contract.detail.metrics.correct, 1);
  assert.equal(job.contract.detail.metrics.accuracy, 50);
});

test('pause today: no new batch starts (the one in flight is never interrupted); resume lets them go on', async (t) => {
  const { service, log } = await setup(t);
  const refs = await miss(service, 4);
  await prepare(service, refs.slice(0, 1));
  const id = `coach:${today()}`;
  const before = (await rowOf(service))[0].contract;
  assert.equal(before.actions.pause.available, true);
  assert.equal(before.actions.pause.mode, 'checkpoint');
  assert.equal(before.actions.cancel.available, false, 'there is nothing to stop: a day is a record, not a run');
  const reply = await service.call('job.control', { jobId: id, action: 'pause' });
  assert.equal(reply.action, 'pause');
  const paused = (await rowOf(service))[0].contract;
  assert.equal(paused.detail.paused, true);
  assert.equal(paused.actions.resume.available, true);
  assert.equal(paused.actions.pause.available, false);
  const calls = batchesOf(log);
  await service.call('coach.variants', { cards: refs.slice(1, 3) });
  await service.call('coach.prepare');
  assert.equal(batchesOf(log), calls, 'paused: the model is not called');
  const skipped = (await rowOf(service))[0].contract.detail.batches.at(-1);
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.message, /暂停/);
  assert.equal(skipped.reason, 'paused', 'the console puts the reason into words itself');
  await service.call('job.control', { jobId: id, action: 'resume' });
  await service.call('coach.variants', { cards: refs.slice(1, 3) });
  await service.call('coach.prepare');
  assert.equal(batchesOf(log), calls + 1, 'resumed: the next batch runs');
  assert.equal((await rowOf(service))[0].contract.detail.paused, false);
  await assert.rejects(service.call('job.control', { jobId: id, action: 'cancel' }), (error) => error.code === 'capability-unsupported');
});

test('limits and reasoning are live settings: they apply to the next batch, and the reply says what is now in force', async (t) => {
  const { service, options } = await setup(t, { cards: 10 });
  const refs = await miss(service, 6);
  await prepare(service, refs.slice(0, 1));
  const id = `coach:${today()}`;
  const contract = (await rowOf(service))[0].contract;
  assert.deepEqual(contract.actions.set.settings.map((s) => s.key), ['maxBatchesPerDay', 'maxReady', 'reasoning']);
  const reply = await service.call('job.control', { jobId: id, action: 'set', patch: { maxReady: 2, reasoning: 'high' } });
  assert.deepEqual(reply.applied, { maxReady: 2, reasoning: 'high' });
  await service.call('coach.variants', { cards: refs.slice(1, 6) });
  await service.call('coach.prepare');
  const status = await service.call('coach.status');
  assert.equal(status.ready, 2, 'the ready limit holds: one variant was ready, one more was written, no more');
  assert.equal(options.filter((o) => o.reasoningEffort === 'high').length, 1, 'the reasoning level reaches the model call of that batch');
  assert.equal(options.slice(0, 1).every((o) => o.reasoningEffort === undefined), true, 'before the setting the model call is as it always was');
  await assert.rejects(service.call('job.control', { jobId: id, action: 'set', patch: { maxReady: 99 } }), /maxReady/);
  await assert.rejects(service.call('job.control', { jobId: id, action: 'set', patch: { nonsense: 1 } }), /nonsense/);
});

test('the day\'s batch limit stops new batches with a plain note; they are not model calls', async (t) => {
  const { service, log } = await setup(t, { cards: 10 });
  const refs = await miss(service, 4);
  await prepare(service, refs.slice(0, 1));
  await service.call('job.control', { jobId: `coach:${today()}`, action: 'set', patch: { maxBatchesPerDay: 1 } });
  const calls = batchesOf(log);
  await service.call('coach.variants', { cards: refs.slice(1, 3) });
  await service.call('coach.prepare');
  assert.equal(batchesOf(log), calls);
  const last = (await rowOf(service))[0].contract.detail.batches.at(-1);
  assert.equal(last.status, 'skipped');
  assert.match(last.message, /次数/);
  assert.equal(last.reason, 'limit');
});

test('the history keeps seven days, one row each, past days are records (nothing to adjust), and a record can be dismissed', async (t) => {
  const { service, root } = await setup(t);
  const day = (back) => dayOf(Date.now() - back * 86400000);
  const seeded = (back, passed) => [day(back), { batches: [{ id: `b${back}`, startedAt: new Date(Date.now() - back * 86400000).toISOString(), endedAt: new Date(Date.now() - back * 86400000 + 60000).toISOString(),
    status: 'ok', targets: passed, generated: passed, passed, skipped: 0, tokens: { input: 1000, output: 200, cache: 50 }, message: `备好 ${passed} 道定制题` }] }];
  await writeFile(join(root, DAILY.file), JSON.stringify({ version: 1, settings: {}, days: Object.fromEntries([seeded(1, 3), seeded(3, 2), seeded(6, 4), seeded(9, 5)]) }), 'utf8');
  coachDailyLedger(root).reload();
  const rows = await rowOf(service);
  assert.deepEqual(rows.map((row) => row.id), [`coach:${day(1)}`, `coach:${day(3)}`, `coach:${day(6)}`], 'the last seven days; the ninth day is gone');
  const yesterday = rows[0].contract;
  assert.equal(yesterday.status, 'complete');
  assert.equal(yesterday.actions.set.available, false, 'a past day has nothing to adjust');
  assert.equal(yesterday.actions.pause.available, false);
  assert.equal(yesterday.detail.metrics.passed, 3);
  await service.call('job.dismiss', { jobId: `coach:${day(3)}` });
  assert.deepEqual((await rowOf(service)).map((row) => row.id), [`coach:${day(1)}`, `coach:${day(6)}`]);
});

test('the sidebar badge does not count the day\'s row unless a batch is in flight', async (t) => {
  const { service, model } = await setup(t);
  const refs = await miss(service, 2);
  const release = Promise.withResolvers();
  service.light = async (...args) => { await release.promise; return model(...args); };
  await service.call('coach.variants', { cards: refs, consent: true });
  const during = (await rowOf(service))[0]?.contract;
  assert.equal(during?.status, 'running', 'a batch in flight is a running task');
  release.resolve();
  await service.call('coach.prepare');
  assert.equal((await rowOf(service))[0].contract.status, 'complete');
});
