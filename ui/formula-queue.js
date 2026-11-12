/* Formulas are drawn when they come near the screen, a few per frame, not all in one task (gate review of #996). A KaTeX drawing is 70–210
   elements, each styled and laid out by the browser: about 10 ms for a display formula, so the 40 formulas a chapter draws ahead of the screen
   when it opens were one task of up to 400 ms, where two a frame stay far under the 50 ms a frame may take. One queue serves every watch on the
   page (the reader's column, the formulas of the rest of the app): one budget a frame, the nearest to the middle of the screen first. Formulas on
   screen are drawn at once. No KaTeX here: StudyMath imports this module and loads the renderer in a chunk of its own (tests/client-boundaries). */

/** How many formulas off screen are drawn per frame, all watches together. */
export const FORMULAS_PER_FRAME = 2;
/** How far beyond the visible part of its scroll area a formula is drawn ahead of time. */
export const FORMULA_MARGIN_PX = 1200;

const nextFrame = callback => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16);
const cancelFrame = id => typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id);

/**
 * A queue of formulas to draw: `add(key, draw)` calls `draw()` in a later frame, `perFrame` of them a frame, the first ones added first, or the
 * first ones `order(keys)` puts first (it is called with the keys waiting, once a frame). `add` returns the function that takes the key out again.
 * A drawing that throws is reported and the rest are drawn in the next frames.
 */
export function createFormulaQueue({ perFrame = FORMULAS_PER_FRAME, order } = {}) {
  const waiting = new Map();
  let frame = null;
  const drawSome = () => {
    frame = null;
    try {
      const keys = [...waiting.keys()];
      for (const key of (order ? order(keys) : keys).slice(0, perFrame)) {
        const draw = waiting.get(key);
        waiting.delete(key);
        draw?.();
      }
    } finally {
      if (waiting.size && frame === null) frame = nextFrame(drawSome);
    }
  };
  const remove = key => {
    waiting.delete(key);
    if (!waiting.size && frame !== null) { cancelFrame(frame); frame = null; }
  };
  return {
    add(key, draw) {
      waiting.set(key, draw);
      if (frame === null) frame = nextFrame(drawSome);
      return () => remove(key);
    },
    remove,
    get size() { return waiting.size; },
    clear() { waiting.clear(); if (frame !== null) cancelFrame(frame); frame = null; },
  };
}

/** Where each waiting formula is on the screen now, without measuring it: its top when it came near, moved by how far its area scrolled since. */
const topNow = new Map();
const fromMiddle = element => Math.abs((topNow.get(element)?.() ?? Infinity) - (globalThis.innerHeight || 0) / 2);
const nearestFirst = elements => elements.map(element => [element, fromMiddle(element)]).sort((a, b) => a[1] - b[1]).map(([element]) => element);

/** The one queue of the page. */
const formulas = createFormulaQueue({ order: nearestFirst });

/**
 * A watch over the formulas of one scroll area (`rootOf()`, read when the first element is observed; null: the window): `observe(element, draw)`
 * calls `draw()` once: at once when the element is on the visible part of the area, and when it is within `margin` of it, through the page's
 * queue. One that leaves that band before its turn waits again. It returns the function that stops watching. Without IntersectionObserver
 * every formula is drawn at once.
 */
export function createFormulaWatch(rootOf, { margin = FORMULA_MARGIN_PX } = {}) {
  let near = null, onScreen = null;
  const draws = new Map();
  let root = null;
  const scrolled = () => root ? root.scrollTop : (globalThis.scrollY || 0);
  const wait = (element, top) => {
    const at = scrolled();
    topNow.set(element, () => top - (scrolled() - at));
    formulas.add(element, () => show(element));
  };
  const stopWaiting = element => { topNow.delete(element); formulas.remove(element); };
  const forget = element => { draws.delete(element); stopWaiting(element); near?.unobserve(element); onScreen?.unobserve(element); };
  const show = element => { const draw = draws.get(element); forget(element); draw?.(); };
  const ensure = () => {
    if (near || typeof IntersectionObserver === 'undefined') return near;
    root = rootOf() || null;
    // Over the window, the band also reaches past the edges of the scroll areas in it (a long note in a scrolling panel) where scrollMargin is
    // supported. Not for a scroll area's own watch: there it widens the band itself (40 formulas drawn ahead became 70).
    near = new IntersectionObserver(entries => {
      for (const { target, isIntersecting, boundingClientRect } of entries) {
        if (!draws.has(target)) continue;
        if (isIntersecting) wait(target, boundingClientRect.top); else stopWaiting(target);
      }
    }, { root, rootMargin: `${margin}px 0px`, ...(root ? {} : { scrollMargin: `${margin}px 0px` }) });
    onScreen = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) if (isIntersecting && draws.has(target)) show(target);
    }, { root });
    return near;
  };
  return {
    observe(element, draw) {
      if (!ensure()) { draw(); return () => {}; }
      draws.set(element, draw); near.observe(element); onScreen.observe(element);
      return () => forget(element);
    },
    disconnect() {
      for (const element of draws.keys()) stopWaiting(element);
      near?.disconnect(); onScreen?.disconnect(); near = onScreen = null;
      draws.clear();
    },
  };
}
