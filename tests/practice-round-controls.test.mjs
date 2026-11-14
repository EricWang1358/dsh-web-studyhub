import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { freshRoundCount, roundLimits } from '../lib/practice-settings.js';
import { followupDigest } from '../lib/followup.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { capabilityIndex } from '../lib/runtime/tools.js';
import { assistRunningOn, clozeBlankKeyAction, finishedTask, pendingCount, retriesWaiting, reviewPollResult, shortcutAction, skipTarget } from '../ui/review/session-logic.js';
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
  // A re-ask (再练) queued by a wrong answer is not a question of the round: 「N 题待答」 and 到此为止 say what the result page's 未答 will say.
  const withRetry = { mode: 'path', navigation: [{ index: 0, answered: true }, { index: 1, answered: false }, { index: 2, answered: false, retry: true }] };
  assert.equal(pendingCount(withRetry), 1, 'the waiting re-ask is not counted as unanswered');
  assert.equal(retriesWaiting(withRetry), 1, 'it is counted on its own');
  assert.equal(retriesWaiting({ ...withRetry, navigation: withRetry.navigation.slice(0, 2) }), 0);
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

test('下一题 goes to the next question still waiting: after the skipped one comes back and is answered, one press opens the result', async (t) => {
  const { service, run } = await library(t, 4);
  let current = await service.call('review.move', { runId: run.id, index: 1 }); // 先跳过 q1
  for (const id of ['q2', 'q3', 'q4']) {
    assert.equal(current.card.id, id);
    assert.equal(current.position.last, false, `${id}: q1 still waits, so the button is 下一题, not 完成`);
    current = await answer(service, current);
    current = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(current.card.id, 'q1', 'the skipped question comes back');
  assert.equal(current.position.last, true, 'nothing else waits: the button says 完成');
  current = await answer(service, current);
  // ← still steps back one question to re-read an answered one, and 下一题 from there does not walk through the answered ones.
  const back = await service.call('review.move', { runId: run.id, direction: -1 });
  assert.equal(back.index, 0, 'nothing before q1: ← stays');
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.complete, true, 'one press from the last answer opens the result page, not question 2');
  assert.equal(current.answered, 4);
});

test('← steps back one question, answered or not, and 下一题 from a re-read question goes to the one still waiting', async (t) => {
  const { service, run } = await library(t, 4);
  let current = await answer(service, run);
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  current = await answer(service, current);
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.card.id, 'q3');
  current = await service.call('review.move', { runId: run.id, direction: -1 });
  assert.equal(current.card.id, 'q2', '← re-reads the answered question before');
  current = await service.call('review.move', { runId: run.id, direction: -1 });
  assert.equal(current.card.id, 'q1');
  current = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(current.card.id, 'q3', '下一题 skips what is already answered');
});

test('an exam keeps its plain order: 下一题 is the next question, answered or not', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'round-exam-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: 'C', cards: ['e1', 'e2', 'e3'].map(quiz) }); });
  const exam = await service.call('review.start', { mode: 'exam', deckId: 'd', count: 3 });
  let current = await service.call('review.answer', { runId: exam.id, cardId: exam.card.id, selected: ['a'] });
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.index, 1);
  current = await service.call('review.answer', { runId: exam.id, cardId: current.card.id, selected: ['a'] });
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.index, 2);
  current = await service.call('review.move', { runId: exam.id, direction: -1 });
  current = await service.call('review.move', { runId: exam.id, direction: -1 });
  assert.equal(current.index, 0);
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.index, 1, 'an answered question next in order is still the next one');
  assert.equal(current.position.last, false);
  current = await service.call('review.move', { runId: exam.id, direction: 1 });
  assert.equal(current.position.last, true, 'an exam: the last in order');
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
  assert.deepEqual((await service.call('review.lookBack', { runId: run.id })).rows, [], 'nothing while the round is open');
  const ended = await service.call('review.end', { runId: run.id });
  assert.equal(ended.lookBack, undefined, 'the run itself does not carry it (a main-chat tool result of a finished round stays small)');
  const { rows } = await service.call('review.lookBack', { runId: run.id });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.status), ['wrong', 'right', 'unanswered']);
  assert.deepEqual(rows.map((row) => row.number), [1, 2, 3]);
  assert.equal(rows[0].card.prompt, 'q1?');
  assert.equal(rows[0].prompt, undefined, 'an answered row has its prompt once, in its card');
  assert.equal(rows[2].prompt, 'q3?', 'an unanswered row has only its prompt');
  for (const row of rows) assert.deepEqual(Object.keys(row).filter((key) => ['index', 'retried'].includes(key)), [], 'no field the page does not read');
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
  assert.equal((await service.call('review.lookBack', { runId: run.id })).rows.length, 3);
  const after = await service.store.read();
  assert.equal(JSON.stringify({ attempts: after.attempts, cards: after.decks[0].cards.map((card) => card.review), clocks: after.runs[0].entries.map((entry) => entry.startedAt) }), snapshot);
});

test('an exam never carries the look-back', async (t) => {
  const { service } = await library(t);
  const exam = await service.call('review.start', { mode: 'exam', scope: [{ deckId: 'd' }], count: 3 });
  await service.call('review.end', { runId: exam.id });
  assert.deepEqual((await service.call('review.lookBack', { runId: exam.id })).rows, [], 'its report has its own rules');
});

test('the look-back is the panel read: the main chat is refused it and does not see it, and review.end of a 50-question round stays small', async (t) => {
  assert.match(assistantRefusal('review.lookBack') || '', /not available to the assistant/);
  assert.equal(assistantRefusal('review.get'), null);
  const index = JSON.stringify(capabilityIndex([{ id: 'study', api: 'study.v1', operations: ['review.get', 'review.lookBack', 'review.end'].map((name) => ({ name, available: true })) }]));
  assert.doesNotMatch(index, /lookBack/, 'not listed to the assistant');
  const { service, run } = await library(t, 50);
  let current = run;
  for (let n = 0; n < 50; n++) {
    current = await answer(service, current);
    if (n < 49) current = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  const open = JSON.stringify(await service.call('review.get', { runId: run.id })).length;
  const ended = JSON.stringify(await service.call('review.end', { runId: run.id })).length;
  assert.ok(ended < open * 1.5, `review.end of 50 answered questions is about the size of the open run (${ended} vs ${open} characters)`);
  assert.ok(JSON.stringify(await service.call('review.lookBack', { runId: run.id })).length > ended, 'the rows are the big part, and only the panel reads them');
});

/* ── the size of the next batch (#1009) ── */

test('a round of new questions takes the new-question limit of the round size (设置 › 练习: 「新题最多 N 道」)', () => {
  for (const [size, fresh] of [[5, 3], [10, 5], [30, 15]]) {
    assert.equal(freshRoundCount({ roundSize: size }), fresh, `round size ${size}`);
    assert.equal(freshRoundCount({ roundSize: size }), roundLimits(size).newLimit, 'the same number the settings hint shows');
  }
  assert.equal(freshRoundCount(undefined), 10, 'the default: 20 a round, at most 10 new');
  assert.equal(freshRoundCount({ roundSize: 999 }), 10, 'an out-of-range value falls back to the default');
});

test('the host defaults for new questions are the same number (review.start mode new, focus.fresh)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-defaults-'));
  const service = new StudyService(root);
  try {
    await service.store.update((s) => {
      s.decks.push({ id: 'n', title: 'New', course: 'C', cards: Array.from({ length: 30 }, (_, i) => quiz(`n${i}`)) });
      s.settings = { ...s.settings, practice: { roundSize: 30 } };
    });
    await service.call('focus.set', { course: 'C' });
    assert.equal((await service.call('snapshot')).focus.fresh.length, 15, 'focus.fresh: the new-question limit of a 30 round');
    const run = await service.call('review.start', { mode: 'new', currentCourse: true, fresh: true });
    assert.equal(run.total, 15, 'review.start mode new without a count');
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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

test('Cloze Enter jumps into the first blank, advances across empty blanks, submits when filled, and Esc returns focus to the card', () => {
  const clozeRun = { id: 'rc', mode: 'path', index: 0, card: { id: 'c', kind: 'cloze', cloze: { text: '{{b1}} and {{b2}}' } }, feedback: null, revealed: false };
  const ctx = (extra = {}) => ({ inside: true, modalOpen: false, page: 'review', run: clozeRun, busy: false, shortcutHelp: false, choice: false, isCloze: true, rubricCard: false, selected: [], clozeValues: {}, ...extra });
  const press = (key, extra = {}) => shortcutAction({ key, code: key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`, shiftKey: false, repeat: false, defaultPrevented: false, inEditable: false }, ctx(extra))?.action;
  assert.deepEqual(press('Enter'), { type: 'focus-cloze' }, 'Enter on an empty cloze jumps into the first blank');
  assert.deepEqual(press('Enter', { clozeValues: { b1: 'one' } }), { type: 'answer', args: { answers: { b1: 'one' } } }, 'Enter from the card submits once a blank has text');
  assert.deepEqual(press('v'), { type: 'voice' }, 'V still triggers voice while the card holds focus');
  assert.deepEqual(press('h'), { type: 'hint' }, 'H still opens hint while the card holds focus');
  assert.deepEqual(press('Enter', { run: { ...clozeRun, feedback: { grade: 5 } } }), { type: 'move', direction: 1 }, 'Enter after feedback still advances');

  const key = (k, extra = {}) => ({ key: k, repeat: false, isComposing: false, keyCode: k === 'Enter' ? 13 : 27, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  assert.equal(clozeBlankKeyAction(key('Enter', { isComposing: true }), { blankIds: ['b1'], currentId: 'b1', values: { b1: 'x' } }), null, 'IME Enter is ignored');
  assert.equal(clozeBlankKeyAction(key('Enter', { keyCode: 229 }), { blankIds: ['b1'], currentId: 'b1', values: { b1: 'x' } }), null, 'legacy IME keyCode 229 is ignored');
  assert.equal(clozeBlankKeyAction(key('Escape', { isComposing: true }), { blankIds: ['b1'], currentId: 'b1', values: {} }), null, 'IME Escape cancels composition first');
  assert.deepEqual(clozeBlankKeyAction(key('Escape'), { blankIds: ['b1'], currentId: 'b1', values: {} }), { type: 'blur' }, 'Escape returns focus to the card');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1'], currentId: 'b1', values: {} }), { type: 'noop' }, 'single empty blank does not submit');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1'], currentId: 'b1', values: { b1: 'ok' } }), { type: 'submit' }, 'single filled blank submits');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b1', values: { b1: 'one', b2: '' } }), { type: 'focus', id: 'b2' }, 'Enter moves from filled blank 1 to empty blank 2');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b2', values: { b1: '', b2: 'two' } }), { type: 'focus', id: 'b1' }, 'Enter wraps back to an earlier empty blank');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b1', values: { b1: '', b2: 'two' } }), { type: 'noop' }, 'stays on the only empty blank');
  assert.deepEqual(clozeBlankKeyAction(key('Enter'), { blankIds: ['b1', 'b2'], currentId: 'b2', values: { b1: 'one', b2: 'two' } }), { type: 'submit' }, 'all filled submits on Enter');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { ctrlKey: true }), { blankIds: ['b1', 'b2'], currentId: 'b1', values: { b1: 'one' } }), { type: 'submit' }, 'Ctrl+Enter submits with >=1 blank filled');
  assert.deepEqual(clozeBlankKeyAction(key('Enter', { metaKey: true }), { blankIds: ['b1', 'b2'], currentId: 'b1', values: {} }), { type: 'noop' }, 'Cmd+Enter with all empty does nothing');
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
  assert.equal(assistRunningOn(tasks, 'g'), true, '批改 arrives through the same poll, so it keeps the quick rhythm too');
  assert.equal(assistRunningOn(tasks, 'y'), false);
  assert.equal(assistRunningOn([{ cardId: 'c', status: 'done', mode: 'ask' }], 'c'), false);
  assert.equal(assistRunningOn(undefined, 'c'), false);

  // The page asks at once when a task on the open question ends (its answer or its 批改 is in the run): which task to watch, whatever its mode.
  const own = [{ id: 't1', cardId: 'g', status: 'running', mode: 'grade' }];
  assert.deepEqual(finishedTask('', own, 'g'), { watch: 't1', done: false }, 'a running 批改 is watched');
  assert.deepEqual(finishedTask('t1', [{ ...own[0], status: 'done' }], 'g'), { watch: '', done: true }, 'it ended: ask now');
  assert.deepEqual(finishedTask('t1', [{ ...own[0], status: 'failed' }], 'g'), { watch: '', done: false }, 'a failed task brings nothing to show');
  assert.deepEqual(finishedTask('', [], 'g'), { watch: '', done: false });
});
