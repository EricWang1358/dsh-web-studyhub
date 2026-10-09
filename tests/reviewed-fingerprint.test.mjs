import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { generateBatched } from '../lib/batch.js';
import { reviewedCardFingerprint, legacyReviewedCardFingerprint, reviewedCardStatus, cardMatchesReview } from '../lib/review-integrity.js';
import { sectionsOf } from '../lib/sections.js';
import { sectionKey } from '../lib/coverage.js';
import { repeatingLecture, repeatingModel } from './helpers/repeating-lecture.mjs';

/* The review marks a card with the fingerprint of the content it saw. The batch pipeline then stamps WHERE a citation's quote stands (citation.at = { start, end }, lib/card-places.js)
   on the kept card: that is derived position metadata, not content the reviewer judged, so it must not make a card read as "edited after review". A real edit still must. */

const lecture = repeatingLecture(12);
const leaves = () => sectionsOf(lecture.sources).filter(section => section.leaf);
const assignments = list => list.map(section => ({ key: sectionKey('lec', section.id), sectionId: sectionKey('lec', section.id), sourceId: 'lec', start: section.start, end: section.end, quota: 1, title: section.title }));

async function generated() {
  const late = leaves().slice(6, 9);
  return generateBatched(repeatingModel().complete, { sources: lecture.sources, kind: 'quiz', count: late.length, existing: [], assignments: assignments(late),
    performance: { concurrency: 3, batchSize: 5, fillRounds: 0 } }, () => {}, async () => {});
}
const draftOf = deck => ({ cards: deck.cards, editorial: { reviewedCards: deck.editorial.reviewedCards } });
const mark = deck => deck.editorial.reviewedCards;

test('a generated batch with a coverage plan: the position stamped after the review does not make a reviewed card read as edited', async () => {
  const deck = await generated();
  assert.ok(deck.cards.length > 0);
  for (const card of deck.cards) {
    assert.ok(card.citations.some(ref => ref.at), 'the pipeline stamped a position on the card');
    assert.equal(mark(deck)[card.id], reviewedCardFingerprint(card), 'the mark the review wrote still matches the stamped card');
    assert.ok(cardMatchesReview(mark(deck)[card.id], card));
  }
  assert.deepEqual(reviewedCardStatus(draftOf(deck)), { unchanged: deck.cards.length, changed: 0, total: deck.cards.length });
});

const stamped = () => ({ id: 'c', kind: 'quiz', topic: 'T', objective: 'O', prompt: 'P', answer: 'A', options: ['A', 'B'], explanation: 'E',
  citations: [{ sourceId: 's', quote: 'the quote', at: { start: 4, end: 13 } }] });
const withCitation = (card, patch) => ({ ...card, citations: [{ ...card.citations[0], ...patch }] });

test('the fingerprint ignores the stamped position (added, moved or dropped) and nothing else about a citation', () => {
  const card = stamped(), bare = withCitation(card, { at: undefined });
  delete bare.citations[0].at;
  assert.equal(reviewedCardFingerprint(card), reviewedCardFingerprint(bare), 'with or without a position');
  assert.equal(reviewedCardFingerprint(card), reviewedCardFingerprint(withCitation(card, { at: { start: 100, end: 120 } })), 'a moved position');
});

test('a real edit after the review still reads as edited, with or without a position on the citation', () => {
  const card = stamped(), marked = reviewedCardFingerprint(card);
  const edits = {
    prompt: { ...card, prompt: 'P changed' },
    answer: { ...card, answer: 'B' },
    options: { ...card, options: ['A', 'C'] },
    explanation: { ...card, explanation: 'E changed' },
    'citation quote': withCitation(card, { quote: 'another quote' }),
    'citation sourceId': withCitation(card, { sourceId: 'other' }),
    'a citation added': { ...card, citations: [...card.citations, { sourceId: 's', quote: 'more' }] },
    'a citation removed': { ...card, citations: [] },
    'a selection on the citation': withCitation(card, { selection: { start: 1, end: 5 } }),
  };
  for (const [what, edited] of Object.entries(edits)) {
    assert.notEqual(reviewedCardFingerprint(edited), marked, `${what} changes the fingerprint`);
    assert.equal(cardMatchesReview(marked, edited), false, `${what}: not reviewed as is`);
    const draft = { cards: [edited], editorial: { reviewedCards: { c: marked } } };
    assert.deepEqual(reviewedCardStatus(draft), { unchanged: 0, changed: 1, total: 1 }, `${what}: counted as edited`);
  }
});

/* What the fingerprint was before this rule, written out independently: marks already stored in libraries were made with it. */
function oldFingerprint(card) {
  const fields = ['kind', 'topic', 'objective', 'prompt', 'answer', 'hint', 'explanation', 'misconception', 'citations', 'options', 'rubric', 'cloze', 'followUp', 'debrief'];
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const serialized = JSON.stringify(canonical(Object.fromEntries(fields.filter(key => card[key] !== undefined).map(key => [key, card[key]]))));
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < serialized.length; i++) { hash ^= BigInt(serialized.charCodeAt(i)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `${serialized.length}:${hash.toString(16).padStart(16, '0')}`;
}

test('a mark stored before this rule still means what it meant: made before the stamp it matches the stamped card; made from the stamped card it matches that card and no edit of it', () => {
  const card = stamped(), bare = withCitation(card, {});
  delete bare.citations[0].at;
  assert.equal(oldFingerprint(bare), reviewedCardFingerprint(card), 'a mark the review wrote before the position was stamped is the fingerprint of the stamped card');
  const made = oldFingerprint(card);                         // a mark written after the stamp (repair, publication check)
  assert.notEqual(made, reviewedCardFingerprint(card));
  assert.equal(legacyReviewedCardFingerprint(card), made, 'the legacy reading is the old fingerprint');
  assert.equal(cardMatchesReview(made, card), true, 'the card it was made for');
  assert.equal(cardMatchesReview(made, { ...card, prompt: 'edited' }), false);
  assert.equal(cardMatchesReview(made, withCitation(card, { quote: 'edited quote' })), false);
  assert.equal(cardMatchesReview(made, withCitation(card, { sourceId: 'other' })), false);
  assert.equal(cardMatchesReview(made, withCitation(card, { at: { start: 100, end: 120 } })), false, 'a mark made from the stamped card does not follow a moved position: it reads as edited (conservative) until the card is reviewed again');
});

test('no mark, or a mark of another card, is never "reviewed"', () => {
  const card = stamped();
  assert.equal(cardMatchesReview(undefined, card), false);
  assert.equal(cardMatchesReview('', card), false);
  assert.equal(cardMatchesReview(reviewedCardFingerprint(card), null), false);
  assert.equal(cardMatchesReview(reviewedCardFingerprint({ ...card, prompt: 'other' }), card), false);
});

test('quick publish counts a stamped card as reviewed, and an edited one as unchecked (the published deck says 「未自动审阅」 only for the edit)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-reviewed-fingerprint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async () => { throw new Error('no model call at quick publish'); } });
  await service.call('source.add', { id: 's', title: 'Notes', text: 'the quote stands here in the notes.' });
  const one = id => ({ id, kind: 'flashcard', topic: 'T', objective: `O ${id}`, prompt: `Q ${id}?`, answer: 'A', hint: 'H', explanation: 'E', misconception: 'M', citations: [{ sourceId: 's', quote: 'the quote' }] });
  const reviewedFirst = [one('a'), one('b')];
  const marks = Object.fromEntries(reviewedFirst.map(card => [card.id, reviewedCardFingerprint(card)]));   // the review marks them as they are
  const kept = reviewedFirst.map(card => ({ ...card, citations: card.citations.map(ref => ({ ...ref, at: { start: 0, end: 9 } })) }));   // then the pipeline stamps the position
  kept[1] = { ...kept[1], answer: 'edited later' };
  const saved = await service.call('draft.save', { deck: { id: 'stamped', title: 'Stamped', cards: kept, editorial: { reviewedCards: marks } } });
  await service.call('draft.publish.quick', { id: saved.id, draftVersion: saved.draftVersion });
  const deck = await service.call('deck.get', { id: 'stamped' });
  assert.equal(deck.editorial.uncheckedAtPublish, 1, 'only the card edited after the review');
  assert.deepEqual(reviewedCardStatus(deck), { unchanged: 1, changed: 1, total: 2 });
});
