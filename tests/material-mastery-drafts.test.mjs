/* 资料掌握度 and drafts: a generation run's result is a DRAFT until it is published, so a source whose questions are all
   still in drafts must not read 还没出题. The backend counts the questions of drafts that cite a document apart from the
   published ones (never mixed into the mastery number); an editing copy of a published deck is not a second set of questions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftCardIndex, linkedCardIndex, materialMasteryIndex, materialMasteryOf, pagesCardsView } from '../lib/material-mastery.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const cite = (sourceId, start, end) => ({ sourceId, quote: 'q', ...(start === undefined ? {} : { selection: { sourceId, start, end, quote: 'q', revision: 'r' } }) });
const card = (id, cites, extra = {}) => ({ id, kind: 'flashcard', topic: 't', prompt: `Q ${id}`, answer: 'A', citations: cites, ...extra });
const sources = () => [1, 2, 3].map(page => ({ id: `s${page}`, title: `Book · p.${page}`, text: `text of page ${page}`,
  document: { id: 'h'.repeat(64), page, format: 'pdf', materialId: `document-${'h'.repeat(64)}-pdf`, filename: 'book.pdf' } }));
const only = state => Object.values(materialMasteryIndex(state, { now: NOW }));

test('a document whose questions are all in a draft has no published questions and says how many are in drafts', () => {
  const state = { sources: sources(), attempts: [], decks: [], drafts: [{ id: 'dr1', title: 'Run', cards: [card('a', [cite('s1', 0, 3)]), card('b', [cite('s2', 0, 3)]), card('c', [cite('s1', 4, 6)])] }] };
  const [entry] = only(state);
  assert.ok(entry, 'the document is listed even though nothing is published');
  assert.equal(entry.document.total, 0);
  assert.equal(entry.document.state, 'none');
  assert.equal(entry.document.draftCards, 3);
  assert.deepEqual(entry.drafts, { cards: 3, draftIds: ['dr1'] });
  assert.equal(entry.pages.s1.draftCards, 2);
  assert.equal(entry.pages.s2.draftCards, 1);
  assert.equal(entry.pages.s3, undefined, 'a page no draft cites has no entry');
});

test('a card of two pages is one draft question for the document, and a card of two drafts is two', () => {
  const state = { sources: sources(), attempts: [], decks: [], drafts: [
    { id: 'dr1', cards: [card('a', [cite('s1', 0, 3), cite('s2', 0, 3)])] },
    { id: 'dr2', cards: [card('a', [cite('s1', 0, 3)])] }] };
  const [entry] = only(state);
  assert.equal(entry.document.draftCards, 2);
  assert.deepEqual(entry.drafts.draftIds.sort(), ['dr1', 'dr2']);
  assert.equal(entry.pages.s1.draftCards, 2);
});

test('an editing copy of a published deck, and a repair of one, are not counted: the published questions are the same ones', () => {
  const state = { sources: sources(), attempts: [],
    decks: [{ id: 'd1', title: 'D', cards: [card('a', [cite('s1', 0, 3)])] }],
    drafts: [
      { id: 'edit', editingDeckId: 'd1', cards: [card('a', [cite('s1', 0, 3)]), card('n', [cite('s1', 4, 6)])] },
      { id: 'repair', editorial: { repairOfDeckId: 'd1' }, cards: [card('a', [cite('s1', 0, 3)])] }] };
  const [entry] = only(state);
  assert.equal(entry.document.total, 1);
  assert.equal(entry.document.draftCards, undefined);
  assert.equal(entry.drafts, undefined);
  assert.equal(draftCardIndex(state).bySource.size, 0);
});

test('published questions and drafts are counted apart: the mastery number is the published ones only', () => {
  const state = { sources: sources(), attempts: [], decks: [{ id: 'd1', title: 'D', cards: [card('a', [cite('s1', 0, 3)])] }],
    drafts: [{ id: 'dr1', cards: [card('x', [cite('s1', 0, 3)]), card('y', [cite('s3', 0, 3)])] }] };
  const [entry] = only(state);
  assert.equal(entry.document.total, 1, 'only the published card feeds the percentage');
  assert.equal(entry.document.state, 'unlearned');
  assert.equal(entry.document.draftCards, 2);
  assert.equal(entry.pages.s1.total, 1);
  assert.equal(entry.pages.s1.draftCards, 1);
  assert.equal(entry.pages.s3.total, 0);
  assert.equal(entry.pages.s3.draftCards, 1);
});

test('an archived deck does not count as published, so its source reads "drafts only" when a draft cites it', () => {
  const state = { sources: sources(), attempts: [], decks: [{ id: 'old', title: 'Old', archived: true, cards: [card('a', [cite('s1', 0, 3)])] }],
    drafts: [{ id: 'dr1', cards: [card('x', [cite('s1', 0, 3)])] }] };
  const [entry] = only(state);
  assert.equal(entry.document.total, 0);
  assert.equal(entry.document.draftCards, 1);
});

test('chapters get their draft count like their published count', () => {
  const src = sources();
  src.forEach((source, index) => { source.document.origin = 'converted'; source.document.converter = 'mineru'; source.document.chapter = index < 2 ? { index: 0, title: 'One', level: 1 } : { index: 1, title: 'Two', level: 1 }; });
  const state = { sources: src, attempts: [], decks: [], drafts: [{ id: 'dr', cards: [card('a', [cite('s1', 0, 1)]), card('b', [cite('s3', 0, 1)]), card('c', [cite('s2')])] }] };
  const [entry] = only(state);
  assert.equal(entry.chapters[0].draftCards, 2);
  assert.equal(entry.chapters[1].draftCards, 1);
});

test('the link reading is shared: a draft card links like a deck card (selection, quote only)', () => {
  const src = sources();
  src[0].text = 'alpha beta gamma';
  const state = { sources: src, attempts: [], decks: [{ id: 'd', cards: [card('p', [{ sourceId: 's1', quote: 'beta' }])] }],
    drafts: [{ id: 'dr', cards: [card('p', [{ sourceId: 's1', quote: 'beta' }])] }] };
  const published = linkedCardIndex(state, { now: NOW }).bySource.get('s1')[0], draft = draftCardIndex(state).bySource.get('s1')[0];
  assert.deepEqual([draft.start, draft.end], [published.start, published.end]);
  assert.deepEqual([draft.start, draft.end], [6, 10]);
  assert.equal(draft.deckId, 'dr', 'the draft id sits in the deckId slot so a card key has one shape');
});

test('the draft ids are bounded; the count is not', () => {
  const drafts = Array.from({ length: 60 }, (_, index) => ({ id: `dr${index}`, cards: [card('a', [cite('s1', 0, 3)])] }));
  const [entry] = only({ sources: sources(), attempts: [], decks: [], drafts });
  assert.equal(entry.document.draftCards, 60);
  assert.equal(entry.drafts.cards, 60);
  assert.ok(entry.drafts.draftIds.length <= 20);
});

test('the snapshot value is recomputed when a draft changes (the library revision moves with every write)', () => {
  const state = { revision: 7, sources: sources(), attempts: [], decks: [], drafts: [{ id: 'dr', cards: [card('a', [cite('s1', 0, 3)])] }] };
  const first = materialMasteryOf(state, { root: 'r-drafts', now: NOW });
  assert.equal(Object.values(first)[0].document.draftCards, 1);
  assert.equal(materialMasteryOf(state, { root: 'r-drafts', now: NOW }), first, 'same revision, same minute: memoised');
  const published = { ...state, revision: 8, decks: [{ id: 'd', title: 'D', cards: [card('a', [cite('s1', 0, 3)])] }], drafts: [] };
  const second = materialMasteryOf(published, { root: 'r-drafts', now: NOW });
  assert.notEqual(second, first);
  assert.equal(Object.values(second)[0].document.total, 1);
  assert.equal(Object.values(second)[0].document.draftCards, undefined);
});

test('no drafts and no decks: nothing to say (an empty library is cheap)', () => {
  assert.deepEqual(materialMasteryIndex({ sources: sources(), decks: [], drafts: [] }, { now: NOW }), {});
  assert.deepEqual(materialMasteryIndex({ sources: sources(), decks: [] }, { now: NOW }), {});
});

test('materials.pages.cards reports the drafts that cite the document, with where each one points, for the reader', () => {
  const state = { sources: sources(), attempts: [], decks: [{ id: 'd1', title: 'D', cards: [card('a', [cite('s1', 0, 3)])] }],
    drafts: [{ id: 'dr1', title: 'Run', cards: [card('x', [cite('s2', 0, 3)]), card('y', [cite('s1', 4, 6)])] }, { id: 'edit', editingDeckId: 'd1', cards: [card('a', [cite('s1', 0, 3)])] }] };
  const view = pagesCardsView(state, { sourceId: 's1' }, { now: NOW });
  assert.equal(view.status, 'ok');
  assert.equal(view.cards.length, 1, 'the published list is unchanged');
  assert.equal(view.draftCards, 2);
  assert.deepEqual(view.drafts, { cards: 2, draftIds: ['dr1'] });
  assert.deepEqual(view.draftEntries.map(entry => [entry.draftId, entry.cardId]).sort(), [['dr1', 'x'], ['dr1', 'y']]);
  const y = view.draftEntries.find(entry => entry.cardId === 'y');
  assert.deepEqual(y.links.map(link => [link.sourceId, link.start, link.end]), [['s1', 4, 6]]);
  assert.equal(y.links[0].selection.quote, 'q');
  const narrowed = pagesCardsView(state, { sourceId: 's1', sourceIds: ['s2'] }, { now: NOW });
  assert.equal(narrowed.draftCards, 1);
  assert.equal(pagesCardsView({ sources: sources(), decks: [], drafts: [] }, { sourceId: 's1' }, { now: NOW }).draftCards, 0);
});
