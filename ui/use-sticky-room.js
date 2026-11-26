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
