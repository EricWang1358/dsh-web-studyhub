import { useEffect, useRef, useState } from 'react';

/* Every element asked about shares ONE ResizeObserver. Its callback runs after layout, once a frame, for all of them together, so a page of rows
   (资料 with hundreds of materials) measures in one batch after the rows are drawn, and never draws a row twice before the first paint: the answer
   only decides whether a hover card has words, which nobody sees until they point at it (4.11.2: a layout effect, a state for the element and an
   observer per row made the switch to 资料 slow). */
const watched = new Map();
let shared = null;
function watchSize(element, measure) {
  if (typeof ResizeObserver === 'undefined') { measure(); return () => {}; }
  shared ||= new ResizeObserver(entries => { for (const entry of entries) watched.get(entry.target)?.(); });
  watched.set(element, measure);
  shared.observe(element);
  return () => { if (watched.get(element) === measure) { watched.delete(element); shared.unobserve(element); } };
}

/** A line of text is cut where its words are wider than its box by more than a rounding. */
const textCut = element => element.scrollWidth > element.clientWidth + 1;

/** Is the text of this element cut by its width (one line, ellipsis)? Measured when the element is first observed, when it is resized, when `text` changes,
 *  and when the element itself is replaced (a row that leaves and comes back from its rename field draws a new one). `isCut` measures it where the default
 *  rounding does not fit (a line of whole boxes, which loses a box to its 「…」 by a pixel's overflow). */
export function useCut(ref, text, isCut = textCut) {
  const [cut, setCut] = useState(false);
  const seen = useRef({ element: null, text: undefined, stop: null });
  // After every commit, on purpose (no dependency list): the element is compared by hand, so a replaced element is seen, and nothing else runs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const now = seen.current, element = ref.current;
    if (element === now.element && text === now.text) return;
    now.stop?.();
    Object.assign(now, { element, text, stop: null });
    if (!element) { setCut(false); return; }
    now.stop = watchSize(element, () => setCut(isCut(element)));
  });
  useEffect(() => () => seen.current.stop?.(), []);
  return cut;
}
