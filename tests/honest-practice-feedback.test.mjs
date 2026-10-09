import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';

/* D-6: the line under a practice answer says what the SAME level function of the mastery views says. One correct answer is 学习中 (the interval is not yet 6 days), never 已掌握. */

const m = await loadUi(`
  export { NextDue, nextDueWord } from './ui/NextDue.jsx';
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
  assert.match(line({ correct: true, level: 'learning', nextDue: due }), /^答对了 · 下次复习 /);
  assert.doesNotMatch(line({ correct: true, level: 'learning', nextDue: due }), /已掌握/);
  assert.match(line({ correct: true, level: 'familiar', nextDue: due }), /^答对了 · 下次复习 /);
  assert.match(line({ correct: true, level: 'mastered', nextDue: due }), /^✓ 已掌握 · 下次复习 /);
  assert.match(line({ correct: false, level: 'weak', nextDue: due }), /^↻ 将继续巩固 · 下次复习 /);
  assert.match(line({ correct: true, nextDue: due }), /^答对了/, 'a feedback from an older host has no level: it says only what it knows');
  assert.match(line({ correct: false, retryQueued: true, level: 'weak', nextDue: due }), /已追加到本轮队尾/);
  m.setUiLanguage('en');
  try {
    const english = line({ correct: true, level: 'learning', nextDue: due });
    assert.match(english, /^Correct · next review /);
    assert.doesNotMatch(english, han);
    assert.match(line({ correct: true, level: 'mastered', nextDue: due }), /^✓ Mastered · next review /);
  } finally { m.setUiLanguage('zh'); }
});

test('the word comes from the mastery level function, so the practice line and the library cannot disagree', () => {
  // The library labels a card after one correct answer by lib/mastery.js cardLevel: that level is what the feedback carries and the line reads.
  const after = { review: { repetitions: 1, interval_days: 1 } };
  assert.equal(m.cardLevel(after, 4), 'learning');
  assert.equal(m.nextDueWord({ correct: true, level: m.cardLevel(after, 4) }), '答对了');
  assert.equal(m.nextDueWord({ correct: true, level: m.cardLevel({ review: { repetitions: 3, interval_days: 30 } }, 4) }), '✓ 已掌握');
});

test('no practice screen calls a merely correct answer 已掌握: the result headline counts 答对, the feedback line is the level\'s', async () => {
  const { readFile } = await import('node:fs/promises');
  // The page and the question it shows (ui/review/QuestionRun.jsx) are one practice screen.
  const review = await readFile('ui/Review.jsx', 'utf8') + await readFile('ui/review/QuestionRun.jsx', 'utf8');
  assert.doesNotMatch(review, /道题已掌握/, 'the end-of-run headline counts the correct answers, it does not call them mastered');
  assert.doesNotMatch(review, /✓ 已掌握/, 'the one place that may say 已掌握 is ui/NextDue.jsx, by the level');
  assert.match(review, /<NextDue feedback=\{run\.feedback\}/);
});
