/* When the small panel of 弄懂 / 加一段 (ui/book/BookAiAsk.jsx) stays on the review book's page. It belongs to the selection it was opened for: it goes when the
   selection does (a click elsewhere, a collapsed selection, Escape), and nothing the learner has started is taken from them: words typed in the instruction box
   and a task not yet written keep it open, and so does the focus being inside it (clicking the box or a button moves the selection away from the text). The one
   opened from a heading has no selection; it stays until a click elsewhere with an empty box. A pure decision, so each combination can be tested. */

/** state: { kind: 'selected' | 'here', collapsed (the selection is empty), inBook (it is inside a point's text), focusInside (the focus is in the panel),
    hasText (the instruction box has text), pending (a task started from the panel is not written yet), outside (the decision is for a press outside the panel) }. */
export function askStaysOpen({ kind, collapsed, inBook, focusInside, hasText, pending, outside }) {
  if (pending || hasText) return true;
  // The press is leaving the panel: the focus is still inside it at that moment, which is no reason to stay.
  if (outside) return false;
  if (focusInside) return true;
  if (kind === 'here') return true;
  return !collapsed && !!inBook;
}

/** What the page says of the selection for askStaysOpen: { collapsed, inBook }. `selection` is window.getSelection(). */
export function selectionState(selection) {
  const collapsed = !selection || selection.isCollapsed || !selection.toString().trim();
  const anchor = selection?.anchorNode;
  const element = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
  return { collapsed, inBook: !!element?.closest?.('[data-book-point]') };
}
