/* Finding a `data-tour` anchor on the page: what the feature tour (ui/tour/Tour.jsx) and the feature finder (ui/finder/) both do. One place, so "an anchor is
   there" means the same thing to both: it is in the document, has a size, and a closed <details> around it counts as a place to open, not as absent. */

/** How long a page may take to draw an anchor after it was switched to (the lazy panes of Settings, a page that loads its data first). */
export const ANCHOR_WAIT_MS = 4000;

/** The event that asks the lists which draw their rows in chunks (ui/components/ScrollWindow.jsx ChunkedRows) to draw the row that holds one of `detail.anchors`. */
export const REVEAL_ANCHORS_EVENT = 'study-reveal-anchors';

/** Before looking: an anchor that is not in the document may be on a row a list has not drawn yet. The lists that hold such a row draw it before this returns. */
function askForRows(root, anchors) {
  const missing = anchors.filter((anchor) => !root.querySelector(`[data-tour="${anchor}"]`));
  if (missing.length && typeof root.dispatchEvent === 'function') root.dispatchEvent(new CustomEvent(REVEAL_ANCHORS_EVENT, { bubbles: true, composed: true, detail: { anchors: missing } }));
}

const hasSize = (element) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
};

/** The anchor element of a step inside the study app, once it is rendered with a size. */
export function findAnchor(root, anchors) {
  for (const anchor of anchors) {
    const element = root?.querySelector(`[data-tour="${anchor}"]`);
    if (element?.isConnected && hasSize(element)) return element;
  }
  return null;
}

/** The closed <details> that hold `element` behind a closed fold, innermost first; a <details> whose <summary> holds `element` already shows it while closed. */
export function closedFolds(element) {
  const folds = [];
  for (let child = element, node = element?.parentElement; node; child = node, node = node.parentElement) {
    if (node.tagName === 'DETAILS' && !node.open && child.tagName !== 'SUMMARY') folds.push(node);
  }
  return folds;
}

const SETTLE_FRAMES = 3, MAX_SETTLE_STEPS = 20, DRIFT_PX = 4;
const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'];

/**
 * Scroll `element` into view without animation (`behavior: 'auto'`), then verify after layout settles that an open `ChunkedRows` list right above it did not
 * append a chunk and push `element` away (#930). Stops as soon as `element` stays where it landed, when cancelled/aborted, on manual user input, or at `MAX_SETTLE_STEPS`.
 */
export function scrollToAnchor(element, options = {}, aborted = null) {
  const spec = { ...options, behavior: 'auto' };
  if (!element || typeof element.scrollIntoView !== 'function') {
    const noop = Promise.resolve();
    noop.cancel = () => {};
    return noop;
  }
  element.scrollIntoView(spec);
  let placedTop = element.getBoundingClientRect?.().top;
  if (typeof requestAnimationFrame !== 'function' || typeof placedTop !== 'number') {
    const done = Promise.resolve();
    done.cancel = () => {};
    return done;
  }
  let stopped = false, rafId = 0, steps = 0;
  const stop = () => { stopped = true; };
  const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
  const cleanup = () => {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (doc) for (const type of USER_INPUT_EVENTS) doc.removeEventListener(type, stop, true);
  };
  if (doc) for (const type of USER_INPUT_EVENTS) doc.addEventListener(type, stop, { capture: true, passive: true });
  const promise = new Promise((resolve) => {
    const finish = () => { cleanup(); resolve(); };
    const waitFrames = (left) => {
      if (stopped || aborted?.() || element.isConnected === false) { finish(); return; }
      if (left > 0) {
        rafId = requestAnimationFrame(() => waitFrames(left - 1));
        return;
      }
      const nowTop = element.getBoundingClientRect?.().top;
      if (typeof nowTop !== 'number' || Math.abs(nowTop - placedTop) <= DRIFT_PX || steps >= MAX_SETTLE_STEPS) {
        finish();
        return;
      }
      steps += 1;
      element.scrollIntoView(spec);
      placedTop = element.getBoundingClientRect?.().top ?? nowTop;
      waitFrames(SETTLE_FRAMES);
    };
    waitFrames(SETTLE_FRAMES);
  });
  promise.cancel = () => { stop(); cleanup(); };
  return promise;
}

/**
 * The first of `anchors` the learner can be shown, with its index: `{ element, index, opened }`, or null. An anchor inside a closed <details> is shown by
 * opening the folds around it (the page's own toggle handler hears it, as it would a click); an anchor that is a closed <details> itself is opened too,
 * because the control it stands for is inside. `opened` says a fold was opened, so the caller lets it finish drawing. A closed fold is no measure of
 * absence: the shared Disclosure keeps its content laid out inside a clipped box of no height, so an element in it still has a size. One that has none
 * (hidden by its page) is skipped for the next. An anchor that is not there yet may sit on a row of a long list that is drawn in chunks: the list is asked to draw it first.
 */
export function locateAnchor(root, anchors) {
  if (root) askForRows(root, anchors);
  for (let index = 0; index < anchors.length; index += 1) {
    const element = root?.querySelector(`[data-tour="${anchors[index]}"]`);
    if (!element?.isConnected) continue;
    const folds = closedFolds(element);
    if (element.tagName === 'DETAILS' && !element.open) folds.unshift(element);
    if (!hasSize(element) && !folds.length) continue;
    for (const fold of folds.reverse()) fold.open = true;
    if (!hasSize(element)) continue;
    return { element, index, opened: folds.length > 0 };
  }
  return null;
}
