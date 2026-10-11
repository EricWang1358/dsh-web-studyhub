import { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { usePersistentState } from '../storage.js';
import { rowOf } from './model.js';

/* 复习全书, the two ways to read the book in 预览 (docs/review-book.md "Reading modes"): 逐节读 (the default) shows ONE point with its chapter and section
   path, 上一节 / 下一节 and the ← / → keys; 整章滚动 is the chapters in one scroll, each point folded to its title and one line except the one being read.
   The choice is kept per library and course in this browser. Nothing here changes the book. */

/** The page's reading mode and the points open in 整章滚动, for the chapters under it (null: every point open, as before). */
export const BookReadContext = createContext(null);

/** The points of the book in reading order, then 未归位 when it holds text: [{ hid, node, path: [the chapter and sections above it] }]. */
export function bookSteps(book) {
  if (book?.status !== 'ok') return [];
  const steps = [];
  const walk = (list, path) => (list || []).forEach(node => (node.leaf ? steps.push({ hid: node.hid, node, path }) : walk(node.children, [...path, node])));
  walk(book.nodes, []);
  if (String(book.unplaced?.text ?? '').trim()) {
    steps.push({ hid: 'unplaced', node: { hid: 'unplaced', title: book.unplaced.title, text: book.unplaced.text, file: book.unplaced.file, number: '' }, path: [] });
  }
  return steps;
}

/** The step that shows a heading (`id`: a heading id or a node key of the 总纲): a point's own; a chapter or section: its first point; a heading the
    learner typed: the point whose files hold it (the step before it in the 目录). -1 when there is none. */
export function stepIndexOf(steps, toc, rows, id) {
  const row = rowOf(rows, id), hid = row?.hid ?? id, own = steps.findIndex(step => step.hid === hid);
  if (own >= 0) return own;
  if (row) return steps.findIndex(step => step.path.some(node => node.hid === hid));
  const at = toc.findIndex(entry => entry.id === id);
  for (let back = at - 1; at >= 0 && back >= 0; back -= 1) {
    const found = steps.findIndex(step => step.hid === toc[back].id);
    if (found >= 0) return found;
  }
  return -1;
}

const MODES = ['step', 'scroll'];
/** -> { mode, setMode, expanded, expand(hid, on), only(hid) }: the reading mode (kept per library and course) and the points open in 整章滚动 (`only`
    opens one and closes the others, for a jump). */
export function useBookReading(root, course) {
  const [mode, setMode] = usePersistentState(`study-book-reading:${root}:${course}`, 'step', { parse: value => (MODES.includes(value) ? value : 'step'), serialize: value => value });
  const [expanded, setExpanded] = useState(() => new Set());
  const expand = useCallback((hid, on) => setExpanded(current => {
    if (current.has(hid) === on) return current;
    const next = new Set(current);
    if (on) next.add(hid); else next.delete(hid);
    return next;
  }), []);
  const only = useCallback(hid => setExpanded(current => (current.size === 1 && current.has(hid) ? current : new Set(hid ? [hid] : []))), []);
  return useMemo(() => ({ mode, setMode, expanded, expand, only }), [mode, setMode, expanded, expand, only]);
}

// The ← / → keys belong to whatever has the focus when it is a field, an editor, a menu, a segmented control or the 弄懂 panel, and to a selection.
const OWN_KEYS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="tablist"], [role="radiogroup"], [role="slider"], .sh-seg, .cm-editor, .book-ai-ask, dialog';
/** ← / → go to the previous / next point while `on` (go(-1) / go(1)). */
export function useStepKeys(on, go) {
  useEffect(() => {
    if (!on || typeof window === 'undefined') return undefined;
    const press = event => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target?.closest?.(OWN_KEYS) || window.getSelection?.()?.toString()) return;
      event.preventDefault();
      go(event.key === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [on, go]);
}
