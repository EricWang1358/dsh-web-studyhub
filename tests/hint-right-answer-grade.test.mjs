import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #883 slice S1: a right answer given after the hint is graded 3 (勉强答对, FSRS Hard) on the server, from the hint recorded for this answer
   (review.draft.save, the path the panel really takes), not from the whole "assisted" flag. Wrong stays 1; right alone stays 4. */

const m = await loadUi(`
  export { NextDue } from './ui/NextDue.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const quiz = (id) => ({ id, kind: 'quiz', topic: `T-${id}`, objective: 'Recall', prompt: `${id}?`, hint: 'H', explanation: 'E', misconception: '', citations: [],
  options: [{ id: 'a', text: 'yes', correct: true, explanation: 'x' }, { id: 'b', text: 'no', correct: false, explanation: 'y' }] });
const cloze = (id) => ({ id, kind: 'cloze', topic: `T-${id}`, objective: 'Recall', prompt: 'The {{b1}} manages history.', answer: 'The Caretaker manages history.', hint: 'H',
  explanation: 'E', misconception: '', citations: [], cloze: { text: 'The {{b1}} manages history.', answers: [{ id: 'b1', value: 'Caretaker' }] } });

const KINDS = {
  choice: { make: quiz, right: { selected: ['a'] }, wrong: { selected: ['b'] } },
  cloze: { make: cloze, right: { answers: { b1: 'Caretaker' } }, wrong: { answers: { b1: 'Originator' } } },
};

async function library(t, make) {
  const root = await mkdtemp(join(tmpdir(), 'hint-grade-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const ids = ['q1', 'q2', 'q3', 'q4'];
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'D', course: 'C', cards: ids.map(make) }); });
  return service;
}

/** Answer one fresh question in its own run; `hint` records the hint the way the panel does before the answer. */
async function answerOnce(service, cardId, response, { hint = false, assistance } = {}) {
  const run = await service.call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'd', cardId }] });
  const extra = hint ? { hintUsed: true } : assistance;
  if (extra) await service.call('review.draft.save', { runId: run.id, cardId, index: 0, assistance: extra });
  const done = await service.call('review.answer', { runId: run.id, cardId, ...response });
  const attempt = (await service.store.read()).attempts.filter((att) => att.quiz_id === cardId && !att.retry).at(-1);
  return { feedback: done.feedback, attempt };
}

for (const [name, kind] of Object.entries(KINDS)) {
  test(`${name}: right with the hint is graded 3, and comes back sooner than the same answer without it`, async (t) => {
    const service = await library(t, kind.make);
    const alone = await answerOnce(service, 'q1', kind.right);
    const helped = await answerOnce(service, 'q2', kind.right, { hint: true });
    assert.equal(alone.attempt.grade, 4);
    assert.equal(helped.attempt.grade, 3);
    assert.equal(helped.feedback.grade, 3);
    assert.equal(helped.feedback.correct, true);
    assert.equal(helped.attempt.assistance.hintUsed, true);
    assert.ok(helped.attempt.after.interval_days < alone.attempt.after.interval_days, `${helped.attempt.after.interval_days} < ${alone.attempt.after.interval_days}`);
    assert.ok(Date.parse(helped.feedback.nextDue) < Date.parse(alone.feedback.nextDue));
    assert.equal(helped.feedback.hintGraded, true, 'the feedback says the grade came from the hint');
    assert.equal('hintGraded' in alone.feedback, false);
  });

  test(`${name}: right alone is 4, wrong is 1 with or without the hint`, async (t) => {
    const service = await library(t, kind.make);
    assert.equal((await answerOnce(service, 'q1', kind.right)).attempt.grade, 4);
    const wrongAlone = await answerOnce(service, 'q2', kind.wrong);
    const wrongHelped = await answerOnce(service, 'q3', kind.wrong, { hint: true });
    assert.equal(wrongAlone.attempt.grade, 1);
    assert.equal(wrongHelped.attempt.grade, 1);
    assert.equal(wrongHelped.feedback.correct, false);
    assert.equal('hintGraded' in wrongHelped.feedback, false, 'a wrong answer is not softened and not described as hint-graded');
  });

  test(`${name}: other help (the blueprint, the tutor) without the hint stays 4`, async (t) => {
    const service = await library(t, kind.make);
    const blueprint = await answerOnce(service, 'q1', kind.right, { assistance: { blueprintExposed: true } });
    const tutor = await answerOnce(service, 'q2', kind.right, { assistance: { askedTutorBeforeAnswer: true } });
    assert.equal(blueprint.attempt.grade, 4);
    assert.equal(blueprint.attempt.assistance.used, true);
    assert.equal(tutor.attempt.grade, 4);
    assert.equal('hintGraded' in blueprint.feedback, false);
  });
}

test('flashcard mode self-grading is unchanged by the hint', async (t) => {
  const service = await library(t, quiz);
  const run = await service.call('review.start', { deckId: 'd', mode: 'flashcard', fresh: true });
  const cardId = run.card.id;
  await service.call('review.draft.save', { runId: run.id, cardId, index: 0, assistance: { hintUsed: true } });
  await service.call('review.reveal', { runId: run.id, cardId });
  const done = await service.call('review.answer', { runId: run.id, cardId, grade: 4 });
  assert.equal(done.feedback.grade, 4);
  assert.equal('hintGraded' in done.feedback, false);
});

test('the line under the answer says the answer was right with the hint, in Chinese and English', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const feedback = { correct: true, grade: 3, hintGraded: true, level: 'learning', nextDue: '2026-11-20T00:00:00Z' };
  const line = (fb) => renderToStaticMarkup(React.createElement(m.NextDue, { feedback: fb, now })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(line(feedback), /^答对了 · 下次大约 10 天后再见 · 用了提示，按「勉强答对」安排，这道题会更早回来/);
  assert.doesNotMatch(line({ ...feedback, hintGraded: undefined }), /提示/);
  m.setUiLanguage('en');
  try {
    const english = line(feedback);
    assert.match(english, /used the hint.*Correct with effort.*sooner/i);
    assert.doesNotMatch(english, /[㐀-鿿]/);
  } finally { m.setUiLanguage('zh'); }
});
