/* Formulas not on screen yet are drawn a few per frame, not all in one task (gate review of #996). A KaTeX drawing is 70–210 elements, each styled
   and laid out by the browser: a display formula costs about 6 ms, so the 40 formulas a chapter draws ahead of the screen when it opens were one
   250 ms task, where two a frame stay far under the 50 ms a frame may take. Formulas on screen are drawn at once by their callers. */

/** How many formulas off screen are drawn per frame. */
export const FORMULAS_PER_FRAME = 2;

const nextFrame = callback => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16);
const cancelFrame = id => typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id);

/**
 * A queue of formulas to draw: `add(key, draw)` calls `draw()` in a later frame, `perFrame` of them a frame, the first ones added first, or the
 * first ones `order(keys)` puts first (it is called with the keys waiting, once a frame). `add` returns the function that takes the key out again.
 */
export function createFormulaQueue({ perFrame = FORMULAS_PER_FRAME, order } = {}) {
  const waiting = new Map();
  let frame = null;
  const drawSome = () => {
    frame = null;
    const keys = [...waiting.keys()];
    for (const key of (order ? order(keys) : keys).slice(0, perFrame)) {
      const draw = waiting.get(key);
      waiting.delete(key);
      draw?.();
    }
    if (waiting.size) frame = nextFrame(drawSome);
  };
  const remove = key => { waiting.delete(key); };
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
