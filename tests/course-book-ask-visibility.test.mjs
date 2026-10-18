/* The 问 AI panel and the selection toolbar of the review book: when they stay (ui/book/ask-visibility.js). Pure; every combination of what the page can say;
   which point a range lies in (fakes of the DOM's closest). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { askStaysOpen, columnBounds, selectionBox, selectionPoint, toolbarStays } from '../ui/book/ask-visibility.js';

test('the panel: a press outside closes it with an empty box; typed words keep it; nothing else closes it but Escape, × or a task', () => {
  assert.equal(askStaysOpen({ outside: true }), false, 'click elsewhere, empty box');
  assert.equal(askStaysOpen({ outside: true, hasText: true }), true, 'typed words are kept');
  assert.equal(askStaysOpen({}), true, 'no press outside: no reason to close');
  assert.equal(askStaysOpen({ hasText: true }), true);
});

test('the toolbar: once the selection is gone it stays only while the focus is in it', () => {
  assert.equal(toolbarStays({}), false);
  assert.equal(toolbarStays({ focusInside: true }), true);
});

test('selectionPoint: start and end in the same point, never in a box or a control', () => {
  const point = { dataset: { bookPoint: 'h2' } }, other = { dataset: { bookPoint: 'h3' } };
  const element = (inPoint, live = false) => ({ nodeType: 1, closest: selector => (selector === '[data-book-point]' ? inPoint : live ? {} : null) });
  const text = parent => ({ nodeType: 3, parentElement: parent });
  const range = (start, end = start) => ({ startContainer: start, endContainer: end });
  assert.equal(selectionPoint(range(text(element(point)))), point);
  assert.equal(selectionPoint(range(text(element(point)), element(point))), point, 'an element end counts');
  assert.equal(selectionPoint(range(text(element(point)), text(element(other)))), null, 'across two points: none');
  assert.equal(selectionPoint(range(text(element(null)))), null, 'outside the book text');
  assert.equal(selectionPoint(range(text(element(point, true)))), null, 'inside the follow-up box, the panel or the toolbar');
  assert.equal(selectionPoint(null), null);
});

test('selectionBox: from the top of the first line to the bottom of the last, as wide as the first line (the toolbar never covers the words); columnBounds: within the reading column', () => {
  const rect = (left, top, width, height = 20) => ({ left, top, right: left + width, bottom: top + height, width, height });
  assert.deepEqual(selectionBox([rect(100, 300, 200), rect(40, 328, 260)]), { left: 100, right: 300, top: 300, bottom: 348, x: 100, y: 300, width: 200, height: 48 }, 'two lines: above the first');
  assert.deepEqual(selectionBox([rect(100, 300, 50), rect(150, 301, 20)]), { left: 100, right: 170, top: 300, bottom: 321, x: 100, y: 300, width: 70, height: 21 }, 'one line of two pieces (a 角标 in it)');
  assert.equal(selectionBox([rect(0, 0, 0)]), null, 'nothing drawn');
  assert.equal(selectionBox([]), null);
  assert.deepEqual(columnBounds({ left: 0, right: 1280, top: 50, bottom: 900 }, { left: 320, right: 1234 }), { left: 320, right: 1234, top: 50, bottom: 900 });
  assert.deepEqual(columnBounds({ left: 60, right: 420, top: 0, bottom: 900 }, { left: 40, right: 440 }), { left: 60, right: 420, top: 0, bottom: 900 }, 'never wider than what is visible');
  assert.deepEqual(columnBounds({ left: 1, right: 2, top: 3, bottom: 4 }, null), { left: 1, right: 2, top: 3, bottom: 4 });
});
