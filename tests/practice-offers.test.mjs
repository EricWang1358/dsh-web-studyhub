import test from 'node:test';
import assert from 'node:assert/strict';
import { PRACTICE_OFFER, PRACTICE_OFFER_ORDER, CHAPTER_HINT_KEY, practiceOfferFor, chapterHintFor } from '../ui/guidance/practice-offers.js';

const ALL = [PRACTICE_OFFER.chapterBasics];

test('practiceOfferFor: yields to practice tips, exam mode, and tourRunning', () => {
  assert.equal(practiceOfferFor({ tip: 'practice.help-after-wrong', allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ exam: true, allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ tourRunning: true, allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
});

test('practiceOfferFor: skips muted/disallowed offers and returns null when none match', () => {
  assert.equal(practiceOfferFor({ allowed: [], moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ allowed: new Set(), moments: { [PRACTICE_OFFER.chapterBasics]: true } }), null);
  assert.equal(practiceOfferFor({ allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: false } }), null);
  assert.equal(practiceOfferFor({ allowed: ALL, moments: {} }), null);
});

test('practiceOfferFor: returns the first allowed matching offer in order', () => {
  assert.deepEqual(PRACTICE_OFFER_ORDER, [PRACTICE_OFFER.chapterBasics]);
  assert.equal(
    practiceOfferFor({ allowed: ALL, moments: { [PRACTICE_OFFER.chapterBasics]: true } }),
    PRACTICE_OFFER.chapterBasics,
  );
  assert.equal(
    practiceOfferFor({
      allowed: [PRACTICE_OFFER.chapterBasics, 'practice.future-second'],
      moments: { [PRACTICE_OFFER.chapterBasics]: true, 'practice.future-second': true },
      order: [PRACTICE_OFFER.chapterBasics, 'practice.future-second'],
    }),
    PRACTICE_OFFER.chapterBasics,
  );
  assert.equal(
    practiceOfferFor({
      allowed: ['practice.future-first', PRACTICE_OFFER.chapterBasics],
      moments: { 'practice.future-first': true, [PRACTICE_OFFER.chapterBasics]: true },
      order: ['practice.future-first', PRACTICE_OFFER.chapterBasics],
    }),
    'practice.future-first',
  );
  assert.equal(
    practiceOfferFor({ allowed: new Set(ALL), moments: { [PRACTICE_OFFER.chapterBasics]: true } }),
    PRACTICE_OFFER.chapterBasics,
  );
});

test('chapterHintFor: triggers only on non-empty deeper or refill === true', () => {
  const ok = { allowed: true, seenChapters: new Set(), chapterKey: 'doc-1:ch-1' };
  assert.equal(chapterHintFor({ ...ok, deeper: ['底层前提'], refill: false }), true);
  assert.equal(chapterHintFor({ ...ok, deeper: [], refill: true }), true);
  assert.equal(chapterHintFor({ ...ok, deeper: undefined, refill: true }), true);
  assert.equal(chapterHintFor({ ...ok, deeper: [], refill: false }), false);
  assert.equal(chapterHintFor({ ...ok, deeper: undefined, refill: false }), false);
  assert.equal(chapterHintFor({ ...ok, deeper: null, refill: false }), false);
});

test('chapterHintFor: suppressed by exam, tourRunning, !allowed, or chapter already seen in round', () => {
  const base = { deeper: ['x'], refill: true, allowed: true, seenChapters: new Set(), chapterKey: 'doc-1:ch-2' };
  assert.equal(chapterHintFor(base), true);
  assert.equal(chapterHintFor({ ...base, exam: true }), false);
  assert.equal(chapterHintFor({ ...base, tourRunning: true }), false);
  assert.equal(chapterHintFor({ ...base, allowed: false }), false);
  assert.equal(chapterHintFor({ ...base, seenChapters: new Set(['doc-1:ch-2']) }), false);
  assert.equal(chapterHintFor({ ...base, seenChapters: ['doc-1:ch-2'] }), false);
  assert.equal(chapterHintFor({ ...base, seenChapters: new Set(['doc-1:ch-1']) }), true);
  assert.equal(CHAPTER_HINT_KEY, 'study-chapter-basics-seen');
});
