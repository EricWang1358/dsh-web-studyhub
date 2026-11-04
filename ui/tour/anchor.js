/* Finding a `data-tour` anchor on the page: what the feature tour (ui/tour/Tour.jsx) and the feature finder (ui/finder/) both do. One place, so "an anchor is
   there" means the same thing to both: it is in the document, has a size, and a closed <details> around it counts as a place to open, not as absent. */

/** How long a page may take to draw an anchor after it was switched to (the lazy panes of Settings, a page that loads its data first). */
export const ANCHOR_WAIT_MS = 4000;

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

/** The closed <details> that hold `element`, innermost first. */
export function closedFolds(element) {
  const folds = [];
  for (let node = element?.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS' && !node.open) folds.push(node);
  return folds;
}

/**
 * The first of `anchors` the learner can be shown, with its index: `{ element, index, opened }`, or null. An anchor inside a closed <details> is shown by
 * opening the folds around it (the page's own toggle handler hears it, as it would a click); an anchor that is a closed <details> itself is opened too,
 * because the control it stands for is inside. `opened` says a fold was opened, so the caller lets it finish drawing. A closed fold is no measure of
 * absence: the shared Disclosure keeps its content laid out inside a clipped box of no height, so an element in it still has a size. One that has none
 * (hidden by its page) is skipped for the next.
 */
export function locateAnchor(root, anchors) {
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
