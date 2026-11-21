/* The reader's one formula unit, the same markup whatever the material is (a text source: ReadingSections.jsx; Markdown: markdown.js).
   The stored text of the formula (RAW, "$…$") stays in the page as a visually hidden source, so every walker that skips
   [data-study-marker] (selection, find, links, translation, outline) counts exactly the characters that are stored; the
   drawing beside it is that marker. A formula is atomic: selection, find and the link underlines never end inside one. */
import { renderStudyFormula } from '../../study-math-render.js';

// What a selection does with a formula needs no drawing: it lives in formula-range.js, so the workspace's selection code
// (selection.js) does not bring the formula renderer (KaTeX) along. The reader, which draws, gets both from here.
export { spanFormulas, pickFormula, copyText } from './formula-range.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ESCAPES[char]);

export const formulaClass = display => `reader-math${display ? ' reader-math--display' : ''}`;

const FORMULA_CACHE_LIMIT = 512;
const FORMULA_CACHE_MAX_LEN = 2000;
const formulaViewCache = new Map();

/** The drawing of { source, display, raw } as MathML (the raw text when the TeX cannot be drawn); `label` is a Markdown equation number. */
export const formulaViewHtml = ({ source, display, raw, label }) => {
  const src = String(source ?? ''), lbl = label ? String(label) : '';
  const cacheable = src.length <= FORMULA_CACHE_MAX_LEN;
  const key = cacheable ? `${display ? '1' : '0'}:${lbl}:${src}` : '';
  if (cacheable && formulaViewCache.has(key)) {
    const hit = formulaViewCache.get(key);
    formulaViewCache.delete(key);
    formulaViewCache.set(key, hit);
    return hit;
  }
  const mathHtml = renderStudyFormula(source, display);
  const labelHtml = label ? `<span class="reader-math__label">(${escapeHtml(label)})</span>` : '';
  if (mathHtml === null || mathHtml === undefined) return escapeHtml(raw) + labelHtml;
  const rendered = mathHtml + labelHtml;
  if (cacheable) {
    if (formulaViewCache.size >= FORMULA_CACHE_LIMIT) formulaViewCache.delete(formulaViewCache.keys().next().value);
    formulaViewCache.set(key, rendered);
  }
  return rendered;
};

/** The whole unit as markup: the hidden source (RAW, escaped) and the drawing marker. */
export const formulaHtml = formula => `<span class="${formulaClass(formula.display)}"><span class="sh-visually-hidden reader-math__source" aria-hidden="true">${escapeHtml(formula.raw)}</span>`
  + `<span class="reader-math__view" data-study-marker="true">${formulaViewHtml(formula)}</span></span>`;
