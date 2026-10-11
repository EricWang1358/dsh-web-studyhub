/* 复习全书 M4: the words an AI block is about, found again in the rendered text of a paragraph (the dashed underline). Pure: the text nodes of a paragraph in
   order, the quotes, and which pieces of which node to mark. Words across a <strong> or a link are one run; the first of repeated words; words not found,
   or that overlap another block's, get no mark; two blocks on the same words share one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorSegments, piecesOf } from '../lib/course-book-ai-anchor.js';

const marks = (texts, anchors) => anchorSegments(texts, anchors).map(group => ({ ids: group.ids, text: group.pieces.map(piece => texts[piece.index].slice(piece.from, piece.to)).join('|') }));

test('plain words in one text node', () => {
  const texts = ['The architect writes each decision down with its reasons.'];
  assert.deepEqual(anchorSegments(texts, [{ id: 'a', quote: 'writes each decision down' }]).map(group => group.pieces), [[{ index: 0, from: 14, to: 39 }]]);
});

test('words across <strong> and a link are marked piece by piece', () => {
  const texts = ['The architect ', 'writes each', ' decision ', 'down', ' with its reasons.'];
  assert.deepEqual(marks(texts, [{ id: 'a', quote: 'writes each decision down' }]), [{ ids: ['a'], text: 'writes each| decision |down' }]);
  assert.deepEqual(marks(['Say ', 'hel', 'lo wor', 'ld now'], [{ id: 'a', quote: 'hello world' }]), [{ ids: ['a'], text: 'hel|lo wor|ld' }]);
});

test('spacing and a line break do not matter; words with other marks around still match by their letters', () => {
  assert.deepEqual(marks(['one  two\nthree four five'], [{ id: 'a', quote: 'two three four' }]), [{ ids: ['a'], text: 'two\nthree four' }]);
  assert.deepEqual(marks(['Entropy (H) measures uncertainty.'], [{ id: 'a', quote: 'Entropy H measures uncertainty' }]).length, 1);
});

test('repeated words: the first run', () => {
  const texts = ['decide the thing. Then decide the thing again.'];
  assert.deepEqual(anchorSegments(texts, [{ id: 'a', quote: 'decide the thing' }])[0].pieces, [{ index: 0, from: 0, to: 16 }]);
});

test('not found, empty, or only a part of a stretch: no mark', () => {
  const texts = ['Nothing about that here.'];
  assert.deepEqual(anchorSegments(texts, [{ id: 'a', quote: 'words that are nowhere' }, { id: 'b', quote: '   ' }, { id: 'c', quote: '' }]), []);
  assert.deepEqual(anchorSegments([], [{ id: 'a', quote: 'anything' }]), []);
  assert.deepEqual(anchorSegments(['abc'], undefined), []);
  // a quote whose two ends are far apart (an elided quote) is not a stretch of its own words
  assert.deepEqual(anchorSegments(['alpha beta gamma delta ' + 'x'.repeat(300) + ' omega sigma'], [{ id: 'a', quote: 'alpha beta gamma delta … omega sigma' }]), []);
});

test('two blocks in one paragraph: both marked, in reading order; the same words share one mark; overlapping words only the first', () => {
  const texts = ['First the cache is warm, ', 'then', ' the cache is read by every client.'];
  assert.deepEqual(marks(texts, [{ id: 'late', quote: 'read by every client' }, { id: 'early', quote: 'the cache is warm' }]).map(item => item.ids), [['early'], ['late']]);
  assert.deepEqual(marks(texts, [{ id: 'a', quote: 'the cache is warm' }, { id: 'b', quote: 'the cache is warm' }]), [{ ids: ['a', 'b'], text: 'the cache is warm' }]);
  assert.deepEqual(marks(texts, [{ id: 'a', quote: 'the cache is warm' }, { id: 'b', quote: 'warm, then the cache' }]).map(item => item.ids), [['a']]);
});

test('pieces: a range of the joined text as pieces of its nodes', () => {
  assert.deepEqual(piecesOf(['abc', 'def', 'ghi'], 2, 7), [{ index: 0, from: 2, to: 3 }, { index: 1, from: 0, to: 3 }, { index: 2, from: 0, to: 1 }]);
  assert.deepEqual(piecesOf(['abc', 'def'], 3, 3), []);
});
