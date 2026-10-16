/* The 问 AI panel and the selection toolbar of the review book (ui/book/BookAsk.jsx, ui/book/BookSelectBar.jsx): when they stay, and what a selection in a
   point is. The toolbar belongs to its selection: it goes when the selection does (a click elsewhere, a collapsed selection, Escape), except while the focus is
   in it (a keyboard learner tabbed into it). The panel stays until Escape, its ×, a task started from it, or a press outside with an empty box (words typed in
   it are never taken from the learner). Pure decisions, so each combination can be tested; the two DOM readers below are what the toolbar asks of a range. */

/** The panel, for a press outside it: { hasText (the box has words), outside (the decision is for a press outside) } -> stays. */
export function askStaysOpen({ hasText = false, outside = false } = {}) {
  if (hasText) return true;
  return !outside;
}

/** The toolbar, once the selection is gone: it stays only while the focus is in it. */
export const toolbarStays = ({ focusInside = false } = {}) => !!focusInside;

const LIVE = 'input, textarea, select, [contenteditable="true"], .book-ask, .book-select';
const elementOf = node => (node?.nodeType === 1 ? node : node?.parentElement ?? null);

/** The point (its `[data-book-point]` element) a range lies in: start and end in the same point, outside any box or control; else null. */
export function selectionPoint(range) {
  const start = elementOf(range?.startContainer), end = elementOf(range?.endContainer);
  const point = start?.closest?.('[data-book-point]');
  if (!point || end?.closest?.('[data-book-point]') !== point || start.closest(LIVE) || end.closest(LIVE)) return null;
  return point;
}

/** The words of a range as the learner reads them: the 角标 digits left out, a formula as its TeX, the word joiners off, spaces squashed. */
export function selectedWords(range) {
  const box = range.startContainer.ownerDocument.createElement('div');
  box.append(range.cloneContents());
  box.querySelectorAll('.md-cite').forEach(mark => mark.remove());
  box.querySelectorAll('.katex').forEach(formula => { const tex = formula.querySelector('annotation')?.textContent; formula.replaceWith(tex ? `$${tex}$` : formula.textContent); });
  return box.textContent.replace(/⁠/g, '').replace(/\s+/g, ' ').trim();
}
