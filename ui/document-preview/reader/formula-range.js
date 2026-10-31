/* A formula in a selection, without drawing it (formula.js draws). The workspace's selection code imports this module, so it
   must stay free of the formula renderer: KaTeX loads only where a formula is drawn (tests/workspace-closure-katex.test.mjs). */
const formulaOf = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.reader-math') ?? null;

/** Moves a range end that falls inside a formula to just outside it. Whether anything moved. */
export function spanFormulas(range) {
  const first = formulaOf(range.startContainer), last = formulaOf(range.endContainer);
  if (first) range.setStartBefore(first);
  if (last) range.setEndAfter(last);
  return !!(first || last);
}

/** A click on a drawn formula selects the whole formula, also when it lands inside an earlier selection (the browser
 * collapses that one only after the click): one click asks about one formula. */
export function pickFormula(selection, target) {
  const formula = selection && formulaOf(target);
  if (!formula) return false;
  const range = formula.ownerDocument.createRange();
  range.selectNode(formula);
  selection.removeAllRanges(); selection.addRange(range);
  return true;
}

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, .reader-math--display';

/** What a copy of the selection should carry when it touches a formula: the stored text (formulas as their source, never
 * their glyphs), block ends as line breaks. null when it touches none, so the browser's own copy stays. */
export function copyText(selection) {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange(), holder = range.startContainer.ownerDocument.createElement('div');
  spanFormulas(range);
  holder.append(range.cloneContents());
  if (!holder.querySelector('.reader-math')) return null;
  holder.querySelectorAll('[data-study-marker]').forEach(marker => marker.remove());
  holder.querySelectorAll(BLOCKS).forEach(block => block.append('\n'));
  return holder.textContent.replace(/\n{3,}/g, '\n\n').trim();
}
