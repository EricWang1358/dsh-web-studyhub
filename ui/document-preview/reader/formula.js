/* The reader's one formula unit, the same markup whatever the material is (a text source: ReadingSections.jsx; Markdown: markdown.js).
   The stored text of the formula (RAW, "$…$") stays in the page as a visually hidden source, so every walker that skips
   [data-study-marker] (selection, find, links, translation, outline) counts exactly the characters that are stored; the
   drawing beside it is that marker. A formula is atomic: selection, find and the link underlines never end inside one. */
import { renderStudyFormula } from '../../study-math-render.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ESCAPES[char]);
const formulaOf = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.reader-math') ?? null;

export const formulaClass = display => `reader-math${display ? ' reader-math--display' : ''}`;

/** The drawing of { source, display, raw } as MathML (the raw text when the TeX cannot be drawn); `label` is a Markdown equation number. */
export const formulaViewHtml = ({ source, display, raw, label }) =>
  (renderStudyFormula(source, display) ?? escapeHtml(raw)) + (label ? `<span class="reader-math__label">(${escapeHtml(label)})</span>` : '');

/** The whole unit as markup: the hidden source (RAW, escaped) and the drawing marker. */
export const formulaHtml = formula => `<span class="${formulaClass(formula.display)}"><span class="sh-visually-hidden reader-math__source" aria-hidden="true">${escapeHtml(formula.raw)}</span>`
  + `<span class="reader-math__view" data-study-marker="true">${formulaViewHtml(formula)}</span></span>`;

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
