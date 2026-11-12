/* Formulas drawn when they come near the screen, not all when a chapter opens (a chapter of a converted textbook holds hundreds; drawing
   them all up front was most of the reader's first long task). Until then the formula's own text stands in its place, inside the drawing
   marker, so selection, find, the links and the outline, which skip [data-study-marker], read the same characters either way. A drawing is
   kept per formula text, so a formula seen once (another chapter, the same chapter again) is never drawn twice. */
import { createContext, useContext, useEffect, useState } from 'react';
import { formulaViewHtml } from './formula.js';
import { createFormulaQueue, FORMULAS_PER_FRAME } from '../../formula-queue.js';

/** How far below and above the visible part of the reading column a formula is drawn ahead of time. */
export const FORMULA_MARGIN_PX = 1200;
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

/**
 * One watcher per reading column: `observe(element, show)` calls `show()` once: at once when the element is on the visible part of `rootOf()`
 * (the scroll area, read when the first element is observed), and when it is within FORMULA_MARGIN_PX of it, in a later frame, a few a frame
 * (formula-queue.js), the nearest to the middle of the screen first; one that leaves that band before its turn waits again. It returns the
 * function that stops watching. Without IntersectionObserver every formula is shown at once.
 */
export function createFormulaWatch(rootOf, { margin = FORMULA_MARGIN_PX, perFrame = FORMULAS_PER_FRAME } = {}) {
  let near = null, onScreen = null, height = 0;
  const shows = new Map(), places = new Map();
  const scrolled = () => { const root = rootOf(); return root ? root.scrollTop : (globalThis.scrollY ?? 0); };
  const nearestFirst = elements => {
    const middle = scrolled() + height / 2;
    return elements.sort((a, b) => Math.abs(places.get(a) - middle) - Math.abs(places.get(b) - middle));
  };
  const queue = createFormulaQueue({ perFrame, order: nearestFirst });
  const forget = element => {
    shows.delete(element); places.delete(element); queue.remove(element);
    near?.unobserve(element); onScreen?.unobserve(element);
  };
  const show = element => { const draw = shows.get(element); forget(element); draw?.(); };
  const ensure = () => {
    if (near || typeof IntersectionObserver === 'undefined') return near;
    const root = rootOf() || null;
    near = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const element = entry.target;
        if (!shows.has(element)) continue;
        if (!entry.isIntersecting) { queue.remove(element); continue; }
        // Where it is in the scrolled content: its top below the area's top (the band's top plus the margin), plus how far the area is scrolled.
        const band = entry.rootBounds;
        if (band) height = Math.max(0, band.height - 2 * margin);
        places.set(element, entry.boundingClientRect.top - (band ? band.top + margin : 0) + scrolled());
        queue.add(element, () => show(element));
      }
    }, { root, rootMargin: `${margin}px 0px` });
    onScreen = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting && shows.has(entry.target)) show(entry.target);
    }, { root });
    return near;
  };
  return {
    observe(element, draw) {
      if (!ensure()) { draw(); return () => {}; }
      shows.set(element, draw); near.observe(element); onScreen.observe(element);
      return () => forget(element);
    },
    disconnect() {
      near?.disconnect(); onScreen?.disconnect(); near = onScreen = null;
      queue.clear(); shows.clear(); places.clear();
    },
  };
}

/** The watcher of the reading column the formulas are in; none (null) draws every formula at once, as a page rendered to a string does. */
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
