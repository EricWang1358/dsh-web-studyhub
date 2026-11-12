/* #1014, the pure parts: when a chapter counts as read, what the library calls it, which key turns the chapter, and the linked questions of the
   chapter on screen in the order of the text. The browser side is tests/reader-chapter-progress-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_AT, chapterRefs, chapterStep, outlineChapterMarks, scrollProgress } from '../ui/document-preview/reader/chapter-reads.js';
import { chapterGroups, inReadingOrder } from '../ui/document-preview/links/link-scope.js';

test('with a kept AI outline, the first entry inside each chapter carries that chapter\'s ✓ (gate review of #1021, 2)', () => {
  const chapters = [{ id: 'chapter-0', sourceIds: ['p1', 'p2', 'p3'] }, { id: 'chapter-1', sourceIds: ['p4', 'p5'] }, { id: 'chapter-2', sourceIds: ['p6'] }];
  const items = [{ id: 'ai-0', sourceId: 'p1' }, { id: 'ai-1', sourceId: 'p2' }, { id: 'ai-2' }, { id: 'ai-3', sourceId: 'p5' }, { id: 'ai-4', sourceId: 'p4' }, { id: 'ai-5', sourceId: 'p9' }];
  assert.deepEqual([...outlineChapterMarks(items, chapters)], [['ai-0', 'chapter-0'], ['ai-3', 'chapter-1']], 'one entry per chapter, the first listed; a chapter with no entry has none');
  // The automatic outline: its chapter rows are the chapters themselves.
  assert.deepEqual([...outlineChapterMarks([{ id: 'chapter-0', kind: 'chapter' }, { id: 'h-1', kind: 'page', sourceId: 'p1' }], chapters)], [['chapter-0', 'chapter-0']]);
  assert.equal(outlineChapterMarks(null, chapters).size, 0);
});

test('a chapter is read once scrolled 90% through; one that fits on the screen is seen whole', () => {
  assert.equal(READ_AT, 0.9);
  assert.equal(scrollProgress({ scrollTop: 900, clientHeight: 100, scrollHeight: 1100 }), 0.9);
  assert.equal(scrollProgress({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 }), 1);
  assert.equal(scrollProgress({ scrollTop: 5000, clientHeight: 100, scrollHeight: 1100 }), 1);
  assert.equal(scrollProgress({}), 1);
});

test('the library names a chapter by its id, title and pages only', () => {
  assert.deepEqual(chapterRefs([{ id: 'chapter-1', index: 1, title: 'Supply', startPage: 21, endPage: 40, sectionIds: ['a'], sourceIds: ['b'], block: false },
    { id: 'block-0', title: '', startPage: 1, endPage: 20 }]), [{ id: 'chapter-1', title: 'Supply', startPage: 21, endPage: 40 }, { id: 'block-0', title: '', startPage: 1, endPage: 20 }]);
});

test('[ and ] turn the chapter, never with a modifier or while typing', () => {
  const key = (key, extra = {}) => ({ key, code: '', target: { closest: () => null }, ...extra });
  assert.equal(chapterStep(key('[')), -1);
  assert.equal(chapterStep(key(']')), 1);
  assert.equal(chapterStep(key('Process', { code: 'BracketRight' })), 1, 'an input method that renames the key');
  assert.equal(chapterStep(key('{', { code: 'BracketLeft', shiftKey: true })), 0, 'Shift+[ is another key');
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) assert.equal(chapterStep(key(']', { [modifier]: true })), 0, modifier);
  assert.equal(chapterStep(key(']', { target: { closest: selector => (selector.includes('input') ? {} : null) } })), 0, 'typing in a field');
  assert.equal(chapterStep(key('p')), 0);
});

test('本章 keeps the passages of the chapter on screen, in the order of the text; 全书 keeps all of them in that order', () => {
  const group = (number, sourceId, start) => ({ number, selection: { sourceId, start } });
  const groups = [group(1, 'p3', 40), group(2, 'p1', 90), group(3, 'p3', 5), group(4, 'p9', 0), group(5, 'p1', 10)];
  const order = new Map([['p1', 0], ['p3', 2], ['p9', 8]]);
  assert.deepEqual(chapterGroups(groups, { sourceIds: new Set(['p1', 'p3']), order }).map(item => item.number), [5, 2, 3, 1]);
  assert.deepEqual(inReadingOrder(groups, order).map(item => item.number), [5, 2, 3, 1, 4]);
  assert.deepEqual(chapterGroups(groups, { order }).map(item => item.number), [5, 2, 3, 1, 4], 'no chapters: everything');
  assert.deepEqual(chapterGroups([group(1, 'x', undefined), group(2, 'p1', 3)], { order }).map(item => item.number), [2, 1], 'an unknown place goes last');
});
