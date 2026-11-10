import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

/* #883 slice S2: the time recorded on a practice attempt leaves out the time the page was hidden. The panel reports it with the answer
   (`hiddenMs`); the host takes it off the time since the question opened, never below zero, and ignores anything that is not a number.
   It is not part of the answer: the same answer twice is still one answer, and grading, scheduling and exams do not read it. */

const MIN = 60000;
const quiz = (id) => ({ id, kind: 'quiz', topic: `T-${id}`, objective: 'Recall', prompt: `${id}?`, hint: 'H', explanation: 'E', misconception: '', citations: [],
  options: [{ id: 'a', text: 'yes', correct: true, explanation: 'x' }, { id: 'b', text: 'no', correct: false, explanation: 'y' }] });

async function library(t, count = 12) {
  const root = await mkdtemp(join(tmpdir(), 'answer-idle-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const ids = Array.from({ length: count }, (_, index) => `q${index + 1}`);
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: 'C', cards: ids.map(quiz) }); });
  return service;
}
/** The question was opened `ms` ago (the panel left it open that long). */
const openedAgo = (service, runId, ms) => service.store.update((s) => {
  for (const entry of s.runs.find((run) => run.id === runId).entries) entry.startedAt = Date.now() - ms;
});
async function openQuestion(service, cardId, agoMs = 10 * MIN) {
  const run = await service.call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'd', cardId }] });
  await openedAgo(service, run.id, agoMs);
  return run;
}
const attemptOf = async (service, cardId) => (await service.store.read()).attempts.filter((att) => att.quiz_id === cardId).at(-1);
const answer = (service, run, extra) => service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['a'], ...extra });

test('an answer after a hidden stretch records the time without it', async (t) => {
  const service = await library(t);
  const run = await openQuestion(service, 'q1');
  await answer(service, run, { hiddenMs: 9 * MIN });
  const { elapsed_ms } = await attemptOf(service, 'q1');
  assert.ok(elapsed_ms >= MIN && elapsed_ms < MIN + 5000, `about one minute, got ${elapsed_ms}`);
});

test('without a hidden time the recorded time is the whole time since the question opened', async (t) => {
  const service = await library(t);
  const run = await openQuestion(service, 'q1');
  await answer(service, run);
  const { elapsed_ms } = await attemptOf(service, 'q1');
  assert.ok(elapsed_ms >= 10 * MIN && elapsed_ms < 10 * MIN + 5000, `got ${elapsed_ms}`);
});

test('a value that is not a number, or is negative, counts as nothing hidden', async (t) => {
  const service = await library(t);
  const garbage = ['9', null, true, {}, [5], Number.NaN, Infinity, -Infinity, -5 * MIN, 0];
  for (const [index, hiddenMs] of garbage.entries()) {
    const id = `q${index + 1}`;
    const run = await openQuestion(service, id);
    await answer(service, run, { hiddenMs });
    const { elapsed_ms } = await attemptOf(service, id);
    assert.ok(elapsed_ms >= 10 * MIN && elapsed_ms < 10 * MIN + 5000, `${String(hiddenMs)} leaves the whole time, got ${elapsed_ms}`);
  }
});

test('an oversized value never takes off more than the time since the question opened', async (t) => {
  const service = await library(t);
  const run = await openQuestion(service, 'q1', 2 * MIN);
  await answer(service, run, { hiddenMs: 10 ** 12 });
  const { elapsed_ms } = await attemptOf(service, 'q1');
  assert.ok(Number.isInteger(elapsed_ms) && elapsed_ms >= 0 && elapsed_ms < 100, `a year hidden in a two minute question leaves none, got ${elapsed_ms}`);
});

test('a tail retry starts from zero: nothing reported before it opened can be taken off it', async (t) => {
  const service = await library(t);
  const run = await openQuestion(service, 'q1');
  const wrong = await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['b'], hiddenMs: 9 * MIN });
  assert.equal(wrong.feedback.retryQueued, true);
  const next = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(next.card.id, 'q1');
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['a'], hiddenMs: 9 * MIN });
  const retry = (await service.store.read()).attempts.filter((att) => att.quiz_id === 'q1' && att.retry).at(-1);
  assert.ok(retry.elapsed_ms >= 0 && retry.elapsed_ms < 100, `the retry opened a moment ago, got ${retry.elapsed_ms}`);
});

test('the hidden time is not part of the answer: the same answer twice is one answer', async (t) => {
  const service = await library(t);
  const cases = [['q1', {}, { hiddenMs: 3 * MIN }], ['q2', { hiddenMs: 3 * MIN }, {}], ['q3', { hiddenMs: 3 * MIN }, { hiddenMs: 7 * MIN }]];
  for (const [id, first, second] of cases) {
    const run = await openQuestion(service, id);
    const one = await answer(service, run, first);
    const before = (await service.store.read()).attempts.length;
    const two = await answer(service, run, second);
    assert.equal((await service.store.read()).attempts.length, before, `${id}: no second attempt`);
    assert.deepEqual(two.feedback, one.feedback, `${id}: the same feedback`);
  }
  const run = await openQuestion(service, 'q4');
  await answer(service, run, { hiddenMs: MIN });
  await assert.rejects(service.call('review.answer', { runId: run.id, cardId: 'q4', selected: ['b'], hiddenMs: MIN }), /different response/);
});

test('the hidden time changes nothing but the time: grade, schedule and every other field are the same', async (t) => {
  const service = await library(t);
  const plain = await openQuestion(service, 'q1');
  await answer(service, plain);
  const away = await openQuestion(service, 'q2');
  await answer(service, away, { hiddenMs: 9 * MIN });
  const [a, b] = [await attemptOf(service, 'q1'), await attemptOf(service, 'q2')];
  assert.equal(b.grade, a.grade);
  assert.equal(b.after.interval_days, a.after.interval_days);
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), 'no new field on the attempt');
  assert.ok(b.elapsed_ms < a.elapsed_ms - 8 * MIN);
});

test('an exam answer and its submission keep the time as before', async (t) => {
  const service = await library(t, 2);
  const run = await service.call('review.start', { mode: 'exam', count: 2, fresh: true });
  await openedAgo(service, run.id, 10 * MIN);
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: ['a'], hiddenMs: 9 * MIN });
  await service.call('exam.submit', { runId: run.id, hiddenMs: 9 * MIN });
  const attempts = (await service.store.read()).attempts.filter((att) => att.runId === run.id);
  assert.ok(attempts.length > 0);
  for (const att of attempts) assert.ok(att.elapsed_ms >= 10 * MIN, `exam time is the whole time, got ${att.elapsed_ms}`);
});
