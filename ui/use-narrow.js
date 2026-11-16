import { useEffect, useLayoutEffect, useState } from 'react';

/* One width rule for the reading surfaces: below NARROW px of their own width (the reader's viewer, the review book's page), the side panels (目录, 学习)
   slide over the text with a scrim instead of sitting beside it. Mirrored in ui/document-preview/reader/reader.css and ui/book/book-toc.css. */
export const NARROW = 900;

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Whether the element of `ref` is narrower than `width` (NARROW by default), measured before the first paint and again when it is resized (state is set only when it changes).
 * `content: true` measures its content box (no padding), the width a container query on that element sees.
 */
export function useNarrow(ref, width = NARROW, { content = false } = {}) {
  const [narrow, setNarrow] = useState(false);
  useIsoLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let last = null;
    const inner = () => {
      if (!content) return element.clientWidth;
      const style = getComputedStyle(element);
      return element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    };
    const measure = () => { const next = inner() < width; if (next !== last) { last = next; setNarrow(next); } };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, content]);
  return narrow;
}
