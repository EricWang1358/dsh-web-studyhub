import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { placeInHost } from '../../components/use-dismiss.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Keep an element that floats at the end of a selection (the 译 chip, the 原文 view's translation card) next to it. It is the shared anchoring
 * (placeInHost, the Menu's measuring) and not a sum of its own: the element is absolute inside `host` (the reading page), measured from the
 * host's content origin through the interface zoom, kept inside the visible reading area (`scrollerRef`) and moved again on every scroll and resize,
 * with style writes and no state. The element is hidden until it has a place (`data-placed`) and, when `hideAway`, while the selection is out of
 * sight (`data-away`), so it never shows over other text. `rangeRef.current` is a live Range; its last rectangle is where the selection ends.
 * While a press is on the element it is not moved (a move between pressing one of its buttons and letting go would lose that click); it moves once the press ends.
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
    // `pressed`: the pointer whose main-button press is on the element (null: none). Whatever moved meanwhile is placed once it lets go.
    let frame = 0, pressed = null, held = false;
    const schedule = () => {
      if (pressed !== null) { held = true; return; }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); });
    };
    const press = (event) => {
      if (event.button !== 0 || !elementRef.current?.contains(event.target)) return;
      pressed = event.pointerId;
      if (frame) { cancelAnimationFrame(frame); frame = 0; held = true; }
    };
    // The click follows the release in the same task; the move waits for the next frame, after it. A press that never sees its pointerup (the window
    // loses focus, a context menu takes the release) ends too, so the element is never left frozen.
    const end = () => { if (pressed === null) return; pressed = null; if (held) { held = false; schedule(); } };
    const release = (event) => { if (event.pointerId === pressed) end(); };
    // Only the window's own blur: the focus leaving the box for the pressed button is part of the press.
    const away = (event) => { if (event.target === window) end(); };
    const listeners = [[document, 'pointerdown', press], [window, 'pointerup', release], [window, 'pointercancel', release],
      [window, 'lostpointercapture', release], [window, 'contextmenu', end], [window, 'blur', away]];
    scroller?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    for (const [target, type, listener] of listeners) target.addEventListener(type, listener, true);
    const observer = typeof ResizeObserver === 'undefined' || !host ? null : new ResizeObserver(schedule);
    observer?.observe(host);
    return () => {
      scroller?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener, true);
      observer?.disconnect(); if (frame) cancelAnimationFrame(frame);
    };
  }, [active, host, scrollerRef, place, elementRef]);
  return place;
}
