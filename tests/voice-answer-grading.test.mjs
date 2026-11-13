/* #1031 · voice is an input method; what it needs from grading is honest background grading of a practice answer. These tests drive the panel's own ops
   (review.*, the assist service's grade job) on a real library with a scripted model:
   - a question being graded is answered, pending: navigation never sends the learner back to it and nothing grades it twice;
   - the marker clears on commit, on failure, and by itself after a restart;
   - a plain open question's first AI grade derives criteria from the reference answer and every later grade reuses them;
   - fragments-only answers never pass; a miss read after the learner had left waits for 我看懂了 before its tail retry;
   - review.grade.adjust keeps the original grade and moves prerequisite credit with the new one;
   - the host's 当前题已切换 check is back for help on a question that is no longer on screen. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createAssistService } from '../lib/assist.js';
import { createHostHandler } from '../lib/host.js';
import { GRADING_BUSY } from '../lib/contexts/study/grading-marker.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';

const evidence = 'Idempotent retries with exponential backoff keep a payment service from charging twice when a request times out.';
const open = (id, extra = {}) => ({ id, kind: 'open', topic: 'Retries', objective: 'Explain safe retries', prompt: `Why must retries of a payment be idempotent? (${id})`,
  answer: 'Because a timed-out request may have succeeded; an idempotency key lets the server recognise the repeat, and backoff avoids a retry storm.',
  hint: 'Think about a timeout.', explanation: 'The client cannot tell a lost reply from a lost request.', misconception: 'Retrying is always safe.',
  citations: [{ sourceId: 's', quote: evidence }], ...extra });
const ANSWER = 'An idempotency key lets the server spot the repeat; backoff avoids a storm.';
const until = async (predicate, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('did not settle'); };
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** A grader that marks every criterion at `ratio`, deriving two criteria when asked, with the given extras on the question. */
function grader({ ratio = 1, extra = {}, hold, seen = [] } = {}) {
  return async (system, prompt) => {
    if (!system.startsWith('You grade')) return '{}';
    const data = JSON.parse(prompt);
    seen.push(data);
    if (hold) await hold();
    return JSON.stringify({ summary: 'ok', questions: data.questions.map((question) => {
      const criteria = question.deriveCriteria
        ? [{ id: 'c1', label: 'Why a repeat is possible', marks: 2, keyPoints: ['a timed-out request may have succeeded'] },
          { id: 'c2', label: 'How the server tells', marks: 2, keyPoints: ['idempotency key'] }]
        : question.criteria;
      return { cardId: question.cardId, ...(question.deriveCriteria ? { rubric: criteria } : {}),
        criteria: criteria.map((criterion) => ({ id: criterion.id, score: criterion.marks * ratio, evidence: [], missing: [] })), summary: 'marked', ...extra };
    }) });
  };
}

async function library(t, complete, { cards = [open('o1'), open('o2')], courses = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-voice-grade-'));
  const assist = createAssistService();
  const service = new StudyService(root, { complete: (...args) => complete.current(...args) });
  t.after(async () => { assist.dispose(); service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update((s) => {
    s.sources.push({ id: 's', title: 'Reliability', text: evidence });
    s.courses = courses;
    s.decks.push({ id: 'd', title: 'Reliability', course: 'Systems', cards: structuredClone(cards) });
  });
  const start = async (cardIds = cards.map((card) => card.id)) => {
    const run = await service.call('review.start', { mode: 'path', scope: cardIds.map((cardId) => ({ deckId: 'd', cardId })), fresh: true });
    return run;
  };
  const grade = async (runId, cardId, text = ANSWER) => {
    const state = await service.store.read();
    return assist.startAssist({}, { root, service, sessionId: 'panel', mode: 'grade', ref: { deckId: 'd', cardId }, runId, text,
      card: state.decks[0].cards.find((card) => card.id === cardId), deckTitle: 'Reliability', language: 'en' });
  };
  const settled = async (taskId) => { await until(() => assist.assistView(root).tasks.find((task) => task.id === taskId)?.status !== 'running');
    return assist.assistView(root).tasks.find((task) => task.id === taskId); };
  const entryOf = async (runId, index) => (await service.store.read()).runs.find((run) => run.id === runId).entries[index];
  return { root, service, assist, start, grade, settled, entryOf };
}

const indexOf = (run, cardId) => run.navigation.find((item) => item.cardId === cardId).index;

test('a question being graded counts as answered, pending: no way back to it, and nothing grades it twice', async (t) => {
  const release = gate(), complete = { current: grader({ hold: () => release.promise }) };
  const f = await library(t, complete, { cards: [open('o1'), open('o2'), open('o3')] });
  const run = await f.start();
  const first = run.card.id, at = run.index;
  const task = await f.grade(run.id, first);
  let view = await f.service.call('review.get', { runId: run.id });
  assert.equal(view.grading, true, 'the open question says it is being graded');
  assert.deepEqual([view.navigation[at].answered, view.navigation[at].grading], [true, true]);
  // Autopilot moves on to the next question; 下一题 from there never goes back to the one being graded.
  const second = view.navigation.find((item) => item.index !== at);
  await f.service.call('review.move', { runId: run.id, index: second.index });
  await f.service.call('review.reveal', { runId: run.id, cardId: second.cardId });
  await f.service.call('review.answer', { runId: run.id, cardId: second.cardId, grade: 4 });
  view = await f.service.call('review.move', { runId: run.id, direction: 1 });
  assert.notEqual(view.index, at, '下一题 skips the question being graded');
  assert.notEqual(view.card?.id, first);
  // Back on it by hand (←): it cannot be answered, revealed or sent for grading again while its job runs.
  await f.service.call('review.move', { runId: run.id, index: at });
  await assert.rejects(f.service.call('review.reveal', { runId: run.id, cardId: first }), new RegExp(GRADING_BUSY));
  await assert.rejects(f.service.call('review.answer', { runId: run.id, cardId: first, grade: 5 }), new RegExp(GRADING_BUSY));
  await assert.rejects(f.grade(run.id, first), new RegExp(GRADING_BUSY));
  assert.equal(f.assist.assistView(f.root).tasks.length, 1, 'the refused second grade started nothing');
  release.resolve();
  assert.equal((await f.settled(task.id)).status, 'done');
  const state = await f.service.store.read();
  assert.equal(state.attempts.filter((item) => item.quiz_id === first && !item.implicit).length, 1, 'one attempt for one answer');
  assert.equal(state.runs[0].entries[at].grading, undefined, 'the commit cleared the marker');
  assert.equal(state.runs[0].entries[at].feedback.grade, 5);
});

test('a failed grade job clears its marker: the question is waiting again', async (t) => {
  const complete = { current: async () => { throw new Error('model unavailable'); } };
  const f = await library(t, complete);
  const run = await f.start();
  const task = await f.grade(run.id, run.card.id);
  assert.equal((await f.settled(task.id)).status, 'failed');
  await until(async () => !(await f.entryOf(run.id, run.index)).grading);
  const view = await f.service.call('review.get', { runId: run.id });
  assert.equal(view.navigation[run.index].answered, false);
  assert.equal(view.grading, undefined);
  // 重新提交 works: a new job may hold it.
  complete.current = grader();
  const again = await f.grade(run.id, run.card.id);
  assert.equal((await f.settled(again.id)).status, 'done');
});

test('after a restart a marker with no live job clears itself and never blocks the question', async (t) => {
  const f = await library(t, { current: grader() });
  const run = await f.start();
  await f.service.store.update((s) => { s.runs[0].entries[run.index].grading = { taskId: 'gone', since: new Date().toISOString(), boot: 'an-earlier-process' }; });
  const view = await f.service.call('review.get', { runId: run.id });
  assert.equal(view.navigation[run.index].answered, false, 'the stale marker does not count as answered');
  assert.equal(view.grading, undefined);
  await f.service.call('review.reveal', { runId: run.id, cardId: run.card.id });
  await f.service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 3 });
  assert.equal((await f.entryOf(run.id, run.index)).grading, undefined, 'the next write dropped it');
});

test('the first AI grade of a plain open question derives criteria once; later grades reuse them', async (t) => {
  const seen = [], complete = { current: grader({ seen }) };
  const f = await library(t, complete, { cards: [open('o1')] });
  const first = await f.start();
  assert.equal((await f.settled((await f.grade(first.id, 'o1')).id)).status, 'done');
  assert.equal(seen[0].questions[0].deriveCriteria, true);
  assert.deepEqual(seen[0].questions[0].criteria, []);
  const stored = (await f.service.store.read()).decks[0].cards[0].autoRubric;
  assert.deepEqual(stored.criteria.map((item) => item.label), ['Why a repeat is possible', 'How the server tells']);
  const view = await f.service.call('review.get', { runId: first.id });
  assert.equal(view.feedback.rubric.max, 4, 'marked like a rubric card');
  assert.equal(view.card.rubricCriteria, undefined, 'derived criteria are not shown before an answer');
  const second = await f.start();
  assert.equal((await f.settled((await f.grade(second.id, 'o1')).id)).status, 'done');
  assert.equal(seen[1].questions[0].deriveCriteria, undefined, 'the second grade does not derive again');
  assert.deepEqual(seen[1].questions[0].criteria.map((item) => item.label), ['Why a repeat is possible', 'How the server tells']);
  assert.deepEqual((await f.service.store.read()).decks[0].cards[0].autoRubric, stored, 'stored once');
});

test('a flashcard is AI-graded only when its course asked for it', async (t) => {
  const flash = { ...open('f1'), kind: 'flashcard' };
  const f = await library(t, { current: grader() }, { cards: [flash] });
  const run = await f.start();
  await assert.rejects(f.grade(run.id, 'f1'), /没有评分标准/);
  await f.service.call('course.save', { name: 'Systems', practice: { aiGradeFlashcards: true } });
  assert.equal((await f.settled((await f.grade(run.id, 'f1')).id)).status, 'done');
  assert.ok((await f.service.store.read()).decks[0].cards[0].autoRubric);
});

test('fragments only never pass: full marks for disconnected keywords still grade 2 or below', async (t) => {
  const f = await library(t, { current: grader({ ratio: 1, extra: { fragmentsOnly: true, correction: {
    keywordExpansion: 'Say why the repeat happens, then how the key catches it.', missingLinks: ['a timed-out request may have succeeded'] } } }) });
  const run = await f.start();
  assert.equal((await f.settled((await f.grade(run.id, run.card.id, 'idempotency key, backoff')).id)).status, 'done');
  const view = await f.service.call('review.get', { runId: run.id });
  assert.equal(view.feedback.grade, 2);
  assert.equal(view.feedback.correct, false);
  assert.equal(view.feedback.correction.fragmentsOnly, true);
  assert.deepEqual(view.feedback.correction.missingLinks, ['a timed-out request may have succeeded']);
});

test('a miss read on screen is as before; a miss that lands after the learner left waits for 我看懂了 before its retry', async (t) => {
  const release = gate();
  let hold = false;
  const complete = { current: grader({ ratio: 0, hold: () => (hold ? release.promise : null) }) };
  const f = await library(t, complete);
  // On screen: no gate, no retry queued (as rubric grading always was).
  let run = await f.start();
  assert.equal((await f.settled((await f.grade(run.id, run.card.id)).id)).status, 'done');
  let view = await f.service.call('review.get', { runId: run.id });
  assert.equal(view.feedback.correctionPending, undefined);
  assert.equal(view.correctionsPending, undefined);
  // Left: the grade lands while another question is on screen.
  hold = true;
  run = await f.start();
  const at = run.index, cardId = run.card.id;
  const task = await f.grade(run.id, cardId);
  const other = (await f.service.call('review.get', { runId: run.id })).navigation.find((item) => item.index !== at);
  await f.service.call('review.move', { runId: run.id, index: other.index });
  release.resolve();
  assert.equal((await f.settled(task.id)).status, 'done');
  let entries = (await f.service.store.read()).runs.find((item) => item.id === run.id).entries;
  assert.equal(entries[at].feedback.correctionPending, true);
  assert.equal(entries.filter((entry) => entry.retry).length, 0, 'no retry before the correction is read');
  view = await f.service.call('review.get', { runId: run.id });
  assert.equal(view.correctionsPending, 1);
  const pending = await f.service.call('review.lookBack', { runId: run.id, pending: true });
  assert.deepEqual(pending.rows.map((row) => [row.cardId, row.entryIndex, row.correctionPending]), [[cardId, at, true]]);
  assert.equal((await f.service.call('review.lookBack', { runId: run.id })).rows.length, 0, 'the full look-back still waits for the end of the round');
  view = await f.service.call('review.correction.ack', { runId: run.id, entryIndex: at, cardId });
  assert.equal(view.correctionsPending, undefined);
  entries = (await f.service.store.read()).runs.find((item) => item.id === run.id).entries;
  assert.deepEqual(entries.filter((entry) => entry.retry).map((entry) => entry.card.id), [cardId], 'the retry is at the tail');
  assert.equal(entries.at(-1).retry, true);
  await assert.rejects(f.service.call('review.correction.ack', { runId: run.id, entryIndex: at, cardId }), /没有待看的订正/);
});

test('a wrong typed answer still queues its tail retry through the same helper', async (t) => {
  const cloze = { id: 'z1', kind: 'cloze', topic: 'Retries', objective: 'Name the key', prompt: 'Fill in', answer: 'idempotency key', hint: 'h', explanation: 'e', misconception: 'm',
    cloze: { text: 'Retries need an {{b1}}.', answers: [{ id: 'b1', value: 'idempotency key', accept: [] }] }, citations: [{ sourceId: 's', quote: evidence }] };
  const f = await library(t, { current: grader() }, { cards: [cloze] });
  const run = await f.start();
  await f.service.call('review.answer', { runId: run.id, cardId: 'z1', answers: { b1: 'a lock' } });
  const entries = (await f.service.store.read()).runs[0].entries;
  assert.deepEqual(entries.map((entry) => !!entry.retry), [false, true]);
  assert.equal(entries[0].feedback.retryQueued, true);
});

test('review.grade.adjust keeps the AI grade, reschedules from before the answer and moves prerequisite credit', async (t) => {
  const pre = { ...open('p1'), kind: 'flashcard', prompt: 'What is an idempotency key?' };
  const f = await library(t, { current: grader({ ratio: 1 }) }, { cards: [open('o1', { requires: [{ deckId: 'd', cardId: 'p1' }] }), pre] });
  const run = await f.start(['o1']);
  // A path round puts the prerequisite first; the learner opens the question itself.
  const at = indexOf(run, 'o1');
  await f.service.call('review.move', { runId: run.id, index: at });
  assert.equal((await f.settled((await f.grade(run.id, 'o1')).id)).status, 'done');
  let state = await f.service.store.read();
  const preBefore = structuredClone(state.attempts.find((item) => item.implicit).before);
  assert.equal(state.attempts.filter((item) => item.implicit).length, 1, 'the pass credited its prerequisite');
  await f.service.call('review.grade.adjust', { runId: run.id, entryIndex: at, cardId: 'o1', grade: 1 });
  state = await f.service.store.read();
  const entry = state.runs[0].entries[at], attempt = state.attempts.find((item) => item.quiz_id === 'o1');
  assert.deepEqual([entry.feedback.grade, entry.feedback.gradeOriginal, entry.feedback.correct], [1, 5, false]);
  assert.deepEqual([attempt.grade, attempt.gradeOriginal], [1, 5], 'the attempt keeps the original next to the new grade');
  assert.deepEqual(attempt.before, entry.reviewBefore ?? attempt.before);
  assert.equal(state.attempts.filter((item) => item.implicit).length, 0, 'the credit went with the pass');
  assert.deepEqual(state.decks[0].cards.find((card) => card.id === 'p1').review, preBefore);
  await f.service.call('review.grade.adjust', { runId: run.id, entryIndex: at, cardId: 'o1', grade: 4 });
  state = await f.service.store.read();
  assert.equal(state.runs[0].entries[at].feedback.gradeOriginal, 5, 'the original stays the first AI grade');
  assert.equal(state.attempts.filter((item) => item.implicit).length, 1, 'a pass again credits again');
});

test('review.grade.adjust refuses a self-grade, a retry, an exam and a closed round', async (t) => {
  const f = await library(t, { current: grader({ ratio: 1 }) });
  const run = await f.start();
  const other = (await f.service.call('review.get', { runId: run.id })).navigation.find((item) => item.index !== run.index);
  await f.service.call('review.move', { runId: run.id, index: other.index });
  await f.service.call('review.reveal', { runId: run.id, cardId: other.cardId });
  await f.service.call('review.answer', { runId: run.id, cardId: other.cardId, grade: 1 });
  await assert.rejects(f.service.call('review.grade.adjust', { runId: run.id, entryIndex: other.index, cardId: other.cardId, grade: 4 }), /只有 AI 批改/);
  const retryIndex = (await f.service.store.read()).runs[0].entries.findIndex((entry) => entry.retry);
  await assert.rejects(f.service.call('review.grade.adjust', { runId: run.id, entryIndex: retryIndex, cardId: other.cardId, grade: 4 }), /只有 AI 批改/);
  await f.service.call('review.move', { runId: run.id, index: run.index });
  assert.equal((await f.settled((await f.grade(run.id, run.card.id)).id)).status, 'done');
  await f.service.call('review.end', { runId: run.id });
  await assert.rejects(f.service.call('review.grade.adjust', { runId: run.id, entryIndex: run.index, cardId: run.card.id, grade: 2 }), /已经结束/);
  await f.service.store.update((s) => { s.runs[0].mode = 'exam'; });
  await assert.rejects(f.service.call('review.grade.adjust', { runId: run.id, entryIndex: run.index, cardId: run.card.id, grade: 2 }), /模拟考/);
});

test('the main chat cannot hold, read off or change a practice grade', () => {
  for (const action of ['review.grading', 'review.correction.ack', 'review.grade.adjust', 'audio.clip.transcribe'])
    assert.match(assistantRefusal(action), /not available to the assistant/, action);
});

test('help on a question that is no longer on screen is refused again (当前题已切换), voice or not', async (t) => {
  const f = await library(t, { current: async () => '{"answer":"x"}' });
  const run = await f.start();
  const other = run.navigation.find((item) => item.index !== run.index);
  const ctx = { sessions: { get: () => ({ header: { cwd: f.root } }) }, get: () => undefined };
  const handle = createHostHandler(ctx, { libraryRoot: f.root }, undefined, { assist: f.assist });
  const reply = await handle('call', { sessionId: 'parent', action: 'assist.start',
    args: { deckId: 'd', cardId: other.cardId, runId: run.id, mode: 'ask', text: 'why?', uploadId: 'a1b2c3d4e5f6' } }).catch((error) => ({ ok: false, error: error.message }));
  assert.equal(reply.ok, false);
  assert.match(JSON.stringify(reply), /当前题已切换/);
  assert.equal(f.assist.assistView(f.root).tasks.length, 0);
});

test('a grade still lands, and its marker still clears, after the round was edited under it; the question being graded cannot be removed', async (t) => {
  for (const outcome of ['done', 'failed']) {
    const release = gate();
    const complete = { current: outcome === 'done' ? grader({ hold: () => release.promise }) : async () => { await release.promise; throw new Error('model unavailable'); } };
    const f = await library(t, complete, { cards: [open('o1'), open('o2'), open('o3')] });
    const run = await f.start(['o1', 'o2', 'o3']);
    await f.service.call('review.move', { runId: run.id, index: 1 });
    const task = await f.grade(run.id, 'o2');
    // The main chat cannot take a question out of the round while it is graded.
    const kept = await f.service.call('review.queue.edit', { runId: run.id, remove: [{ cardId: 'o2' }], allowCurrent: true });
    assert.deepEqual(kept.removed, [], `${outcome}: the question being graded stays`);
    // The learner goes back to the first question, and it is taken out of the round: the graded one moves from place 1 to place 0.
    await f.service.call('review.move', { runId: run.id, index: 0 });
    const edited = await f.service.call('review.queue.edit', { runId: run.id, remove: [{ cardId: 'o1' }], allowCurrent: true });
    assert.deepEqual(edited.removed.map((item) => item.cardId), ['o1']);
    release.resolve();
    assert.equal((await f.settled(task.id)).status, outcome);
    const entry = (await f.service.store.read()).runs[0].entries.find((item) => item.card.id === 'o2');
    await until(async () => !(await f.service.store.read()).runs[0].entries.find((item) => item.card.id === 'o2').grading);
    if (outcome === 'done') assert.equal(entry.feedback?.grade, 5, 'the grade landed on the question it was for');
    else assert.equal(entry.feedback, null, 'the failed job left the question waiting again');
  }
});

test('a grade job that fails after the round was ended still clears its marker', async (t) => {
  const release = gate();
  const f = await library(t, { current: async () => { await release.promise; throw new Error('model unavailable'); } });
  const run = await f.start();
  const task = await f.grade(run.id, run.card.id);
  await f.service.call('review.end', { runId: run.id });
  release.resolve();
  assert.equal((await f.settled(task.id)).status, 'failed');
  await until(async () => !(await f.entryOf(run.id, run.index)).grading);
});

test('改分 never overwrites a newer review of the question: once it was reviewed again, the old grade cannot be changed', async (t) => {
  const f = await library(t, { current: grader({ ratio: 1 }) }, { cards: [open('o1')] });
  const run = await f.start(['o1']);
  assert.equal((await f.settled((await f.grade(run.id, 'o1')).id)).status, 'done');
  const newer = { ...(await f.service.store.read()).decks[0].cards[0].review, due_at: '2099-01-01T00:00:00.000Z', reps: 99 };
  await f.service.store.update((s) => { s.decks[0].cards[0].review = structuredClone(newer); });
  await assert.rejects(f.service.call('review.grade.adjust', { runId: run.id, entryIndex: run.index, cardId: 'o1', grade: 1 }), /又复习过/);
  const state = await f.service.store.read();
  assert.deepEqual(state.decks[0].cards[0].review, newer, 'the newer review is untouched');
  assert.equal(state.runs[0].entries[run.index].feedback.grade, 5, 'and so is the grade');
});
