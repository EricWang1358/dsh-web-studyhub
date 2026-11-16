import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Whether the full set of a header's actions fits on its title row (#1083): decided by the words in this language, not by a width written down for one of them.
 * The row is `selector` inside `ref` (the title row of ui/components/PageHeader.jsx with `actionsOnTitleRow`): the title and the actions, which do not wrap or shrink
 * there (the page's CSS says so).
 * The full set is drawn first; when the title, the gap and the actions are wider than the row, the answer turns false and the page draws its compact set,
 * remembering the width the full one needed; it tries the full set again when the row is that wide, or when `key` (the full set's labels) changes.
 * Measured before the paint (a layout effect), so the set that does not fit is never shown.
 */
export function useRowFit(ref, selector, key = '') {
  const [fits, setFits] = useState(true);
  const need = useRef(0);
  const shown = useRef(true);
  shown.current = fits;
  useIsoLayoutEffect(() => {
    need.current = 0;
    setFits(true);
  }, [key]);
  useIsoLayoutEffect(() => {
    const row = ref.current?.querySelector(selector);
    if (!row) return undefined;
    const check = () => {
      const width = row.clientWidth;
      if (!shown.current) { if (need.current && width >= need.current) setFits(true); return; }
      const parts = [...row.children];
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const wanted = parts.reduce((sum, part) => sum + part.getBoundingClientRect().width, 0) + gap * Math.max(0, parts.length - 1);
      if (wanted > width + 0.5) { need.current = Math.ceil(wanted); setFits(false); }
    };
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(row);
    for (const part of row.children) observer.observe(part);
    return () => observer.disconnect();
  }, [ref, selector, fits, key]);
  return fits;
}
