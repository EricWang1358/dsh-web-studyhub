/* 资料掌握度 (material mastery): how well the questions linked to some pages, a chapter or a document are known. Pure
   functions over the library state; the number is the Dashboard's own (lib/mastery.js), so the two can never disagree. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deckProgress, latestOutcomes } from '../lib/mastery.js';
import { MATERIAL_STATES, summarizeLinked, linkedCardIndex, materialMasteryIndex, documentCards, chapterIndexOf, dueNewWeakLine } from '../lib/material-mastery.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const day = 86400000;
const iso = ms => new Date(ms).toISOString();
/** A card in a given level: new (no review), weak (last grade 1), learning (3 days), familiar (10 days), mastered (30 days). */
const card = (id, level, cites, extra = {}) => ({ id, kind: 'flashcard', topic: 't', prompt: `Q ${id}`, answer: 'A', citations: cites,
  ...(level === 'new' ? {} : { review: { repetitions: 2, interval_days: { weak: 1, learning: 3, familiar: 10, mastered: 30 }[level], due_at: iso(NOW + (extra.dueInDays ?? 5) * day) } }), ...extra });
const cite = (sourceId, start, end) => ({ sourceId, quote: 'q', ...(start === undefined ? {} : { selection: { sourceId, start, end, quote: 'q', revision: 'r' } }) });
const attemptsFor = deckId => id => ({ deckId, quiz_id: id, grade: 1 });

test('the states are the five the learner sees, "no questions" being its own state and never 0%', () => {
  assert.deepEqual(MATERIAL_STATES, ['none', 'unlearned', 'learning', 'familiar', 'mastered']);
  const none = summarizeLinked([]);
  assert.equal(none.state, 'none');
  assert.equal(none.percent, null);
  assert.equal(none.total, 0);
});

test('a page whose questions were never answered is unlearned (0%), not "no questions"', () => {
  const summary = summarizeLinked([{ level: 'new' }, { level: 'new' }]);
  assert.equal(summary.state, 'unlearned');
  assert.equal(summary.percent, 0);
  assert.equal(summary.counts.new, 2);
});

test('the percentage is the dashboard weighting; mastered needs 80% and no weak card, familiar needs 60%', () => {
  assert.equal(summarizeLinked([{ level: 'mastered' }, { level: 'mastered' }]).state, 'mastered');
  assert.equal(summarizeLinked([{ level: 'mastered' }, { level: 'mastered' }]).percent, 100);
  // 4 mastered + 1 weak = (4 + 0.15) / 5 = 83%: high, but a weak card keeps it from being "mastered".
  const withWeak = summarizeLinked([...Array(4).fill({ level: 'mastered' }), { level: 'weak' }]);
  assert.equal(withWeak.percent, 83);
  assert.equal(withWeak.state, 'familiar');
  assert.equal(summarizeLinked([{ level: 'familiar' }]).state, 'familiar');
  assert.equal(summarizeLinked([{ level: 'familiar' }]).percent, 75);
  assert.equal(summarizeLinked([{ level: 'learning' }]).state, 'learning');
  assert.equal(summarizeLinked([{ level: 'weak' }]).state, 'learning');
  assert.equal(summarizeLinked([{ level: 'new' }, { level: 'mastered' }]).percent, 50);
});

test('due, new, weak and inactive are counted; a new card is never "due"', () => {
  const summary = summarizeLinked([{ level: 'weak', due: true }, { level: 'learning', due: true }, { level: 'new' }, { level: 'mastered', inactive: true }]);
  assert.deepEqual([summary.total, summary.due, summary.counts.new, summary.counts.weak, summary.inactive], [4, 2, 1, 1, 1]);
});

test('the same number as the dashboard for the same cards', () => {
  const cards = [card('a', 'mastered', []), card('b', 'familiar', []), card('c', 'learning', []), card('d', 'new', []), card('e', 'weak', [])];
  const deck = { id: 'd1', title: 'D', cards };
  const outcome = latestOutcomes([{ deckId: 'd1', quiz_id: 'e', grade: 1 }]);
  const dashboard = deckProgress(deck, outcome, NOW).mastery;
  const state = { decks: [deck], attempts: [{ deckId: 'd1', quiz_id: 'e', grade: 1 }], sources: [] };
  const linked = cards.map(item => ({ level: linkedCardIndex({ ...state, sources: [] }, { now: NOW }).levels.get(`${'d1'}|${item.id}`) }));
  assert.equal(summarizeLinked(linked).percent, dashboard);
});

const pdfSources = (pages) => pages.map(page => ({ id: `s${page}`, title: `Book · p.${page}`, text: `text of page ${page}`, document: { id: 'h'.repeat(64), page, format: 'pdf', materialId: `document-${'h'.repeat(64)}-pdf`, filename: 'book.pdf' } }));

function library() {
  const decks = [
    { id: 'd1', title: 'Deck one', course: 'Course A', cards: [
      card('c1', 'mastered', [cite('s1', 0, 5)]),
      card('c2', 'new', [cite('s1', 6, 9), cite('s2', 0, 3)]),          // two pages: counts once per scope
      card('c3', 'weak', [cite('s2', 0, 4)], { dueInDays: -1 }),
      card('c4', 'familiar', [cite('s3')], { dueInDays: -1 }),           // due, cited without a selection
      card('c5', 'learning', [cite('s3', 2, 8)], { suspended: true }),   // suspended: not counted anywhere
    ] },
    { id: 'd2', title: 'Parked', course: 'Course B', cards: [card('c6', 'new', [cite('s1', 0, 2)])] },
    { id: 'd3', title: 'Old', course: 'Course A', archived: true, cards: [card('c7', 'mastered', [cite('s1', 0, 2)])] },
  ];
  return { sources: pdfSources([1, 2, 3, 4]), decks, attempts: [{ deckId: 'd1', quiz_id: 'c3', grade: 1 }], courses: [{ id: 'cb', name: 'Course B', active: false }] };
}

test('the linked-card index lists a card once per page it cites, with its level, due and course state; suspended and archived cards are left out', () => {
  const { bySource } = linkedCardIndex(library(), { now: NOW });
  assert.deepEqual(bySource.get('s1').map(link => link.cardId).sort(), ['c1', 'c2', 'c6']);
  assert.deepEqual(bySource.get('s2').map(link => link.cardId).sort(), ['c2', 'c3']);
  assert.deepEqual(bySource.get('s3').map(link => link.cardId), ['c4']);
  assert.equal(bySource.get('s4'), undefined);
  const c3 = bySource.get('s2').find(link => link.cardId === 'c3');
  assert.deepEqual([c3.level, c3.due, c3.inactive, c3.start, c3.end], ['weak', true, false, 0, 4]);
  assert.equal(bySource.get('s3')[0].due, true, 'an overdue scheduled card is due');
  assert.equal(bySource.get('s3')[0].start, null, 'a citation without a selection has no position');
  assert.equal(bySource.get('s1').find(link => link.cardId === 'c6').inactive, true, 'a card of a parked course is labelled, not dropped');
});

test('a quote-only citation is placed where its quote first stands in the page text', () => {
  const state = library();
  state.sources[3].text = 'alpha beta gamma';
  state.decks[0].cards.push({ id: 'c8', kind: 'flashcard', topic: 't', prompt: 'p', answer: 'a', citations: [{ sourceId: 's4', quote: 'beta' }] });
  const link = linkedCardIndex(state, { now: NOW }).bySource.get('s4')[0];
  assert.deepEqual([link.start, link.end], [6, 10]);
});

test('documentCards gathers a page range once per card and summarises it (counts the card on two pages once)', () => {
  const state = library(), index = linkedCardIndex(state, { now: NOW });
  const both = documentCards(index, ['s1', 's2']);
  assert.deepEqual(both.cards.map(entry => entry.cardId).sort(), ['c1', 'c2', 'c3', 'c6']);
  assert.equal(both.summary.total, 4);
  assert.equal(both.summary.counts.new, 2);
  assert.equal(both.summary.inactive, 1);
  assert.equal(documentCards(index, ['s4']).summary.state, 'none');
});

test('the per-document index has a summary for the document, every page and every chapter with at least one question', () => {
  const state = library();
  const result = materialMasteryIndex(state, { now: NOW });
  const [key] = Object.keys(result);
  assert.equal(Object.keys(result).length, 1);
  const entry = result[key];
  assert.equal(entry.document.total, 5, 'c1 c2 c3 c4 c6; suspended and archived are not counted');
  assert.equal(entry.pages.s1.total, 3);
  assert.equal(entry.pages.s4, undefined, 'a page with no question has no entry; the row says 还没出题');
  assert.equal(entry.pages.s3.state, 'familiar');
});

test('chapters of a converted book and of a kept segmentation both receive their cards', () => {
  const sources = pdfSources([1, 2, 3, 4]);
  sources.forEach((source, index) => { source.document.origin = 'converted'; source.document.converter = 'mineru'; source.document.chapter = index < 2 ? { index: 0, title: 'One', level: 1 } : { index: 1, title: 'Two', level: 1 }; });
  const state = { sources, attempts: [], decks: [{ id: 'd', title: 'D', cards: [card('a', 'mastered', [cite('s1', 0, 1)]), card('b', 'new', [cite('s4', 0, 1)]), card('c', 'familiar', [cite('s2')])] }] };
  const entry = Object.values(materialMasteryIndex(state, { now: NOW }))[0];
  assert.deepEqual([entry.chapters[0].total, entry.chapters[1].total], [2, 1]);
  assert.equal(entry.chapters[0].state, 'mastered', 'mastered + familiar = 88%, nothing weak');
  assert.equal(entry.chapters[1].state, 'unlearned');
});

test('a chapter that starts inside a page owns the cards from that offset on; earlier cards stay with the previous chapter', () => {
  const item = { sourceIds: ['a', 'b'], segmentation: { level: 1 }, chapters: [
    { index: 0, startSourceId: 'a', startOffset: 0, sourceIds: ['a'] }, { index: 1, startSourceId: 'a', startOffset: 50, sourceIds: [], partial: true }, { index: 2, startSourceId: 'b', startOffset: 0, sourceIds: ['b'] }] };
  assert.equal(chapterIndexOf(item, 'a', 10), 0);
  assert.equal(chapterIndexOf(item, 'a', 60), 1);
  assert.equal(chapterIndexOf(item, 'a', null), 0, 'no position: the page belongs to the chapter that starts it');
  assert.equal(chapterIndexOf(item, 'b', 3), 2);
  assert.equal(chapterIndexOf({ sourceIds: ['a'], chapters: [{ index: 0, sourceIds: ['a'] }] }, 'a', 4), 0);
  assert.equal(chapterIndexOf({ sourceIds: ['a'], chapters: [] }, 'a', 4), null);
});

test('"5 道题 · 2 道到期 · 1 道薄弱" only names what is there', () => {
  const words = { questions: n => `${n} questions`, due: n => `${n} due`, weak: n => `${n} weak`, fresh: n => `${n} new` };
  assert.equal(dueNewWeakLine(summarizeLinked([{ level: 'weak', due: true }, { level: 'learning', due: true }, { level: 'new' }, { level: 'mastered' }, { level: 'mastered' }]), words), '5 questions · 2 due · 1 weak · 1 new');
  assert.equal(dueNewWeakLine(summarizeLinked([{ level: 'mastered' }]), words), '1 questions');
  assert.equal(dueNewWeakLine(summarizeLinked([]), words), '');
});

test('attempts give the weak level exactly like the dashboard', () => {
  const state = library();
  const links = linkedCardIndex(state, { now: NOW }).bySource.get('s2');
  assert.equal(links.find(link => link.cardId === 'c3').level, 'weak');
  assert.equal(links.find(link => link.cardId === 'c2').level, 'new');
  assert.ok(attemptsFor('d1'));
});
