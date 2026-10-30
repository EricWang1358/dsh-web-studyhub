import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';

/* #550: 改题型. card.update never changes what kind a question is and now says so; card.convert turns one question into another kind without
   deleting it: its attempts, prerequisite links and follow-ups stay, its schedule restarts, and the new kind's structure must be complete. */

const text = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
const base = (id, extra = {}) => ({ id, topic: 'Bridge', objective: `Explain Bridge ${id}`, prompt: `Why does Bridge separate the two hierarchies (${id})?`,
  answer: 'So the abstraction and the implementation can vary independently.', hint: 'Think of two reasons to change.', explanation: 'Each side changes on its own.',
  misconception: 'A subclass for every pair.', citations: [{ sourceId: 's1', quote: text }], ...extra });
const options = [
  { id: 'a', text: 'Both sides vary independently', correct: true, explanation: 'This is the point of Bridge.' },
  { id: 'b', text: 'It hides the database schema', correct: false, explanation: 'That is not what Bridge is for.' },
  { id: 'c', text: 'It removes all interfaces', correct: false, explanation: 'Bridge relies on an interface.' },
];

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-convert-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.call('source.add', { id: 's1', title: 'Notes', text });
  await service.store.update((s) => {
    s.decks.push({ id: 'd', title: 'Patterns', cards: [
      { ...base('f1'), kind: 'flashcard', review: { repetitions: 3, interval_days: 12, ease_factor: 2.6, due_at: '2026-12-01T00:00:00.000Z' },
        requires: [{ deckId: 'd', cardId: 'q1' }], followups: [] },
      { ...base('q1'), kind: 'quiz', options },
    ] });
    s.attempts.push({ id: 'att1', quiz_id: 'f1', deckId: 'd', grade: 4, timestamp: Date.now() });
  });
  return service;
}
const cardOf = async (service, id) => (await service.store.read()).decks.find((deck) => deck.id === 'd').cards.find((card) => card.id === id);

test('card.update with only a kind says to use card.convert instead of "Nothing to update", and never drops a kind silently', async t => {
  const service = await library(t);
  await assert.rejects(service.call('card.update', { cardId: 'f1', patch: { kind: 'multi' }, reason: '题型不合适' }), /card\.convert/);
  await assert.rejects(service.call('card.update', { cardId: 'f1', patch: { kind: 'multi', prompt: 'Changed prompt for Bridge?' }, reason: 'x' }), /card\.convert/,
    'a kind beside other fields is refused too, not ignored');
  assert.equal((await cardOf(service, 'f1')).kind, 'flashcard');
  await assert.rejects(service.call('card.update', { cardId: 'f1', patch: { kind: 'flashcard' }, reason: 'x' }), /already flashcard/);
});

test('flashcard → multi keeps the question, its attempts, links and follow-ups, and restarts its schedule', async t => {
  const service = await library(t);
  const multi = [{ ...options[0] }, { ...options[1], text: 'Each side can be extended alone', correct: true, explanation: 'Also true.' }, { ...options[2] }];
  const result = await service.call('card.convert', { cardId: 'f1', kind: 'multi', patch: { options: multi }, reason: '这道题应该是多选' });
  assert.equal(result.from, 'flashcard');
  assert.equal(result.kind, 'multi');
  assert.equal(result.scheduleReset, true);
  const card = await cardOf(service, 'f1');
  assert.equal(card.kind, 'multi');
  assert.equal(card.options.filter((option) => option.correct).length, 2);
  assert.deepEqual(card.requires, [{ deckId: 'd', cardId: 'q1' }], 'the prerequisite link stays');
  assert.equal(card.review.repetitions, 0, 'the schedule starts again');
  assert.equal(card.revisions.at(-1).content.kind, 'flashcard', 'card.revert can bring the flashcard back');
  assert.equal((await service.store.read()).attempts.filter((attempt) => attempt.quiz_id === 'f1').length, 1, 'the answer history stays');
  await service.call('card.revert', { cardId: 'f1' });
  assert.equal((await cardOf(service, 'f1')).kind, 'flashcard');
});

test('quiz → multi re-marks the options; quiz → flashcard drops them; the new structure must be complete', async t => {
  const service = await library(t);
  await assert.rejects(service.call('card.convert', { cardId: 'q1', kind: 'multi', reason: 'x', patch: { options: options.map((option) => ({ id: option.id, correct: true })) } }),
    /invalid correct option count/, 'every option correct is not a multiple choice question');
  await service.call('card.convert', { cardId: 'q1', kind: 'multi', patch: { options: [{ id: 'b', correct: true, text: 'Each side can be extended alone', explanation: 'True as well.' }] }, reason: 'x' });
  assert.equal((await cardOf(service, 'q1')).options.filter((option) => option.correct).length, 2, 'options patched by id');
  await service.call('card.convert', { cardId: 'q1', kind: 'flashcard', reason: 'x' });
  const flash = await cardOf(service, 'q1');
  assert.equal(flash.kind, 'flashcard');
  assert.equal(flash.options, undefined, 'no stale options on a flashcard');
  await assert.rejects(service.call('card.convert', { cardId: 'f1', kind: 'quiz', reason: 'x' }), /needs patch\.options/);
  await assert.rejects(service.call('card.convert', { cardId: 'f1', kind: 'open', reason: 'x' }), /needs patch\.rubric/);
  await assert.rejects(service.call('card.convert', { cardId: 'f1', kind: 'essay', reason: 'x' }), /kind must be one of/);
  await assert.rejects(service.call('card.convert', { cardId: 'f1', kind: 'flashcard', reason: 'x' }), /already flashcard/);
});

test('→ cloze needs its blanks, and other kinds still may not gain {{…}} markers', async t => {
  const service = await library(t);
  await assert.rejects(service.call('card.convert', { cardId: 'f1', kind: 'cloze', reason: 'x' }), /needs patch\.cloze/);
  await assert.rejects(service.call('card.convert', { cardId: 'f1', kind: 'quiz', patch: { prompt: 'Bridge separates {{a}} from implementation?', options }, reason: 'x' }), /填空标记/);
  await service.call('card.convert', { cardId: 'f1', kind: 'cloze', reason: 'x',
    patch: { cloze: { text: 'Bridge separates an {{a1}} from its implementation.', answers: [{ id: 'a1', value: 'abstraction' }] } } });
  const cloze = await cardOf(service, 'f1');
  assert.equal(cloze.kind, 'cloze');
  assert.equal(cloze.cloze.answers[0].value, 'abstraction');
});

test('a question in an open exam is not converted, and the contract names card.convert', async t => {
  const service = await library(t);
  await service.store.update((s) => s.runs.push({ id: 'exam', mode: 'exam', deckId: 'd', index: 0, entries: [{ deckId: 'd', card: { id: 'q1', kind: 'quiz' } }] }));
  await assert.rejects(service.call('card.convert', { cardId: 'q1', kind: 'flashcard', reason: 'x' }), /active exam/);
  assert.match(studyToolDescription, /card\.convert/);
  assert.match(libraryContracts.cards, /card\.convert \{cardId,deckId\?,kind/);
});
