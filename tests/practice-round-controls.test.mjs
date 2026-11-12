import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { freshRoundCount } from '../lib/practice-settings.js';
import { followupDigest } from '../lib/followup.js';
import { assistRunningOn, pendingCount, reviewPollResult, shortcutAction, skipTarget } from '../ui/review/session-logic.js';
import { reviewPollDelay } from '../ui/poll-schedule.js';

/* #1008 / #1009 / #1011: inside a practice round the learner can set a question aside (先跳过, the existing review.move {index}) and stop the round with a
   result (到此为止, the existing review.end); the result page lists the round's questions with a read-only look-back from the run itself; 「继续下一批新题」 takes
   as many questions as the round size; the practice page's poll slows down while nothing changes. */

const MIN = 60000;
const quiz = (id) => ({ id, kind: 'quiz', topic: `T-${id}`, objective: 'Recall', prompt: `${id}?`, hint: 'H', explanation: `E-${id}`, misconception: `M-${id}`, citations: [],
  options: [{ id: 'a', text: 'yes', correct: true, explanation: 'x' }, { id: 'b', text: 'no', correct: false, explanation: 'y' }] });

async function library(t, count = 3) {
  const root = await mkdtemp(join(tmpdir(), 'round-controls-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const ids = Array.from({ length: count }, (_, index) => `q${index + 1}`);
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: 'C', cards: ids.map(quiz) }); });
  const run = await service.call('review.start', { mode: 'path', fresh: true, scope: ids.map((cardId) => ({ deckId: 'd', cardId })) });
  return { service, run };
}
const age = (service, runId, ms) => service.store.update((s) => { for (const entry of s.runs.find((r) => r.id === runId).entries) entry.startedAt = Date.now() - ms; });
const answer = (service, run, selected = ['a']) => service.call('review.answer', { runId: run.id, cardId: run.card.id, selected });

/* ── 先跳过 (#1008) ── */

test('先跳过 goes to the next unanswered question after this one, wraps round, and is not offered when nothing else waits', () => {
  const nav = (answered) => answered.map((done, index) => ({ index, answered: done }));
  const run = (index, answered, extra = {}) => ({ id: 'r', mode: 'path', index, card: { id: `c${index}` }, feedback: null, navigation: nav(answered), ...extra });
  assert.equal(skipTarget(run(0, [false, false, false])), 1);
  assert.equal(skipTarget(run(1, [false, true, true, false])), 3, 'answered ones are passed over');
  assert.equal(skipTarget(run(2, [false, true, false])), 0, 'from the last it wraps to the first unanswered');
  assert.equal(skipTarget(run(0, [false, true, true])), null, 'the only unanswered question cannot be set aside');
  assert.equal(skipTarget(run(0, [false, false], { feedback: { grade: 4 } })), null, 'an answered question goes on with 下一题');
  assert.equal(skipTarget(run(0, [false, false], { mode: 'exam' })), null, 'an exam has its own rules');
  assert.equal(skipTarget(run(0, [false, false], { card: { id: 'c0', publicationUngrable: true } })), null, 'an ungradable question has its own 跳过');
  assert.equal(pendingCount(run(0, [false, true, false])), 2);
  assert.equal(pendingCount({ mode: 'exam', navigation: undefined }), 0);
});

test('a skipped question is timed afresh when it comes back, and records one answer', async (t) => {
  const { service, run } = await library(t);
  await age(service, run.id, 10 * MIN);
  // 先跳过 on q1: the existing jump to question 2.
  let current = await service.call('review.move', { runId: run.id, index: 1 });
  assert.equal(current.card.id, 'q2');
  await answer(service, current);
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  await answer(service, current);
  // 下一题 on the last question brings the skipped one back (the round's own rule), its clock restarted.
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.card.id, 'q1', 'the skipped question comes back at the end of the round');
  assert.equal(current.complete, false);
  await answer(service, current);
  const attempts = (await service.store.read()).attempts.filter((item) => item.quiz_id === 'q1');
  assert.equal(attempts.length, 1, 'one answer, no record for the skip');
  assert.ok(attempts[0].elapsed_ms < 5000, `the time before the skip is not counted, got ${attempts[0].elapsed_ms}`);
});

/* ── 到此为止 (#1008) ── */

test('到此为止 keeps the answered grades, records nothing for the rest, and the round does not open again', async (t) => {
  const { service, run } = await library(t);
  const before = structuredClone((await service.store.read()).decks[0].cards.map((card) => card.review ?? null));
  const answered = await answer(service, run, ['b']);
  assert.equal(answered.feedback.correct, false);
  const ended = await service.call('review.end', { runId: run.id });
  assert.equal(ended.complete, true);
  assert.equal(ended.closed, true);
  assert.equal(ended.questions, 3);
  assert.equal(ended.answered, 1);
  assert.equal(ended.correct, 0);
  const state = await service.store.read();
  assert.deepEqual(state.attempts.map((item) => item.quiz_id), ['q1'], 'only the answered question has an attempt');
  assert.notDeepEqual(state.decks[0].cards[0].review ?? null, before[0], 'the answered question is scheduled as usual');
  assert.deepEqual(state.decks[0].cards.slice(1).map((card) => card.review ?? null), before.slice(1), 'the unanswered ones keep their schedule');
  const again = await service.call('review.start', { mode: 'path', scope: [1, 2, 3].map((n) => ({ deckId: 'd', cardId: `q${n}` })) });
  assert.notEqual(again.id, run.id, 'starting the same scope opens a new round, never the ended one');
});

/* ── the look-back (#1009) ── */

test('a finished round carries every question for the look-back: answer, solution and Q&A for the answered, only the question for the rest', async (t) => {
  const { service, run } = await library(t);
  await service.store.update((s) => { const card = s.decks[0].cards[0]; card.followups = [{ id: 'f1', question: 'Why?', answer: 'Because.', digest: followupDigest(card), createdAt: new Date().toISOString() }]; });
  await answer(service, run, ['b']);
  let current = await service.call('review.move', { runId: run.id, direction: 1 });
  await answer(service, current);
  const open = await service.call('review.get', { runId: run.id });
  assert.equal(open.lookBack, undefined, 'nothing while the round is open');
  const ended = await service.call('review.end', { runId: run.id });
  const rows = ended.lookBack;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.status), ['wrong', 'right', 'unanswered']);
  assert.deepEqual(rows.map((row) => row.number), [1, 2, 3]);
  assert.equal(rows[0].prompt, 'q1?');
  assert.deepEqual(rows[0].feedback.selected, ['b'], 'what the learner chose');
  assert.equal(rows[0].solution.explanation, 'E-q1');
  assert.equal(rows[0].solution.options.find((option) => option.correct).id, 'a', 'the right answer');
  assert.deepEqual(rows[0].solution.followups.map((item) => item.question), ['Why?'], 'the Q&A');
  assert.ok(rows[0].card.options.length === 2 && rows[0].card.options.every((option) => option.correct === undefined), 'the card as it was asked, without the key');
  assert.equal(rows[2].solution, undefined, 'an unanswered question shows no answer');
  assert.equal(rows[2].feedback, undefined);
  // Reading it changes nothing: no attempt, no schedule, no clock.
  const state = await service.store.read();
  const snapshot = JSON.stringify({ attempts: state.attempts, cards: state.decks[0].cards.map((card) => card.review), clocks: state.runs[0].entries.map((entry) => entry.startedAt) });
  current = await service.call('review.get', { runId: run.id });
  assert.equal(current.lookBack.length, 3);
  const after = await service.store.read();
  assert.equal(JSON.stringify({ attempts: after.attempts, cards: after.decks[0].cards.map((card) => card.review), clocks: after.runs[0].entries.map((entry) => entry.startedAt) }), snapshot);
});

test('an exam never carries the look-back', async (t) => {
  const { service } = await library(t);
  const exam = await service.call('review.start', { mode: 'exam', scope: [{ deckId: 'd' }], count: 3 });
  const ended = await service.call('review.end', { runId: exam.id });
  assert.equal(ended.lookBack, undefined);
});

/* ── the size of the next batch (#1009) ── */

test('「继续下一批新题」 takes the round size of the practice settings, whatever it is', () => {
  for (const size of [5, 10, 30]) assert.equal(freshRoundCount({ roundSize: size }), size);
  assert.equal(freshRoundCount(undefined), 20, 'the default round size when nothing was saved');
  assert.equal(freshRoundCount({ roundSize: 999 }), 20, 'an out-of-range value falls back to the default');
});

/* ── the keys (#1008) ── */

test('K sets the question aside, N writes a note, F marks it as focus, O opens its page; never inside a field, never in an exam', () => {
  const run = { id: 'r', mode: 'path', index: 0, card: { id: 'c', kind: 'quiz', options: [{ id: 'a' }, { id: 'b' }] }, feedback: null, revealed: false };
  const ctx = (extra = {}) => ({ inside: true, modalOpen: false, page: 'review', run, busy: false, shortcutHelp: false, choice: true, isCloze: false, rubricCard: false, selected: [], clozeValues: {}, ...extra });
  const press = (key, { inEditable = false, ...extra } = {}) => shortcutAction({ key, code: `Key${key.toUpperCase()}`, shiftKey: false, repeat: false, defaultPrevented: false, inEditable }, ctx(extra))?.action;
  assert.deepEqual(press('k'), { type: 'skip' });
  assert.deepEqual(press('n'), { type: 'note' });
  assert.deepEqual(press('f'), { type: 'focus' });
  assert.deepEqual(press('o'), { type: 'source' });
  assert.equal(press('k', { inEditable: true }), undefined, 'typing a k in an answer is typing');
  assert.equal(press('n', { inEditable: true }), undefined);
  const exam = { ...run, mode: 'exam' };
  for (const key of ['k', 'n', 'f', 'o']) assert.equal(press(key, { run: exam }), null, `${key} does nothing in an exam`);
  // The old keys keep their meaning.
  assert.deepEqual(press('h'), { type: 'hint' });
  assert.deepEqual(press('1'), { type: 'choose', id: 'a' });
});

/* ── the poll (#1011) ── */

test('the practice page polls every 4 s, slows down while nothing changes up to about 30 s, and keeps 4 s while a helper task runs', () => {
  const delays = Array.from({ length: 12 }, (_, unchanged) => reviewPollDelay(4000, { unchanged }));
  assert.equal(delays[0], 4000);
  for (let index = 1; index < delays.length; index++) assert.ok(delays[index] >= delays[index - 1], 'never faster while nothing changes');
  assert.ok(delays[3] > 4000, 'slower after a few unchanged answers');
  assert.equal(Math.max(...delays), 30000, 'capped at 30 s');
  assert.equal(reviewPollDelay(4000, { unchanged: 50, running: true }), 4000, 'a running helper task keeps the quick rhythm');
});

test('a poll that changes nothing says so, and a helper task on the open question keeps the poll quick', () => {
  const open = { id: 'r', index: 0, queueVersion: 0, revealed: false, feedback: null, card: { id: 'c' }, followups: [] };
  assert.deepEqual(reviewPollResult(open, { ...open }), { unchanged: true, running: false });
  assert.deepEqual(reviewPollResult(open, { ...open, followups: [{ id: 'f1', question: 'Q', answer: 'A' }] }), { running: false }, 'a new Q&A is a change');
  assert.deepEqual(reviewPollResult(open, { ...open, card: { id: 'c', prompt: 'fixed' } }), { running: false }, 'a fixed question is a change');
  assert.deepEqual(reviewPollResult(open, { ...open }, true), { unchanged: true, running: true });
  const tasks = [{ cardId: 'c', status: 'running', mode: 'ask' }, { cardId: 'x', status: 'running', mode: 'improve' }, { cardId: 'g', status: 'running', mode: 'grade' }];
  assert.equal(assistRunningOn(tasks, 'c'), true);
  assert.equal(assistRunningOn(tasks, 'g'), false, '批改 has its own waiting line');
  assert.equal(assistRunningOn(tasks, 'y'), false);
  assert.equal(assistRunningOn([{ cardId: 'c', status: 'done', mode: 'ask' }], 'c'), false);
  assert.equal(assistRunningOn(undefined, 'c'), false);
});
