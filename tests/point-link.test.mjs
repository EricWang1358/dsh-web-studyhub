import test from 'node:test';
import assert from 'node:assert/strict';
import { POINT_LIMITS, cardPoints, itemPlaceIndex, outlineLeaves, pointGaps, pointQuota, pointSpans } from '../lib/evidence/point-link.js';

/* 知识点查缺, the link (lib/evidence/point-link.js): a question is about the knowledge points whose VERIFIED inventory places its own places overlap (tier 1);
   only when none does, about the points that own its pages (tier 0, the outline page's placement as it always was). Nothing is stored: computed on read. */

const id = n => `i${String(n).padStart(11, '0')}`;
const place = (sourceId, start, end, verified = true) => ({ range: 'r', doc: 'D', sourceId, start, end, quote: 'q', verified });
const item = (n, ...places) => ({ id: id(n), kind: 'concept', name: `item ${n}`, gist: '', places });

// Leaves A and B share page s1 (A owns it); B owns no page. C owns page s2. D has only an unverified place: it can never be placed by tier 1 nor topped up.
const outline = { nodes: [
  { id: 'ch1', title: 'Chapter 1', children: [
    { id: 'a', title: 'Point A', anchors: ['D@s0-0'], items: [id(1), id(2)] },
    { id: 'b', title: 'Point B', anchors: [], items: [id(3)], prereqIds: ['a'] },
  ] },
  { id: 'c', title: 'Point C', anchors: ['D@s1-1'], items: [id(4)], prereqIds: ['b'] },
  { id: 'd', title: 'Point D', anchors: [], items: [id(5)] },
], other: { anchors: [] } };
const inventory = { items: [item(1, place('s1', 10, 30)), item(2, place('s1', 40, 60)), item(3, place('s1', 100, 130)), item(4, place('s2', 5, 25)),
  item(5, place('s2', 0, 0, false)), item(9, place('s1', 300, 340))] };

test('the leaves of an outline in reading order, with their items and prerequisites', () => {
  assert.deepEqual(outlineLeaves(outline).map(leaf => leaf.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(outlineLeaves(outline)[1].prereqIds, ['a']);
  assert.deepEqual(outlineLeaves({ nodes: [{ id: 'x', title: 'X', anchors: ['D'] }] })[0].items, [], 'a descriptors outline has leaves without items');
});

test('tier 1: a place overlapping a verified item place names its point; unverified and zero-length places name nothing', () => {
  const index = itemPlaceIndex(outline, inventory);
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: 15, end: 25 }], pagePoints: ['a'] }, index), { points: ['a'], tier: 1 });
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: 105, end: 110 }], pagePoints: ['a'] }, index), { points: ['b'], tier: 1 },
    'a point that owns no page gets its question by the item it overlaps, not the page owner');
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's2', start: 0, end: 3 }], pagePoints: ['c'] }, index), { points: ['c'], tier: 0 },
    'an unverified (zero-length) place is never matched: the page decides');
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: 30, end: 40 }], pagePoints: ['a'] }, index), { points: ['a'], tier: 0 }, 'touching is not overlapping');
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: 300, end: 320 }], pagePoints: ['a'] }, index), { points: ['a'], tier: 0 },
    'an item no leaf holds names no point');
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's9', start: 15, end: 25 }], pagePoints: [] }, index), { points: [], tier: null }, 'another source: no point at all');
});

test('a question citing two passages is about both points; a question with no located quote falls back to its page', () => {
  const index = itemPlaceIndex(outline, inventory);
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: 20, end: 25 }, { sourceId: 's2', start: 10, end: 12 }], pagePoints: ['a', 'c'] }, index),
    { points: ['a', 'c'], tier: 1 });
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: 25, end: 45 }], pagePoints: [] }, index), { points: ['a'], tier: 1 }, 'two items of one point: the point once');
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: null, end: null }], pagePoints: ['a'] }, index), { points: ['a'], tier: 0 });
  assert.deepEqual(cardPoints({ places: [], pagePoints: [] }, index), { points: [], tier: null });
});

test('a descriptors outline (no items) links nothing by tier 1: the index is empty and every question keeps its page', () => {
  const index = itemPlaceIndex({ nodes: [{ id: 'x', title: 'X', anchors: ['D'] }] }, inventory);
  assert.equal(index.size, 0);
  assert.deepEqual(cardPoints({ places: [{ sourceId: 's1', start: 15, end: 25 }], pagePoints: ['x'] }, index), { points: ['x'], tier: 0 });
  assert.equal(itemPlaceIndex(outline, null).size, 0, 'no inventory: nothing to link by');
});

test('the text of a point: its verified places, merged only where they overlap or touch (every character verified), the passage holding most places first', () => {
  const leaf = { id: 'p', items: [id(1), id(2), id(3), id(5)] };
  const spans = pointSpans(leaf, inventory);
  assert.deepEqual(spans.map(({ sourceId, start, end, places }) => [sourceId, start, end, places]), [['s1', 10, 30, 1], ['s1', 40, 60, 1], ['s1', 100, 130, 1]],
    'places with text between them stay apart; the unverified place is no text');
  const close = { items: [item(1, place('s1', 0, 20)), item(2, place('s1', 20, 40)), item(3, place('s1', 30, 50)), item(4, place('s2', 0, 10)), item(6, place('s1', 51, 60))] };
  assert.deepEqual(pointSpans({ items: [id(1), id(2), id(3), id(4), id(6)] }, close).map(span => [span.sourceId, span.start, span.end, span.places]),
    [['s1', 0, 50, 3], ['s1', 51, 60, 1], ['s2', 0, 10, 1]]);
  assert.ok(!('gapChars' in POINT_LIMITS) && !('padChars' in POINT_LIMITS), 'no text the link would not credit');
  assert.deepEqual(pointSpans({ items: [id(5)] }, inventory), [], 'a point with no verified place has no text to write from');
});

test('a large point asks for two questions, every other point one; the threshold is one named number', () => {
  assert.equal(pointQuota({ items: Array.from({ length: POINT_LIMITS.largeItems - 1 }, (_, n) => id(n)) }), 1);
  assert.equal(pointQuota({ items: Array.from({ length: POINT_LIMITS.largeItems }, (_, n) => id(n)) }), 2);
  assert.equal(pointQuota({}), 1);
});

test('the gaps: per point its questions, the uncovered ones with prerequisites first, and the questions that reach no point', () => {
  const cards = [
    { ref: 'k|1', places: [{ sourceId: 's1', start: 15, end: 25 }], pagePoints: ['a'] },
    { ref: 'k|2', places: [{ sourceId: 's1', start: 105, end: 110 }], pagePoints: ['a'] },
    { ref: 'k|3', places: [{ sourceId: 's1', start: 200, end: 220 }], pagePoints: ['a'] },
    { ref: 'k|4', places: [], pagePoints: [] },
    { ref: 'k|5', places: [], pagePoints: ['other'] },
  ];
  const gaps = pointGaps(outline, inventory, cards);
  assert.deepEqual(gaps.points.map(point => [point.id, point.cards]), [['a', 2], ['b', 1], ['c', 0], ['d', 0]]);
  assert.deepEqual(gaps.uncovered, ['c', 'd']);
  assert.equal(gaps.unplaced, 2, 'no point, and 其他 is no point');
  assert.deepEqual(gaps.points.find(point => point.id === 'd'), { id: 'd', title: 'Point D', cards: 0, prereqIds: [], dependents: 0, coverable: false, quota: 1 });
  assert.equal(gaps.points.find(point => point.id === 'a').dependents, 2, 'b needs a, c needs b');
});

test('the uncovered order: what other points rest on comes first (a prerequisite before what needs it), then reading order', () => {
  const chain = { nodes: [
    { id: 'x', title: 'X', anchors: [], items: [id(1)] },
    { id: 'c', title: 'C', anchors: [], items: [id(2)], prereqIds: ['b'] },
    { id: 'b', title: 'B', anchors: [], items: [id(3)], prereqIds: ['a'] },
    { id: 'a', title: 'A', anchors: [], items: [id(4)] },
    { id: 'e', title: 'E', anchors: [], items: [id(9)], prereqIds: ['y'] },
    { id: 'y', title: 'Y', anchors: [], items: [id(5)] },
  ], other: { anchors: [] } };
  const cards = [{ ref: 'k|y', places: [{ sourceId: 's2', start: 0, end: 1 }], pagePoints: ['y'] }];
  const gaps = pointGaps(chain, inventory, cards);
  assert.deepEqual(gaps.uncovered, ['a', 'b', 'x', 'c', 'e'], 'a (2 rest on it) before b (1); the covered y is a prerequisite but not listed');
});
