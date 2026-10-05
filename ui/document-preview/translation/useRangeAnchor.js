import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { placeInHost } from '../../components/use-dismiss.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Keep an element that floats at the end of a selection (the 译 chip, the 原文 view's translation card) next to it. It is the shared anchoring
 * (placeInHost, the Menu's measuring) and not a sum of its own: the element is absolute inside `host` (the reading page), measured from the
 * host's content origin through the interface zoom, kept inside the visible reading area (`scrollerRef`) and moved again on every scroll and resize,
 * with style writes and no state. The element is hidden until it has a place (`data-placed`) and, when `hideAway`, while the selection is out of
 * sight (`data-away`), so it never shows over other text. `rangeRef.current` is a live Range; its last rectangle is where the selection ends.
 * Returns `place()` for callers that learn of a new range.
 */
export default function useRangeAnchor({ elementRef, host, rangeRef, scrollerRef, active, trigger, placement = 'top-end', gap = 2, margin = 4, flip = true, hideAway = false }) {
  const latest = useRef({});
  latest.current = { host, placement, gap, margin, flip, hideAway };
  const place = useCallback(() => {
    const element = elementRef.current, range = rangeRef.current, { host: page, placement: side, gap: space, margin: edge, flip: flips, hideAway: hide } = latest.current;
    if (!element || !range || !page) return;
    const rects = range.getClientRects(), last = rects[rects.length - 1];
    const area = scrollerRef?.current?.getBoundingClientRect();
    if (!last) { element.dataset.away = 'true'; return; }
    if (hide && area && (last.bottom < area.top || last.top > area.bottom)) { element.dataset.away = 'true'; return; }
    const result = placeInHost({ element, host: page, rect: last, placement: side, gap: space, margin: edge, flip: flips, bounds: area ? { left: area.left, top: area.top, right: area.right, bottom: area.bottom } : undefined });
    element.style.left = `${Math.round(result.left)}px`;
    element.style.top = `${Math.round(result.top)}px`;
    delete element.dataset.away;
    element.dataset.placed = 'true';
  }, [elementRef, rangeRef, scrollerRef]);
  // Placed before the browser paints, so it is never seen at its unplaced origin.
  useIsoLayoutEffect(() => { if (active) place(); }, [active, trigger, host, place]);
  useEffect(() => {
    if (!active) return undefined;
    const scroller = scrollerRef?.current;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); };
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' || !host ? null : new ResizeObserver(schedule);
    observer?.observe(host);
    return () => { scroller?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); observer?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [active, host, scrollerRef, place]);
  return place;
}
