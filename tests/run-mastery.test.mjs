/* 这组题掌握度 a% → b% (lib/run-mastery.js): every round that starts stores the mastery of its own questions before the first answer, and its
   finished projection carries { before, after } on the same cards. Reader rounds keep their pages' numbers (run.scope); runs stored before 3.6
   (no `run.mastery`) show nothing, except a reader round, whose `before` was kept in `run.reading`. The real runtime runs here; no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { masteryAtStart, masteryBefore, masteryCards, masteryView, scopeSummary } from '../lib/run-mastery.js';
import { readingView, scopeSummary as readingScopeSummary } from '../lib/reading-return.js';
import { startPracticeRun } from '../lib/daily-plan/practice-run.js';

const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const options = [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }];
const quiz = (id, extra = {}) => ({ id, kind: 'quiz', topic: 'CAP', objective: `Objective ${id}`, prompt: `${id}?`, answer: 'a', explanation: 'Because.', options, citations: [], ...extra });
const flash = (id, extra = {}) => ({ id, kind: 'flashcard', topic: 'CAP', objective: `Objective ${id}`, prompt: `${id}?`, answer: 'Answer', explanation: 'Because.', citations: [], ...extra });
const mastered = { repetitions: 4, interval_days: 30, ease_factor: 2.5, due_at: iso(Date.now() + 30 * DAY) };
const dueWeak = { repetitions: 1, interval_days: 1, ease_factor: 2.3, due_at: iso(Date.now() - DAY) };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'run-mastery-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update(s => {
    s.decks.push({ id: 'd', title: 'Consistency', course: 'Distributed', folder: '', cards: [
      quiz('q1', { review: dueWeak }), quiz('q2', { review: mastered }), quiz('q3'), quiz('q4'), flash('f1', { review: mastered }), flash('f2'), quiz('gone', { suspended: true })] });
    s.attempts.push({ id: 'old-1', runId: 'old', quiz_id: 'q1', deckId: 'd', topic: 'CAP', timestamp: iso(Date.now() - 2 * DAY), grade: 1, elapsed_ms: 3000 });
  });
  const stored = async id => (await service.store.read()).runs.find(run => run.id === id);
  return { root, service, stored };
}

/** The stored `before` is the mastery, at the start, of exactly the run's cards (its questions; a reader round's pages). */
async function assertStoredBefore(f, run, what) {
  const kept = await f.stored(run.id);
  assert.equal(kept.mastery?.v, 1, `${what}: run.mastery is stored`);
  const expected = scopeSummary(await f.service.store.read(), masteryCards(kept));
  assert.deepEqual(kept.mastery.before, expected, `${what}: before is the mastery of its own cards`);
  assert.ok(kept.mastery.before.total > 0, `${what}: some questions were measured`);
  return kept;
}

async function answerAll(service, run, grade = 5) {
  for (let guard = 0; guard < 40 && !run.complete; guard++) {
    const ref = { runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion };
    if (run.card.kind === 'flashcard') { await service.call('review.reveal', ref); run = await service.call('review.answer', { ...ref, grade }); }
    else run = await service.call('review.answer', { ...ref, selected: [grade >= 3 ? 'a' : 'b'] });
    if (!run.complete && run.feedback) run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return run;
}

test('every review.start mode stores the mastery of its own questions before the first answer', async t => {
  const f = await fixture(t);
  const starts = [
    ['a deck round (开始学习)', { mode: 'path', scope: [{ deckId: 'd' }], fresh: true }],
    ['quiz', { mode: 'quiz', deckId: 'd', fresh: true }],
    ['flashcard', { mode: 'flashcard', deckId: 'd', fresh: true }],
    ['due', { mode: 'due', deckId: 'd', fresh: true }],
    ['wrong', { mode: 'wrong', deckId: 'd', fresh: true }],
    ['new questions of a deck', { mode: 'new', deckId: 'd', fresh: true }],
    ['new questions of a scope', { mode: 'new', scope: [{ deckId: 'd' }], count: 2, fresh: true }],
    ['a course batch', { mode: 'course', course: 'Distributed', fresh: true }],
    ["a course's daily round", { mode: 'path', course: 'Distributed', daily: true, fresh: true }],
    ['a topic', { mode: 'path', scope: [{ deckId: 'd', topic: 'CAP' }], fresh: true }],
    ['a mock exam', { mode: 'exam', scope: [{ deckId: 'd' }], count: 2, examKinds: 'all', fresh: true }],
  ];
  for (const [what, args] of starts) {
    const run = await f.service.call('review.start', args);
    const kept = await assertStoredBefore(f, run, what);
    const refs = masteryCards(kept);
    assert.deepEqual(refs, kept.entries.filter(entry => !entry.retry).map(entry => ({ deckId: entry.deckId ?? kept.deckId, cardId: entry.card.id })), `${what}: measured on its questions`);
    assert.ok(!refs.some(ref => ref.cardId === 'gone'), `${what}: a suspended card is not a question of the round`);
  }
});

test('the weak-question round and a prerequisite-style round (review.start inside another operation) store it too', async t => {
  const f = await fixture(t);
  let run = await f.service.call('review.start', { mode: 'quiz', deckId: 'd', fresh: true });
  run = await answerAll(f.service, run, 1);
  const weak = await f.service.call('review.weak.start', { runId: run.id });
  await assertStoredBefore(f, weak, 'review.weak.start');
});

test('a learning-flow practice step and a daily-plan task store it when they start their round', async t => {
  const f = await fixture(t);
  const template = await f.service.call('workflow.save', { title: '练习', steps: [{ id: 'practice', kind: 'practice', title: '题目练习', count: 3 }] });
  const session = await f.service.call('workflow.session.start', { templateId: template.id, topic: 'CAP', scope: [{ deckId: 'd' }], requestId: 'start' });
  const { run } = await f.service.call('workflow.practice.start', { id: session.id, version: session.version });
  await assertStoredBefore(f, run, 'workflow.practice.start');

  const scope = [{ deckId: 'd', cardId: 'q2' }, { deckId: 'd', cardId: 'q3' }];
  const card = { id: 'task-1', learningTask: { kind: 'practice', scope }, studyRef: { id: 'd', root: f.root } };
  const daily = await startPracticeRun(f.service.store, card, f.root);
  const kept = await assertStoredBefore(f, daily, 'a daily-plan practice task');
  assert.equal(kept.mastery.before.total, 2);
  // Opened again with a changed scope before any answer: the before is of the questions it has now.
  card.learningTask.scope = [...scope, { deckId: 'd', cardId: 'f1' }];
  const again = await startPracticeRun(f.service.store, card, f.root);
  assert.equal(again.id, daily.id);
  assert.equal((await assertStoredBefore(f, again, 'the same task, its scope changed')).mastery.before.total, 3);
});

test('a reader round measures the cards of its pages, as before, and the reading view reads the generic value', async t => {
  const f = await fixture(t);
  const scope = [{ deckId: 'd', cardId: 'q2' }, { deckId: 'd', cardId: 'q3' }];
  const run = await f.service.call('review.start', { mode: 'path', scope, fresh: true,
    reading: { documentId: 'doc', sourceId: 'doc-p1', page: 1, sectionTitle: 'CAP', scope: { kind: 'here', count: 1, label: 'p.1' } } });
  const kept = await assertStoredBefore(f, run, 'a reader round');
  assert.deepEqual(masteryCards(kept), scope, 'its pages\' cards: the run scope');
  assert.equal(kept.reading.before, undefined, 'the reading context no longer keeps a copy');
  assert.equal(run.reading.before.percent, 50, 'one new card and one mastered card, as the reader always said');
  assert.deepEqual(run.reading.before, kept.mastery.before);
  assert.equal(readingScopeSummary, scopeSummary, 'one implementation, re-exported for the reader');
});

test('finished: the projection carries before and after on the same cards; before stays, after follows the answers', async t => {
  const f = await fixture(t);
  let run = await f.service.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'q3' }, { deckId: 'd', cardId: 'q4' }, { deckId: 'd', cardId: 'q2' }], fresh: true });
  assert.equal(run.mastery, undefined, 'an open round does not compute it (the result page is the only place that shows it)');
  const before = (await f.stored(run.id)).mastery.before;
  run = await answerAll(f.service, run, 5);
  assert.equal(run.complete, true);
  assert.deepEqual(run.mastery.before, before);
  assert.ok(run.mastery.after.percent > before.percent, `${run.mastery.after.percent} > ${before.percent}`);
  assert.deepEqual(run.mastery.after, scopeSummary(await f.service.store.read(), masteryCards(await f.stored(run.id))));
  const again = await f.service.call('review.get', { runId: run.id });
  assert.deepEqual(again.mastery, run.mastery, 'stored with the run, not in memory');
  // Ended early: the result page of an ended round says it too.
  let ended = await f.service.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'f2' }], fresh: true });
  ended = await f.service.call('review.end', { runId: ended.id });
  assert.equal(ended.complete, true);
  assert.equal(ended.mastery.before.percent, ended.mastery.after.percent);
});

test('runs stored before 3.6: without the value there is no change to show; an old reader round keeps its own before', async t => {
  const f = await fixture(t);
  const run = await f.service.call('review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'q3' }], fresh: true });
  await f.service.store.update(s => { delete s.runs.find(item => item.id === run.id).mastery; });
  const old = await f.service.call('review.end', { runId: run.id });
  assert.equal(old.complete, true);
  assert.equal(old.mastery, undefined, 'an old run shows no line');

  const state = await f.service.store.read();
  const legacy = { scope: [{ deckId: 'd', cardId: 'q2' }, { deckId: 'd', cardId: 'q3' }], entries: [],
    reading: { v: 1, documentId: 'doc', sourceId: 'doc-p1', before: { percent: 12, total: 2, state: 'learning', due: 0, weak: 0, fresh: 1 } } };
  assert.deepEqual(masteryBefore(legacy), legacy.reading.before);
  assert.equal(readingView(state, legacy).before.percent, 12, 'an old reader round still shows what it stored');
  assert.equal(masteryView(state, legacy).after.percent, 50);
  assert.equal(masteryView(state, { entries: [{ deckId: 'd', card: { id: 'q3' } }] }), null);
});

test('pure: the cards of a round are its questions once each, tail retries left out, a missing entry deck taken from the run', () => {
  const run = { deckId: 'd', entries: [{ card: { id: 'a' } }, { deckId: 'e', card: { id: 'b' } }, { card: { id: 'a' }, retry: true }] };
  assert.deepEqual(masteryCards(run), [{ deckId: 'd', cardId: 'a' }, { deckId: 'e', cardId: 'b' }]);
  const state = { attempts: [], decks: [{ id: 'd', cards: [{ id: 'a', review: mastered }] }, { id: 'e', cards: [{ id: 'b' }] }] };
  assert.deepEqual(masteryAtStart(state, run), { v: 1, before: scopeSummary(state, masteryCards(run)) });
  assert.equal(masteryAtStart(state, run).before.percent, 50);
});
