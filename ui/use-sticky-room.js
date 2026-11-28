import { useCallback, useRef } from "react";

/** A bottom bar can wrap when its controls or the viewport change. Expose its current height on the ancestor that owns focus clearance. */
export function useStickyRoom(variable, owner = ".study-app, .study-seat") {
  const stop = useRef(null);
  return useCallback((element) => {
    stop.current?.();
    stop.current = null;
    const box = element?.closest(owner);
    if (!box) return;
    const measure = () => { const next = `${Math.ceil(element.offsetHeight)}px`; if (box.style.getPropertyValue(variable) !== next) box.style.setProperty(variable, next); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    stop.current = () => { observer?.disconnect(); box.style.removeProperty(variable); };
  }, [variable, owner]);
}

/**
 * Marks a bar kept at the bottom of the box it scrolls in (position: sticky) with `data-stuck` while it sits on that box's bottom edge over what scrolls
 * behind it, so it is opaque only then: where everything fits, it sits where it always sat and paints nothing. A sticky bar stops at the box's padding,
 * so the box's bottom padding goes to `--sticky-under` on the bar, for it to sit on the very edge (else the content shows in that strip). One
 * IntersectionObserver per bar, so every engine draws it the same (scroll-state container queries are Chromium-only, #1678).
 */
export function useStuckMark() {
  const stop = useRef(null);
  return useCallback((element) => {
    stop.current?.();
    stop.current = null;
    // Without an observer nothing can say when it is stuck: the bar then keeps its plain sticky place (bottom: 0) and look.
    if (!element || typeof IntersectionObserver === "undefined") return;
    let scroller = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    element.style.setProperty("--sticky-under", scroller ? getComputedStyle(scroller).paddingBottom : "0px");
    // Stuck: it reaches the box's bottom edge (the box is cut 1 px short, so a bar on the edge is not wholly inside it), not cut off at the top.
    const observer = new IntersectionObserver(([entry]) => {
      element.toggleAttribute("data-stuck", entry.isIntersecting && !!entry.rootBounds && entry.boundingClientRect.bottom > entry.rootBounds.bottom);
    }, { root: scroller, rootMargin: "0px 0px -1px 0px", threshold: [0, 1] });
    observer.observe(element);
    stop.current = () => { observer.disconnect(); element.removeAttribute("data-stuck"); element.style.removeProperty("--sticky-under"); };
  }, []);
}
