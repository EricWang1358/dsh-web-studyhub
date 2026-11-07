/* The two questions a scroller's edges ask, and the one that publishes the answer only when it changes.
   Vertical (ScrollWindow's soft fades) and horizontal (a strip of tabs, columns or filters: ui/components/use-scroll-edges.js and scroll-fade.css). Pure,
   no React: the pages that draw a fade, a test and the scroll window all read the same rule. */

/** Is there more content above / below the viewport's visible part? */
export const scrollEdges = element => ({
  top: element.scrollTop > 1,
  bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
});

/** The same for a horizontal strip: more content to the start (left) or the end (right). */
export const scrollEdgesX = element => ({
  start: element.scrollLeft > 1,
  end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
});

/**
 * `measure(element)` for any pair of edges: read it with `read`, publish it only when a value really changed. It may run after every commit, so it must not
 * publish an unchanged value: React 18 does not bail out of those at once and an effect re-renders itself until it throws "Maximum update depth exceeded"
 * (React error #185, once a list overflows).
 */
export function createEdgeTracker(read, publish, initial) {
  let last = initial;
  return element => {
    const next = read(element);
    if (Object.keys(next).every(key => next[key] === last[key])) return;
    last = next;
    publish(next);
  };
}

/** `edgeTracker` for the vertical window: `{ top, bottom }`, published only when one changed. */
export const edgeTracker = (publish, initial = { top: false, bottom: false }) => createEdgeTracker(scrollEdges, publish, initial);
