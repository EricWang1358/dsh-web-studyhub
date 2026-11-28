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

/** The box of what a learner reads in `block`: an empty state is stretched over the page, so its drawn parts together; a wrapper that opens with a card
    (a list under its summary card) is that first card. */
function readBox(block, shown) {
  const parts = [...block.children].filter(shown);
  if (block.classList.contains('sh-empty') && parts.length) {
    const boxes = parts.map((part) => part.getBoundingClientRect());
    const left = Math.min(...boxes.map((box) => box.left)), top = Math.min(...boxes.map((box) => box.top));
    return { left, top, width: Math.max(...boxes.map((box) => box.right)) - left, height: Math.max(...boxes.map((box) => box.bottom)) - top };
  }
  return (/^(SECTION|ARTICLE)$/.test(parts[0]?.tagName) ? parts[0] : block).getBoundingClientRect();
}

/** What introduces the page on screen inside `scope` (its <main>, or the dialog on top): the heading as it is read (the text's own box, not the stretched
    element) and the first block after the page header. Either is null where there is none. The tour keeps its card off them (ui/tour/geometry.js). */
export function pageLead(scope) {
  const shown = (element) => hasSize(element) && !element.closest('.tour-layer') && !element.classList.contains('sh-visually-hidden');
  const heading = [...(scope?.querySelectorAll('h1, h2') || [])].find(shown);
  if (!heading) return { title: null, block: null };
  const range = heading.ownerDocument.createRange();
  range.selectNodeContents(heading);
  const text = range.getBoundingClientRect();
  let block = null;
  for (let node = heading.closest('.sh-page-header') || heading; node && node !== scope && !block; node = node.parentElement) {
    for (let next = node.nextElementSibling; next && !block; next = next.nextElementSibling) if (shown(next) && next.getBoundingClientRect().height > 8) block = next;
  }
  return { title: text.width && text.height ? text : heading.getBoundingClientRect(), block: block ? readBox(block, shown) : null };
}

/** Is `element`, or something around it, held at an edge of the view (position fixed or sticky), so scrolling the page does not move it away from there? */
export function isPinned(element) {
  if (typeof getComputedStyle !== 'function') return false;
  for (let node = element; node && node !== node.ownerDocument.body; node = node.parentElement) {
    const { position } = getComputedStyle(node);
    if (position === 'fixed' || position === 'sticky') return true;
  }
  return false;
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
 * (hidden by its page) is skipped for the next. `openSelf` false opens only the folds around an anchor: the tour lights a closed
 * <details> (a question's row) as it stands. An anchor that is not there yet may sit on a row of a long list that is drawn in chunks: the list is asked to draw it first.
 */
export function locateAnchor(root, anchors, { openSelf = true } = {}) {
  if (root) askForRows(root, anchors);
  for (let index = 0; index < anchors.length; index += 1) {
    const element = root?.querySelector(`[data-tour="${anchors[index]}"]`);
    if (!element?.isConnected) continue;
    const folds = closedFolds(element);
    if (openSelf && element.tagName === 'DETAILS' && !element.open) folds.unshift(element);
    if (!hasSize(element) && !folds.length) continue;
    for (const fold of folds.reverse()) fold.open = true;
    if (!hasSize(element)) continue;
    return { element, index, opened: folds.length > 0 };
  }
  return null;
}
