import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperations } from '../lib/contexts/study/operations.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projection } from '../lib/study-state.js';
import { StudyService } from '../lib/service.js';
import { commitRubricGrade } from '../lib/rubric-grading.js';

test('review.draft.save persists draft text, options and assistance onto run entry', async () => {
  const run = {
    id: 'run-test-1',
    mode: 'path',
    deckId: 'deck-1',
    index: 0,
    entries: [
      {
        card: { id: 'c1', prompt: 'Explain gravity', kind: 'essay', topic: 'Physics' },
        deckId: 'deck-1',
        startedAt: Date.now(),
      },
    ],
  };

  const state = {
    runs: [run],
    decks: [{ id: 'deck-1', cards: [run.entries[0].card] }],
    sources: [],
    attempts: [],
    teaching: [],
  };

  const ports = {
    state: {
      read: async () => state,
      update: async (fn) => fn(state),
    },
    work: { translateInflight: new Map() },
  };

  const { mutations } = createOperations(ports);

  // Save partial text draft and assistance marker
  const saveRes = mutations['review.draft.save'](state, {
    runId: 'run-test-1',
    cardId: 'c1',
    draft: { text: 'Gravity is the curvature of spacetime...' },
    assistance: { hintUsed: true, askedTutorBeforeAnswer: true },
  });

  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.cardId, 'c1');
  assert.equal(saveRes.draft.text, 'Gravity is the curvature of spacetime...');
  assert.equal(saveRes.assistance.hintUsed, true);
  assert.equal(saveRes.assistance.askedTutorBeforeAnswer, true);
  assert.equal(saveRes.assistance.used, true);

  // Projection reflects saved draft and assistance
  const projected = projection(state, run);
  assert.equal(projected.draft.text, 'Gravity is the curvature of spacetime...');
  assert.equal(projected.assistance.hintUsed, true);
  assert.equal(projected.assistance.used, true);

  // Simulate process restart by cloning state
  const reloadedState = structuredClone(state);
  const reloadedRun = reloadedState.runs[0];
  const reloadedProjected = projection(reloadedState, reloadedRun);

  assert.equal(reloadedProjected.draft.text, 'Gravity is the curvature of spacetime...');
  assert.equal(reloadedProjected.assistance.askedTutorBeforeAnswer, true);
});

const flash = (id) => ({ id, kind: 'flashcard', topic: 'T', objective: 'Recall', prompt: `${id}?`, answer: 'A', hint: 'H', explanation: 'E', misconception: '', citations: [] });
const quiz = (id) => ({ id, kind: 'quiz', topic: 'T', objective: 'Recall', prompt: `${id}?`, hint: 'H', explanation: 'E', misconception: '', citations: [],
  options: [{ id: 'a', text: 'yes', correct: true, explanation: 'x' }, { id: 'b', text: 'no', correct: false, explanation: 'y' }] });

async function library(t, cards) {
  const root = await mkdtemp(join(tmpdir(), 'review-draft-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: '', cards }); });
  const run = await service.call('review.start', { mode: 'path', scope: cards.map((card) => ({ deckId: 'd', cardId: card.id })), fresh: true });
  return { service, run };
}
const lastAttempt = async (service) => (await service.store.read()).attempts.at(-1);

test('an answer with no help recorded is independent: a choice answered straight is not marked as helped', async (t) => {
  const { service, run } = await library(t, [quiz('q1')]);
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['a'] });
  assert.deepEqual((await lastAttempt(service)).assistance, { used: false, hintUsed: false, revealedBeforeAnswer: false, askedTutorBeforeAnswer: false });
});

test('flipping a flashcard to grade it is how it is answered, not help', async (t) => {
  const { service, run } = await library(t, [flash('f1')]);
  await service.call('review.reveal', { runId: run.id, cardId: 'f1' });
  await service.call('review.answer', { runId: run.id, cardId: 'f1', grade: 4 });
  assert.equal((await lastAttempt(service)).assistance.used, false);
});

test('help recorded before the answer is on the attempt, whole, and the entry keeps it across saves', async (t) => {
  const { service, run } = await library(t, [quiz('q1')]);
  await service.call('review.draft.save', { runId: run.id, cardId: 'q1', assistance: { hintUsed: true } });
  const second = await service.call('review.draft.save', { runId: run.id, cardId: 'q1', assistance: { askedTutorBeforeAnswer: false } });
  assert.equal(second.assistance.hintUsed, true, 'a later save cannot take evidence back');
  assert.equal(second.assistance.used, true, 'and `used` follows everything recorded, not the last save');
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['a'] });
  assert.deepEqual((await lastAttempt(service)).assistance, { used: true, hintUsed: true, revealedBeforeAnswer: false, askedTutorBeforeAnswer: false });
});

test('empty values are written, so a cleared answer stays cleared', async (t) => {
  const { service, run } = await library(t, [flash('f1')]);
  await service.call('review.draft.save', { runId: run.id, cardId: 'f1', draft: { text: 'typed', selected: ['a'], stepInputs: { x: '1' } } });
  await service.call('review.draft.save', { runId: run.id, cardId: 'f1', draft: { text: '', selected: [], stepInputs: {} } });
  const read = await service.call('review.get', { runId: run.id });
  assert.equal(read.draft.text, '');
  assert.deepEqual(read.draft.selected, []);
  assert.deepEqual(read.draft.stepInputs, {});
});

test('a draft is written to the entry it was typed on: a tail retry of the same card is not the first, answered entry', async (t) => {
  const { service, run } = await library(t, [quiz('q1')]);
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['b'] });
  const moved = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(moved.retry, true, 'a wrong answer queued a retry of the same card');
  await service.call('review.draft.save', { runId: run.id, cardId: 'q1', index: moved.index, queueVersion: moved.queueVersion, draft: { selected: ['a'] }, assistance: { hintUsed: true } });
  const read = await service.call('review.get', { runId: run.id });
  assert.deepEqual(read.draft.selected, ['a'], 'the retry on screen has the draft');
  const stored = (await service.store.read()).runs.find((item) => item.id === run.id);
  assert.equal(stored.entries[0].draft, undefined, 'the answered entry is untouched');
  assert.equal(stored.entries[0].assistance, undefined);
  // Without an index (the main chat's way), the open entry of that card wins over the first entry with its id.
  await service.call('review.draft.save', { runId: run.id, cardId: 'q1', draft: { text: 'open entry' } });
  assert.equal((await service.call('review.get', { runId: run.id })).draft.text, 'open entry');
});

test('a save that lost its question is dropped and says so, without writing and without an error that would block the learner', async (t) => {
  const { service, run } = await library(t, [flash('f1'), flash('f2')]);
  const stale = await service.call('review.draft.save', { runId: run.id, cardId: 'f1', queueVersion: 99, draft: { text: 'old queue' } });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, 'queue');
  assert.equal((await service.call('review.get', { runId: run.id })).draft, null);
  const moved = await service.call('review.draft.save', { runId: run.id, cardId: 'f1', index: 1, draft: { text: 'other card at that place' } });
  assert.equal(moved.stale, 'question');
  assert.equal((await service.call('review.draft.save', { runId: 'gone', cardId: 'f1', draft: { text: 'x' } })).stale, 'run');
  await service.call('review.end', { runId: run.id });
  assert.equal((await service.call('review.draft.save', { runId: run.id, cardId: 'f1', draft: { text: 'late' } })).stale, 'run');
});

test('a rubric grade carries the help recorded on its entry', () => {
  const card = { id: 'o1', kind: 'open', topic: 'T', prompt: 'p', rubricCriteria: [{ id: 'c', text: 'c', points: 2 }] };
  const entry = { deckId: 'd', card: structuredClone(card), startedAt: Date.now(), assistance: { used: true, hintUsed: true } };
  const state = { settings: {}, decks: [{ id: 'd', cards: [card] }], runs: [{ id: 'r', index: 0, deckId: 'd', entries: [entry] }], attempts: [], inbox: [], sources: [] };
  commitRubricGrade(state, { ref: { deckId: 'd', cardId: 'o1' }, runId: 'r', answer: 'text', timestamp: new Date().toISOString(),
    grading: { summary: '', questions: [{ cardId: 'o1', total: 2, max: 2, ratio: 1, band: 'full', unanswered: false, criteria: [], unanchored: [], assumptions: [] }] }, entryIndex: 0 });
  assert.equal(state.attempts.at(-1).assistance.hintUsed, true);
  assert.equal(state.attempts.at(-1).assistance.used, true);
});

/* Gate review of #537. */

test('a queue edit that leaves the question in place does not cost the learner a save', async (t) => {
  const { service, run } = await library(t, [flash('f1'), flash('f2'), flash('f3')]);
  const old = run.queueVersion || 0;
  const edited = await service.call('review.queue.edit', { runId: run.id, remove: [{ cardId: 'f3' }] });
  assert.notEqual(edited.queueVersion, old);
  const saved = await service.call('review.draft.save', { runId: run.id, cardId: 'f1', index: 0, queueVersion: old, draft: { text: 'typed before the edit arrived' } });
  assert.equal(saved.ok, true);
  assert.equal((await service.call('review.get', { runId: run.id })).draft.text, 'typed before the edit arrived');
  assert.equal((await service.call('review.draft.save', { runId: run.id, cardId: 'f2', index: 0, queueVersion: old, draft: { text: 'x' } })).stale, 'question', 'another card at that place is still refused');
  assert.equal((await service.call('review.draft.save', { runId: run.id, cardId: 'f1', queueVersion: old, draft: { text: 'no place named' } })).stale, 'queue', 'with no place to check, the version is all there is');
});

test('an answered question takes no more saves, and answering removes its draft', async (t) => {
  const { service, run } = await library(t, [quiz('q1'), flash('f1')]);
  await service.call('review.draft.save', { runId: run.id, cardId: 'q1', index: 0, draft: { text: 'before', selected: ['a'] } });
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['a'] });
  const read = () => service.store.read().then((s) => s.runs.find((item) => item.id === run.id).entries[0]);
  assert.equal('draft' in (await read()), false, 'the answer replaced the draft');
  const late = await service.call('review.draft.save', { runId: run.id, cardId: 'q1', index: 0, draft: { text: 'late' }, assistance: { hintUsed: true } });
  assert.equal(late.ok, false);
  assert.equal(late.stale, 'answered');
  const entry = await read();
  assert.equal('draft' in entry, false);
  assert.equal(entry.assistance, undefined, 'help cannot be added to an answer already given');
});

test('a rubric grade removes the draft of the question it graded', () => {
  const card = { id: 'o1', kind: 'open', topic: 'T', prompt: 'p', rubricCriteria: [{ id: 'c', text: 'c', points: 2 }] };
  const entry = { deckId: 'd', card: structuredClone(card), startedAt: Date.now(), draft: { text: 'text' } };
  const state = { settings: {}, decks: [{ id: 'd', cards: [card] }], runs: [{ id: 'r', index: 0, deckId: 'd', entries: [entry] }], attempts: [], inbox: [], sources: [] };
  commitRubricGrade(state, { ref: { deckId: 'd', cardId: 'o1' }, runId: 'r', answer: 'text', timestamp: new Date().toISOString(),
    grading: { summary: '', questions: [{ cardId: 'o1', total: 2, max: 2, ratio: 1, band: 'full', unanswered: false, criteria: [], unanchored: [], assumptions: [] }] }, entryIndex: 0 });
  assert.equal('draft' in entry, false);
});

test('a stale save writes nothing and does not move the revision; a real one writes only its run', async (t) => {
  const { service, run } = await library(t, [flash('f1')]);
  const revision = async () => (await service.store.read()).revision;
  const before = await revision();
  assert.equal((await service.call('review.draft.save', { runId: run.id, cardId: 'f1', queueVersion: 99, draft: { text: 'old' } })).stale, 'queue');
  assert.equal((await service.call('review.draft.save', { runId: 'gone', cardId: 'f1', draft: { text: 'x' } })).stale, 'run');
  assert.equal(await revision(), before, 'nothing was committed');

  const update = service.store.update.bind(service.store), hints = [];
  service.store.update = (fn, changed, fields) => { hints.push(changed); return update(fn, changed, fields); };
  t.after(() => { service.store.update = update; });
  assert.equal((await service.call('review.draft.save', { runId: run.id, cardId: 'f1', draft: { text: 'kept' } })).ok, true);
  assert.equal(await revision(), before + 1);
  assert.deepEqual([...hints.at(-1).runs], [run.id], 'the hint names this run');
  assert.equal(Object.keys(hints.at(-1)).join(), 'runs', 'and nothing else');
});
