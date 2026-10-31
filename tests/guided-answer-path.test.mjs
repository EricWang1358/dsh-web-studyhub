import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

/* What an answer does to the check item it backs, through the path the learner's answer really takes: review.start, review.answer, then what the panel reads.
   #607 puts the progress on study.session.get; until it is on the same line, resume reads the same function. */

const quiz = (id) => ({ id, kind: 'quiz', topic: `T-${id}`, objective: 'Recall', prompt: `${id}?`, hint: 'H', explanation: 'E', misconception: '', citations: [],
  options: [{ id: 'a', text: 'yes', correct: true, explanation: 'x' }, { id: 'b', text: 'no', correct: false, explanation: 'y' }] });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'guided-answer-path-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: 'C', cards: [quiz('q1')] }); });
  const session = await service.call('study.session.start', { courseId: 'C', scope: [{ kind: 'deck', id: 'd' }],
    goal: { title: 'Goal', checkItems: [{ id: 'k1', title: 'One', targetCardIds: ['q1'] }] } });
  const run = await service.call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'd', cardId: 'q1' }] });
  const progress = async () => (await service.call('study.session.get', { sessionId: session.id })).progress
    ?? (await service.call('study.session.resume', { sessionId: session.id })).progress;
  return { service, run, progress };
}

test('an answer given alone is an independent pass', async (t) => {
  const { service, run, progress } = await library(t);
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['a'] });
  const read = await progress();
  assert.equal(read.items[0].status, 'passed');
  assert.equal(read.independentPassedCount, 1);
});

test('an answer after opening the hint is passed with help', async (t) => {
  const { service, run, progress } = await library(t);
  await service.call('review.draft.save', { runId: run.id, cardId: 'q1', index: 0, assistance: { hintUsed: true } });
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['a'] });
  const read = await progress();
  assert.equal(read.items[0].status, 'assisted');
  assert.equal(read.independentPassedCount, 0);
});

test('the tail retry after a wrong answer is not an independent pass: the learner has seen the answer', async (t) => {
  const { service, run, progress } = await library(t);
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['b'] });
  const moved = await service.call('review.move', { runId: run.id, direction: 1 });
  assert.equal(moved.retry, true);
  await service.call('review.answer', { runId: run.id, cardId: 'q1', selected: ['a'], index: moved.index });
  const attempts = (await service.store.read()).attempts;
  assert.deepEqual(attempts.map((att) => [att.retry, att.assistance.used]), [[false, false], [true, false]]);
  const read = await progress();
  assert.equal(read.items[0].status, 'assisted');
  assert.equal(read.independentPassedCount, 0);
});
