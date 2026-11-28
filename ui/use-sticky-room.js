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

/** A bar sticks only while it leaves the box it scrolls in this much to what scrolls behind it; a taller one stays where it is in the page. */
export const STICK_SHARE = 0.5;

/**
 * Marks a bar kept at the bottom of the box it scrolls in (position: sticky) with `data-stuck` while it sits on that box's bottom edge over what scrolls
 * behind it, so it is opaque only then: where everything fits, it sits where it always sat and paints nothing. A sticky bar stops at the box's padding,
 * so the box's bottom padding goes to `--sticky-under` on the bar, for it to sit on the very edge (else the content shows in that strip). One
 * IntersectionObserver per bar, so every engine draws it the same (scroll-state container queries are Chromium-only, #1678).
 * Where the part that must stay in reach (`core`, a selector inside the bar; the whole bar without one) is taller than STICK_SHARE of the box (the full
 * grade row stacked in the reader's narrow panel), the bar gets `data-in-flow` instead, and the question area around it `data-grades-in-flow`: stuck,
 * it would cover most of what it is about. What comes and goes above that part (a spoken answer's words) does not change the choice.
 */
export function useStuckMark(core) {
  const stop = useRef(null);
  return useCallback((element) => {
    stop.current?.();
    stop.current = null;
    // Without an observer nothing can say when it is stuck: the bar then keeps its plain sticky place (bottom: 0) and look.
    if (!element || typeof IntersectionObserver === "undefined") return;
    let scroller = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const under = scroller ? getComputedStyle(scroller).paddingBottom : "0px";
    element.style.setProperty("--sticky-under", under);
    const area = element.closest(".question-area");
    // Measured without the room the bar keeps under its buttons while stuck, so that room cannot tip it back and forth across the line.
    const sizes = scroller && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      const part = core ? element.querySelector(core) : null;
      const own = part ? part.offsetHeight : element.offsetHeight - (element.hasAttribute("data-stuck") ? parseFloat(under) || 0 : 0);
      const large = scroller.clientHeight > 0 && own > scroller.clientHeight * STICK_SHARE;
      if (large === element.hasAttribute("data-in-flow")) return;
      element.toggleAttribute("data-in-flow", large);
      area?.toggleAttribute("data-grades-in-flow", large);
      // A bar in the page is never stuck. Either way its place changed: look again, so data-stuck says where it is now.
      element.removeAttribute("data-stuck");
      observer.unobserve(element);
      observer.observe(element);
    }) : null;
    sizes?.observe(element);
    if (scroller) sizes?.observe(scroller);
    // Stuck: it reaches the box's bottom edge (the box is cut 1 px short, so a bar on the edge is not wholly inside it), not cut off at the top.
    const observer = new IntersectionObserver(([entry]) => {
      element.toggleAttribute("data-stuck", !element.hasAttribute("data-in-flow") && entry.isIntersecting && !!entry.rootBounds && entry.boundingClientRect.bottom > entry.rootBounds.bottom);
    }, { root: scroller, rootMargin: "0px 0px -1px 0px", threshold: [0, 1] });
    observer.observe(element);
    stop.current = () => {
      observer.disconnect();
      sizes?.disconnect();
      element.removeAttribute("data-stuck");
      element.removeAttribute("data-in-flow");
      area?.removeAttribute("data-grades-in-flow");
      element.style.removeProperty("--sticky-under");
    };
  }, [core]);
}
