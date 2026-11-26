import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';
import { reviewElement } from './helpers/review-render.mjs';

/* D-6: the line under a practice answer says what the SAME level function of the mastery views says. One correct answer is 学习中 (the interval is not yet 6 days), never 已掌握. */

const m = await loadUi(`
  export { NextDue, nextDueIcon, nextDueWord } from './ui/NextDue.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { cardLevel } from './lib/mastery.js';
`);
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const han = /[㐀-鿿]/;
const source = { id: 's', title: 'Bridge', text: 'Bridge separates an abstraction from its implementation so the two can vary independently.' };
const card = { id: 'q', kind: 'flashcard', topic: 'Bridge', objective: 'Identify independent variation', prompt: 'Why use Bridge for reports and renderers?', answer: 'Separate independent dimensions.',
  hint: 'Think about two independent reasons to change.', explanation: 'Report types and rendering backends vary independently.', misconception: 'A subclass for every combination causes a cross product.',
  citations: [{ sourceId: 's', quote: source.text }] };

async function answered(grade) {
  const root = await mkdtemp(join(tmpdir(), 'study-feedback-'));
  const service = new StudyService(root);
  try {
    await service.call('source.add', source);
    await service.call('draft.save', { deck: { id: 'd', title: 'Patterns', cards: [structuredClone(card)] } });
    await service.call('draft.publish', { id: 'd' });
    let run = await service.call('review.start', { deckId: 'd', mode: 'flashcard' });
    await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade });
    return run.feedback;
  } finally { service.dispose?.(); await rm(root, { recursive: true, force: true }); }
}

test('the first correct answer is level "learning" (the mastery views call it 学习中), a self-rated 轻松 is "mastered", a miss is "weak"', async () => {
  assert.equal((await answered(4)).level, 'learning');
  assert.equal((await answered(5)).level, 'mastered');
  assert.equal((await answered(1)).level, 'weak');
});

test('the feedback line follows the level: 答对了 after one correct answer, 已掌握 only when the level really is mastered, 将继续巩固 for a miss', () => {
  const due = '2026-10-07T00:00:00.000Z';
  const line = feedback => text(renderToStaticMarkup(React.createElement(m.NextDue, { feedback })));
  assert.match(line({ correct: true, level: 'learning', nextDue: due }), /^答对了 · 下次/);
  assert.doesNotMatch(line({ correct: true, level: 'learning', nextDue: due }), /已掌握/);
  assert.match(line({ correct: true, level: 'familiar', nextDue: due }), /^答对了 · 下次/);
  assert.match(line({ correct: true, level: 'mastered', nextDue: due }), /^已掌握 · 下次/);
  assert.match(line({ correct: false, level: 'weak', nextDue: due }), /^将继续巩固 · 下次/);
  assert.match(line({ correct: true, nextDue: due }), /^答对了/, 'a feedback from an older host has no level: it says only what it knows');
  assert.match(line({ correct: false, retryQueued: true, level: 'weak', nextDue: due }), /这道题放到了本轮最后，会再出现一次/);
  m.setUiLanguage('en');
  try {
    const english = line({ correct: true, level: 'learning', nextDue: due });
    assert.match(english, /^Correct · see it again/);
    assert.doesNotMatch(english, han);
    assert.match(line({ correct: true, level: 'mastered', nextDue: due }), /^Mastered · see it again/);
  } finally { m.setUiLanguage('zh'); }
});

test('the word comes from the mastery level function, so the practice line and the library cannot disagree', () => {
  // The library labels a card after one correct answer by lib/mastery.js cardLevel: that level is what the feedback carries and the line reads.
  const after = { review: { repetitions: 1, interval_days: 1 } };
  assert.equal(m.cardLevel(after, 4), 'learning');
  assert.equal(m.nextDueWord({ correct: true, level: m.cardLevel(after, 4) }), '答对了');
  assert.equal(m.nextDueWord({ correct: true, level: m.cardLevel({ review: { repetitions: 3, interval_days: 30 } }, 4) }), '已掌握');
  // The tick before it is the registry icon, not part of the word: a mastered answer has one, a miss has the refresh arrow, a plain right answer none.
  assert.equal(m.nextDueIcon({ correct: true, level: 'mastered' }), 'check');
  assert.equal(m.nextDueIcon({ correct: false, level: 'weak' }), 'refresh');
  assert.equal(m.nextDueIcon({ correct: true, level: 'learning' }), null);
});

test('no practice screen calls a merely correct answer 已掌握: the result headline counts 答对, the feedback line is the level\'s', () => {
  const due = '2026-10-07T00:00:00.000Z';
  const quizCard = {
    id: 'q1',
    kind: 'quiz',
    topic: 'Bridge',
    prompt: 'Why use Bridge for reports and renderers?',
    options: [
      { id: 'a', text: 'Separate independent dimensions' },
      { id: 'b', text: 'Merge every subclass' },
    ],
  };
  const solution = {
    options: [
      { id: 'a', correct: true, explanation: 'Abstractions and implementations vary independently.' },
      { id: 'b', correct: false, explanation: 'Subclassing every pair causes a cross product.' },
    ],
    explanation: 'Bridge decouples two independent axes of change.',
    citations: [],
  };
  const renderReview = (run) => text(renderToStaticMarkup(reviewElement(m.Review, m.StudyServicesContext, {
    run,
    data: { root: '/r', decks: [], sources: [] },
    shellTitle: 'Patterns',
  })));
  const activeRun = (feedback) => ({
    id: 'run-active',
    deckId: 'd',
    mode: 'quiz',
    index: 0,
    total: 3,
    questions: 3,
    answered: 1,
    correct: feedback.correct ? 1 : 0,
    complete: false,
    revealed: true,
    card: quizCard,
    solution,
    feedback,
  });

  // Active question screen (Review -> QuestionRun -> NextDue): a merely correct answer says 答对了, never 已掌握.
  const learningText = renderReview(activeRun({ correct: true, level: 'learning', selected: ['a'], nextDue: due }));
  assert.match(learningText, /答对了 · 下次/);
  assert.doesNotMatch(learningText, /已掌握/, 'merely correct answer on QuestionRun never claims 已掌握');

  // A mastered answer renders 已掌握 through NextDue on the same QuestionRun screen.
  const masteredText = renderReview(activeRun({ correct: true, level: 'mastered', selected: ['a'], nextDue: due }));
  assert.match(masteredText, /已掌握 · 下次/);

  // A missed answer renders 将继续巩固 and never 已掌握.
  const weakText = renderReview(activeRun({ correct: false, level: 'weak', selected: ['b'], nextDue: due }));
  assert.match(weakText, /将继续巩固 · 下次/);
  assert.doesNotMatch(weakText, /已掌握/);

  // Completed round summary screen: headline counts 答对, never 道题已掌握.
  const partialSummary = renderReview({
    id: 'run-done-partial', deckId: 'd', mode: 'quiz', complete: true,
    questions: 5, total: 5, answered: 5, correct: 4, selfAnswered: 0,
  });
  assert.match(partialSummary, /道题答对 \/ 5 道/);
  assert.doesNotMatch(partialSummary, /道题已掌握|已掌握/);

  const perfectSummary = renderReview({
    id: 'run-done-all', deckId: 'd', mode: 'quiz', complete: true,
    questions: 5, total: 5, answered: 5, correct: 5, selfAnswered: 0,
  });
  assert.match(perfectSummary, /道题答对 \/ 5 道/);
  assert.match(perfectSummary, /本轮全部答对/);
  assert.doesNotMatch(perfectSummary, /道题已掌握|已掌握/);

  m.setUiLanguage('en');
  try {
    const enLearning = renderReview(activeRun({ correct: true, level: 'learning', selected: ['a'], nextDue: due }));
    assert.match(enLearning, /Correct · see it again/);
    assert.doesNotMatch(enLearning, /Mastered · see it again/);
    assert.doesNotMatch(enLearning, han);
    const enMastered = renderReview(activeRun({ correct: true, level: 'mastered', selected: ['a'], nextDue: due }));
    assert.match(enMastered, /Mastered · see it again/);
    assert.doesNotMatch(enMastered, han);
  } finally { m.setUiLanguage('zh'); }
});
