/* The panel of 弄懂 / 加一段 over the review book: when it stays (ui/book/ask-visibility.js). Pure; every combination of what the page can say. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { askStaysOpen, selectionState } from '../ui/book/ask-visibility.js';

const base = { kind: 'selected', collapsed: false, inBook: true, focusInside: false, hasText: false, pending: false, outside: false };
const stays = patch => askStaysOpen({ ...base, ...patch });

test('over selected words: only while there is a selection inside the book text', () => {
  assert.equal(stays({}), true, 'a selection in the text');
  assert.equal(stays({ collapsed: true }), false, 'collapsed: gone');
  assert.equal(stays({ inBook: false }), false, 'a selection outside the book text: gone');
  assert.equal(stays({ collapsed: true, inBook: false }), false);
});

test('the focus inside the panel keeps it, whatever the selection did', () => {
  assert.equal(stays({ focusInside: true, collapsed: true }), true);
  assert.equal(stays({ focusInside: true, inBook: false }), true);
  assert.equal(stays({ focusInside: true, collapsed: true, inBook: false }), true);
});

test('words in the instruction box keep it, a pending task keeps it', () => {
  for (const patch of [{ hasText: true }, { pending: true }, { hasText: true, pending: true }]) {
    assert.equal(stays({ ...patch, collapsed: true }), true, JSON.stringify(patch));
    assert.equal(stays({ ...patch, collapsed: true, inBook: false }), true, JSON.stringify(patch));
    assert.equal(stays({ ...patch, collapsed: true, outside: true }), true, `${JSON.stringify(patch)} even for a press outside`);
  }
});

test('a press outside closes it, even while the focus is still inside (an empty box)', () => {
  assert.equal(stays({ outside: true }), false, 'the selection is still there at the press');
  assert.equal(stays({ outside: true, focusInside: true }), false, 'the focus has not moved yet at the press');
  assert.equal(stays({ outside: true, collapsed: true }), false);
});

test('under a heading (no selection): stays until a press outside with an empty box', () => {
  const here = patch => stays({ kind: 'here', collapsed: true, inBook: false, ...patch });
  assert.equal(here({}), true, 'no selection is no reason to close');
  assert.equal(here({ focusInside: true }), true);
  assert.equal(here({ outside: true }), false, 'click elsewhere, empty box');
  assert.equal(here({ outside: true, focusInside: true }), false);
  assert.equal(here({ outside: true, hasText: true }), true, 'typed words are kept');
  assert.equal(here({ outside: true, pending: true }), true);
});

test('selectionState: collapsed or blank is collapsed; inBook looks for the point holding the anchor', () => {
  const inside = { closest: selector => (selector === '[data-book-point]' ? {} : null) }, outside = { closest: () => null };
  const text = parent => ({ nodeType: 3, parentElement: parent });
  const selection = (anchor, words, collapsed = false) => ({ isCollapsed: collapsed, anchorNode: anchor, toString: () => words });
  assert.deepEqual(selectionState(selection(text(inside), 'records')), { collapsed: false, inBook: true });
  assert.deepEqual(selectionState(selection(text(outside), 'records')), { collapsed: false, inBook: false });
  assert.deepEqual(selectionState(selection(text(inside), '  \n ')), { collapsed: true, inBook: true });
  assert.deepEqual(selectionState(selection(text(inside), 'records', true)), { collapsed: true, inBook: true });
  assert.deepEqual(selectionState(selection({ nodeType: 1, ...inside }, 'x')), { collapsed: false, inBook: true });
  assert.deepEqual(selectionState(null), { collapsed: true, inBook: false });
});
