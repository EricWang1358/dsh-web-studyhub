/* Formulas drawn when they come near the screen, not all when a chapter opens (a chapter of a converted textbook holds hundreds; drawing
   them all up front was most of the reader's first long task). Until then the formula's own text stands in its place, inside the drawing
   marker, so selection, find, the links and the outline, which skip [data-study-marker], read the same characters either way. A drawing is
   kept per formula text, so a formula seen once (another chapter, the same chapter again) is never drawn twice. */
import { createContext, useContext, useEffect, useState } from 'react';
import { formulaViewHtml } from './formula.js';

/** How much drawn text the cache keeps, in characters (about 6 MB of strings). A budget, not a count: a KaTeX drawing (#996) is about 4,200
    characters where a MathML one was about 640, so the old 4000 drawings would have kept about 34 MB; this keeps about 700 of them,
    more than a chapter shows at once, and drawing one again costs well under a millisecond. */
export const KEPT_FORMULA_CHARS = 3_000_000;
const drawings = new Map();
let keptChars = 0;

/** The characters the cache holds now (what KEPT_FORMULA_CHARS bounds). */
export const keptFormulaChars = () => keptChars;

/** The drawing of a formula, from the cache when it was drawn before. */
export function formulaDrawing(formula) {
  const key = `${formula.display ? 'd' : 'i'}\u0000${formula.label ?? ''}\u0000${formula.raw}`;
  let html = drawings.get(key);
  if (html === undefined) {
    html = formulaViewHtml(formula);
    drawings.set(key, html);
    keptChars += html.length;
    for (const [oldest, kept] of drawings) {
      if (keptChars <= KEPT_FORMULA_CHARS || oldest === key) break;
      drawings.delete(oldest); keptChars -= kept.length;
    }
  }
  return html;
}

/** The watcher of the reading column the formulas are in (createFormulaWatch, ui/formula-queue.js); none (null) draws every formula at once, as a page rendered to a string does. */
export const FormulaWatch = createContext(null);

/** Whether a formula is drawn yet: at once without a watcher, else once its element (`ref`) comes near the screen. */
export function useFormulaShown(ref) {
  const watch = useContext(FormulaWatch), [shown, setShown] = useState(!watch);
  useEffect(() => {
    if (shown || !watch || !ref.current) return undefined;
    return watch.observe(ref.current, () => setShown(true));
  }, [watch, shown, ref]);
  return shown;
}
