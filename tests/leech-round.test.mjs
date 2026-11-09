import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

/* 顽固题 at the end of a round (#884 S2): the finished round says which of its questions are leeches that the wrong book still holds, from the attempt log. */

const card = (id) => ({ id, kind: 'quiz', topic: 'T', prompt: `Question ${id}?`, answer: 'A', explanation: 'x',
  options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] });
const earlier = (quiz_id, count) => Array.from({ length: count }, (_, n) => ({ deckId: 'd', quiz_id, assessment: 'graded', grade: 1, timestamp: `2026-09-0${n + 1}T10:00:00.000Z` }));

async function library(t, cards, attempts = [], settings) {
  const root = await mkdtemp(join(tmpdir(), 'study-leech-round-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.store.update(s => {
    s.decks.push({ id: 'd', title: 'Deck', course: 'C', cards: cards.map(card) });
    s.attempts.push(...attempts);
    if (settings) s.settings.practice = settings;
  });
  return service;
}

async function finishedRound(t, settings) {
  const service = await library(t, ['stuck', 'fine', 'almost'], [...earlier('stuck', 3), ...earlier('almost', 2)], settings);
  let run = await service.call('review.start', { mode: 'path', fresh: false, scope: [{ deckId: 'd' }] });
  for (let step = 0; !run.complete && step < 12; step++) {
    const wrong = run.card.id !== 'fine';
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, selected: [wrong ? 'b' : 'a'], queueVersion: run.queueVersion });
    if (!run.complete) run = await service.call('review.move', { runId: run.id, direction: 1 });
  }
  return run;
}

test('a finished round lists the questions of the round that are leeches and still in the wrong book; nothing is asked of a model', async t => {
  const run = await finishedRound(t);
  assert.equal(run.complete, true);
  assert.deepEqual(run.leechCards, [{ deckId: 'd', cardId: 'stuck' }], 'stuck: failed 3 times before and now a 4th; almost: 3 in all; fine: right');
});

test('the learner\'s own thresholds decide', async t => {
  const run = await finishedRound(t, { leechFailures: 3 });
  assert.deepEqual(run.leechCards.map(ref => ref.cardId).sort(), ['almost', 'stuck']);
});

test('a round still going has no list yet', async t => {
  const service = await library(t, ['stuck', 'fine']);
  const run = await service.call('review.start', { mode: 'path', fresh: false, scope: [{ deckId: 'd' }] });
  assert.equal(run.complete, false);
  assert.equal('leechCards' in run, false);
});

/* The rescue actions of the wrong book are the calls that already exist (ui/wrongbook-model.js rescueCall): proven here against the service. */
test('the rescue calls: a thumbs-down without the assist flag records the problem and, with no model in the session, starts nothing; again within the window it records nothing; suspending takes the question out of the wrong book', async t => {
  const service = await library(t, ['stuck', 'fine'], earlier('stuck', 4));
  assert.equal((await service.call('wrongbook')).items[0].leech, true);
  const ref = { deckId: 'd', cardId: 'stuck' };
  const first = await service.call('coach.feedback', { ...ref, vote: 'down', tags: ['general-quality'] });
  assert.deepEqual([first.tags, first.scheduled], [['general-quality'], []], 'recorded; no model in this session, so no repair is started and the note must not say one was');
  const again = await service.call('coach.feedback', { ...ref, vote: 'down', tags: ['general-quality'] });
  assert.deepEqual(again.tags, [], 'the same tag again adds nothing');
  const hard = await service.call('coach.feedback', { ...ref, vote: 'down', tags: ['too-hard'] });
  assert.deepEqual([hard.tags, hard.scheduled], [['too-hard'], []], 'without consent to preparation nothing is prepared');
  await service.call('card.suspend', { ...ref, suspended: true });
  assert.equal((await service.call('wrongbook')).total, 0);
  await service.call('card.suspend', { ...ref, suspended: false });
  assert.equal((await service.call('wrongbook')).total, 1, 'and resuming brings it back');
});
