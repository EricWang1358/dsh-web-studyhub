import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createEdgeTracker, scrollEdgesX } from './scroll-edges.js';
import { useComponentCss } from './css.js';
import fadeCss from './scroll-fade.css';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const NO_EDGES = { start: false, end: false };

/**
 * A strip that scrolls sideways tells its two edges which side still has content; ui/components/scroll-fade.css fades that side, and only that side.
 * Returns [ref, edges, measure]: put the ref on the scroller, pass the edges as `data-fade-start` / `data-fade-end` (undefined when false, so the attribute
 * is absent) and `onScroll={measure}`. The hook reads on mount, after every commit (a new tab, another column), on scroll and on a resize of the strip or
 * its first child, and publishes only when an edge really changed (the ScrollWindow lesson: React 18 loops on an unchanged setState, error #185).
 * `measure` is also there for code that scrolls the strip itself.
 */
export function useScrollEdges() {
  // The hook brings its own stylesheet, so every strip that uses it is painted without a second import at each call site.
  useComponentCss(fadeCss, 'study-scroll-fade');
  const node = useRef(null);
  const [edges, setEdges] = useState(NO_EDGES);
  const tracker = useRef(null);
  tracker.current ??= createEdgeTracker(scrollEdgesX, setEdges, NO_EDGES);
  const measure = useCallback(() => { if (node.current) tracker.current(node.current); }, []);
  const observer = useRef(null);
  // A callback ref: a strip that folds away and comes back is measured and watched again (an effect with a stable measure would watch the old node).
  const ref = useCallback((element) => {
    node.current = element;
    observer.current?.disconnect();
    observer.current = null;
    if (!element || typeof ResizeObserver === 'undefined') return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
    if (element.firstElementChild) observer.current.observe(element.firstElementChild);
  }, [measure]);
  useIsoLayoutEffect(() => { measure(); });
  return [ref, edges, measure];
}
