/* #1014, the pure parts: when a chapter counts as read, what the library calls it, which key turns the chapter, and the linked questions of the
   chapter on screen in the order of the text. The browser side is tests/reader-chapter-progress-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_AT, chapterRefs, chapterStep, scrollProgress } from '../ui/document-preview/reader/chapter-reads.js';
import { chapterGroups, inReadingOrder } from '../ui/document-preview/links/link-scope.js';

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
