import { useCallback, useRef } from "react";

/** A bar that sticks to the bottom of the page's scrolling box (.study-app) covers what scrolls under it, so a focus or a jump must stop above it. This keeps
 *  `variable` on that box at the bar's real height (a stylesheet turns it into scroll-padding-bottom), from the bar's first paint while it is shown, and takes
 *  it off when the bar goes. Returns the callback ref for the bar. */
export function useStickyRoom(variable) {
  const stop = useRef(null);
  return useCallback((element) => {
    stop.current?.();
    stop.current = null;
    const box = element?.closest(".study-app, .study-seat");
    if (!box) return;
    const measure = () => { const next = `${Math.ceil(element.offsetHeight)}px`; if (box.style.getPropertyValue(variable) !== next) box.style.setProperty(variable, next); };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    stop.current = () => { observer?.disconnect(); box.style.removeProperty(variable); };
  }, [variable]);
}
