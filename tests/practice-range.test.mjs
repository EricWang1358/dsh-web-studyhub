/* "做这几页的题": which questions a range of the reader holds, how the reading position is kept and found again, and the
   copy of the mastery marks. Pure logic only (no DOM); the control and the outline meters are checked in the markup and
   browser tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assignCards, lastAtOrBefore, subtreeIds, entrySummaries, rangeCards, rangeOptions, chapterEntryIds, recordVisit, refsOf, sourceIdsOf } from '../ui/document-preview/practice/practice-range.js';
import { captureAnchor, restoreTop } from '../ui/document-preview/practice/reading-position.js';
import { structureOutline } from '../ui/document-preview/reader/outline.js';

const card = (id, level, sources, extra = {}) => ({ deckId: 'd', deckTitle: 'D', cardId: id, level, due: false, inactive: false, kind: 'flashcard', prompt: id,
  links: sources.map(([sourceId, start = 0]) => ({ sourceId, start, end: start + 5 })), ...extra });

/* A paged document: a page is an entry. */
const pages = ['p1', 'p2', 'p3', 'p4'].map((sourceId, index) => ({ id: `page-${index + 1}`, level: 1, title: `Page ${index + 1}`, page: index + 1, sourceId }));
const outlinePages = structureOutline(pages.map(({ sourceId: _s, ...entry }) => entry), { fold: false });
const bySource = new Map(pages.map(entry => [entry.sourceId, entry.id]));
const placeByPage = link => bySource.get(link.sourceId) ?? null;

test('assignCards places each card in the entry its links land in; a card on two pages is in both, an unplaceable card is reported', () => {
  const cards = [card('a', 'new', [['p1']]), card('b', 'mastered', [['p1'], ['p2']]), card('c', 'weak', [['zz']])];
  const { assigned, unplaced } = assignCards(cards, placeByPage);
  assert.deepEqual([...assigned.get('page-1').keys()].sort(), ['d|a', 'd|b']);
  assert.deepEqual([...assigned.get('page-2').keys()], ['d|b']);
  assert.deepEqual(unplaced.map(item => item.cardId), ['c']);
});

test('lastAtOrBefore finds the last entry that starts at or before a position (binary search over a monotone test)', () => {
  const starts = [0, 10, 20, 30];
  assert.equal(lastAtOrBefore(starts.length, index => starts[index] <= 25), 2);
  assert.equal(lastAtOrBefore(starts.length, index => starts[index] <= 0), 0);
  assert.equal(lastAtOrBefore(starts.length, index => starts[index] <= -1), -1);
  assert.equal(lastAtOrBefore(starts.length, index => starts[index] <= 99), 3);
  assert.equal(lastAtOrBefore(0, () => true), -1);
});

const tree = structureOutline([{ id: 'h1', level: 1, title: 'One' }, { id: 'h1a', level: 2, title: 'One A' }, { id: 'h1b', level: 2, title: 'One B' },
  { id: 'h2', level: 1, title: 'Two' }, { id: 'h2a', level: 2, title: 'Two A' }], { fold: false });

test('a section holds the questions of its sub-sections: the subtree is the entry and what is below it', () => {
  assert.deepEqual([...subtreeIds(tree, 'h1')], ['h1', 'h1a', 'h1b']);
  assert.deepEqual([...subtreeIds(tree, 'h1a')], ['h1a']);
  assert.deepEqual([...subtreeIds(tree, 'nope')], []);
  const { assigned } = assignCards([card('x', 'new', [['s', 1]]), card('y', 'mastered', [['s', 2]]), card('z', 'weak', [['s', 3]])],
    link => ({ 1: 'h1', 2: 'h1b', 3: 'h2a' }[link.start]));
  const summaries = entrySummaries(tree, assigned);
  assert.equal(summaries.get('h1').total, 2, 'its own and its sub-section');
  assert.equal(summaries.get('h1b').total, 1);
  assert.equal(summaries.get('h2').total, 1);
  assert.equal(summaries.get('h1a'), undefined, 'an entry with no question has no summary: it shows 还没出题');
});

test('rangeCards counts a card once however many entries of the range it sits in', () => {
  const { assigned } = assignCards([card('a', 'new', [['p1'], ['p2']]), card('b', 'weak', [['p2']])], placeByPage);
  const range = rangeCards(new Set(['page-1', 'page-2']), assigned);
  assert.equal(range.cards.length, 2);
  assert.equal(range.summary.total, 2);
  assert.deepEqual(refsOf(range.cards), [{ deckId: 'd', cardId: 'a' }, { deckId: 'd', cardId: 'b' }]);
});

test('the options: this page, this chapter, what was just read; chapters and recent are offered only when they differ from "here"', () => {
  const cards = [card('a', 'new', [['p1']]), card('b', 'weak', [['p2']], { due: true }), card('c', 'mastered', [['p3']]), card('d', 'familiar', [['p4']])];
  const { assigned } = assignCards(cards, placeByPage);
  const none = rangeOptions({ outline: outlinePages, activeId: 'page-2', visited: ['page-2'], assigned, paged: true });
  assert.deepEqual(none.map(option => option.kind), ['here'], 'a paged document without chapters: only the page');
  assert.equal(none[0].summary.total, 1);
  const chaptered = rangeOptions({ outline: outlinePages, activeId: 'page-2', visited: ['page-1', 'page-2', 'page-3'], assigned, paged: true, chapter: ['page-1', 'page-2'] });
  assert.deepEqual(chaptered.map(option => option.kind), ['here', 'chapter', 'recent']);
  assert.deepEqual(chaptered.map(option => option.count), [1, 2, 3]);
  assert.deepEqual(chaptered.map(option => option.summary.total), [1, 2, 3]);
  const sameAsHere = rangeOptions({ outline: outlinePages, activeId: 'page-2', visited: ['page-2', 'page-2'], assigned, paged: true, chapter: ['page-2'] });
  assert.deepEqual(sameAsHere.map(option => option.kind), ['here']);
});

test('a document with no outline has one option: the whole document', () => {
  const { assigned, unplaced } = assignCards([card('a', 'new', [['s']])], () => null);
  const options = rangeOptions({ outline: [], activeId: null, visited: [], assigned, unplaced, paged: false, all: [card('a', 'new', [['s']])] });
  assert.deepEqual(options.map(option => option.kind), ['document']);
  assert.equal(options[0].summary.total, 1);
});

test('the chapter of an entry: down to the applied level, else the top section, else the chapter pages of a converted book', () => {
  assert.deepEqual(chapterEntryIds(tree, 'h1b', { chapterLevel: 1 }), ['h1', 'h1a', 'h1b']);
  assert.deepEqual(chapterEntryIds(tree, 'h2a', {}), ['h2', 'h2a'], 'no segmentation: the top section it sits in');
  assert.equal(chapterEntryIds(tree, 'h2', {}).length, 2);
  assert.deepEqual(chapterEntryIds(outlinePages, 'page-3', { chapterPages: { from: 3, to: 4 } }), ['page-3', 'page-4']);
  assert.equal(chapterEntryIds(outlinePages, 'page-3', {}), null, 'a flat list of pages has no chapter');
  assert.equal(chapterEntryIds(tree, 'zzz', {}), null);
});

test('recordVisit keeps the order the pages were reached in, moves a revisit to the end and is bounded', () => {
  assert.deepEqual(recordVisit(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(recordVisit(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  assert.deepEqual(recordVisit(['a'], 'a'), ['a']);
  assert.equal(recordVisit(Array.from({ length: 60 }, (_, i) => `x${i}`), 'new').length, 40);
  assert.deepEqual(recordVisit(['a'], null), ['a']);
});

test('sourceIdsOf: the pages of an option for 为这几页出题, in reading order; a text document gives the whole document', () => {
  const sections = pages.map(({ id, sourceId, page }) => ({ id, sourceId, page }));
  assert.deepEqual(sourceIdsOf(new Set(['page-3', 'page-2']), { sections, documentSourceIds: ['p1', 'p2', 'p3', 'p4'] }), ['p2', 'p3']);
  assert.deepEqual(sourceIdsOf(new Set(['h1']), { sections: [], documentSourceIds: ['only'] }), ['only']);
  assert.deepEqual(sourceIdsOf(null, { sections, documentSourceIds: ['a', 'b'] }), ['a', 'b']);
});

/* ---------- the reading position ---------- */

test('captureAnchor stores how far into the section the viewport is, the scroll offset and the progress', () => {
  assert.deepEqual(captureAnchor({ scrollTop: 1500, clientHeight: 600, scrollHeight: 4600, sectionTop: 1200 }), { sectionOffset: 300, scrollTop: 1500, progress: 0.375 });
  assert.deepEqual(captureAnchor({ scrollTop: 100, clientHeight: 600, scrollHeight: 4600, sectionTop: 1200 }), { sectionOffset: 0, scrollTop: 100, progress: 0.025 }, 'above the section: offset 0');
  assert.deepEqual(captureAnchor({ scrollTop: 0, clientHeight: 600, scrollHeight: 600 }), { sectionOffset: 0, scrollTop: 0, progress: 0 });
});

test('restoreTop finds the same place again: the section plus the offset, else the scroll offset, else the progress; never out of range', () => {
  const saved = { sectionOffset: 300, scrollTop: 1500, progress: 0.375 };
  assert.equal(restoreTop({ saved, sectionTop: 1200, clientHeight: 600, scrollHeight: 4600 }), 1500, 'same layout: exactly where it was');
  assert.equal(restoreTop({ saved, sectionTop: 1900, clientHeight: 600, scrollHeight: 5200 }), 2200, 'the section moved (a wider window): the section still leads');
  assert.equal(restoreTop({ saved, sectionTop: null, clientHeight: 600, scrollHeight: 4600 }), 1500, 'no section: the offset');
  assert.equal(restoreTop({ saved: { ...saved, scrollTop: 0 }, sectionTop: null, clientHeight: 600, scrollHeight: 4600 }), 1500, 'no section and no offset: the progress');
  assert.equal(restoreTop({ saved, sectionTop: 9000, clientHeight: 600, scrollHeight: 4600 }), 4000, 'clamped to the end of the text');
  assert.equal(restoreTop({ saved: null, sectionTop: 10, clientHeight: 600, scrollHeight: 4600 }), 0);
});
