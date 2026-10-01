import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/* The order of the sidebar's pages, set by holding an item with the left button and dragging it.

   Items are reordered inside their own group (study pages, upkeep pages) so the divider between the groups stays where
   it is. The order is a per-viewer convenience kept in localStorage; pages added later go last in their group and pages
   that no longer exist are forgotten. Alt+Up / Alt+Down move the focused item for keyboard users. */

const KEY = "study-nav-order";
/** The sidebar's default order (P11): the daily study loop first, upkeep tools after it. */
export const NAV_DEFAULTS = Object.freeze({
  main: ["library", "sources", "generate", "wrongbook", "exam", "dashboard"],
  upkeep: ["workflows", "skeleton", "notes", "audio", "live", "board"],
});
const HOLD_MS = 350; // the item lifts only after this long, so an ordinary click or a slip never reorders
const SLOP = 6; // moving further than this before the hold ends means the press was something else

const read = () => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
};
const write = (value) => {
  try { if (value) localStorage.setItem(KEY, JSON.stringify(value)); else localStorage.removeItem(KEY); } catch { /* the order still applies this session */ }
};

/** A saved order applied to the pages that exist now. */
export function mergeOrder(saved, defaults) {
  const merged = {};
  for (const [group, ids] of Object.entries(defaults)) {
    const kept = (Array.isArray(saved?.[group]) ? saved[group] : []).filter((id, index, all) => ids.includes(id) && all.indexOf(id) === index);
    merged[group] = [...kept, ...ids.filter((id) => !kept.includes(id))];
  }
  return merged;
}
export const sameOrder = (a, b) => Object.keys(a).every((group) => a[group].length === b[group]?.length && a[group].every((id, index) => id === b[group][index]));
export const groupOf = (order, id) => Object.keys(order).find((group) => order[group].includes(id));
/** `id` moved to `index` among the other items of its group. */
export function placeAt(order, id, index) {
  const group = groupOf(order, id);
  if (!group) return order;
  const rest = order[group].filter((item) => item !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return { ...order, [group]: rest };
}

/**
 * @param defaults  { group: [id, …] } in the original order
 * @param navRef    the element holding the items; each carries data-nav-id
 * @returns order, lifted (the id being dragged), announce ({ id, position, count } after a move), customized, reset(),
 *          and bind(id): the props to spread on an item
 */
export function useNavOrder(defaults, navRef) {
  const [order, setOrder] = useState(() => mergeOrder(read(), defaults));
  const [lifted, setLifted] = useState(null);
  const [announce, setAnnounce] = useState(null);
  const latest = useRef(order);
  latest.current = order;
  const press = useRef(null);
  const quiet = useRef(false); // the click that ends a drag must not open the page
  const refocus = useRef(null);
  const customized = !sameOrder(order, defaults);
  useEffect(() => { write(customized ? order : null); }, [order, customized]);

  const node = (id) => navRef.current?.querySelector(`[data-nav-id="${id}"]`);
  const change = (next) => { latest.current = next; setOrder(next); };
  /** Keep the lifted item under the pointer, wherever the list has moved around it. */
  const follow = (state) => {
    const natural = state.el.getBoundingClientRect().top - state.dy;
    state.dy = state.y - state.grab - natural;
    state.el.style.transform = `translateY(${state.dy}px)`;
  };
  /** Where the lifted item now sits among the others of its group. */
  const settle = (state) => {
    const order = latest.current, box = state.el.getBoundingClientRect(), middle = box.top + box.height / 2;
    const others = order[groupOf(order, state.id)].filter((id) => id !== state.id);
    let index = others.findIndex((id) => { const rect = node(id)?.getBoundingClientRect(); return rect && middle < rect.top + rect.height / 2; });
    if (index < 0) index = others.length;
    const next = placeAt(order, state.id, index);
    if (!sameOrder(next, order)) change(next);
  };
  const finish = (state, { cancel = false } = {}) => {
    clearTimeout(state.timer);
    for (const [type, handler] of state.listeners) window.removeEventListener(type, handler);
    press.current = null;
    if (!state.active) return;
    state.el.style.transform = "";
    if (cancel) change(state.before);
    else {
      const group = groupOf(latest.current, state.id);
      setAnnounce({ id: state.id, position: latest.current[group].indexOf(state.id) + 1, count: latest.current[group].length });
    }
    setLifted(null);
    quiet.current = true;
    setTimeout(() => { quiet.current = false; }, 0);
  };
  // follow, node and finish read only refs and state setters, so the latest render's copies are always equivalent.
  /* eslint-disable react-hooks/exhaustive-deps */
  useLayoutEffect(() => {
    if (press.current?.active) follow(press.current);
    if (refocus.current) { node(refocus.current)?.focus(); refocus.current = null; }
  }, [order]);
  useEffect(() => () => { if (press.current) finish(press.current, { cancel: true }); }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  const bind = (id) => ({
    "data-nav-id": id,
    onPointerDown(event) {
      if (event.button !== 0 || event.pointerType === "touch" || press.current) return;
      const state = { id, el: event.currentTarget, pointerId: event.pointerId, x0: event.clientX, y0: event.clientY, y: event.clientY, active: false, dy: 0, grab: 0 };
      const mine = (handler) => (e) => { if (e.pointerId === state.pointerId) handler(e); };
      state.listeners = [
        ["pointermove", mine((e) => {
          state.y = e.clientY;
          if (!state.active) { if (Math.hypot(e.clientX - state.x0, e.clientY - state.y0) > SLOP) finish(state); return; }
          follow(state);
          settle(state);
        })],
        ["pointerup", mine(() => finish(state))],
        ["pointercancel", mine(() => finish(state, { cancel: true }))],
        ["keydown", (e) => { if (e.key === "Escape" && state.active) { e.preventDefault(); finish(state, { cancel: true }); } }],
      ];
      for (const [type, handler] of state.listeners) window.addEventListener(type, handler);
      state.timer = setTimeout(() => {
        state.active = true;
        state.grab = state.y - state.el.getBoundingClientRect().top;
        state.before = latest.current;
        setLifted(id);
      }, HOLD_MS);
      press.current = state;
    },
    onClickCapture(event) {
      if (quiet.current) { event.preventDefault(); event.stopPropagation(); }
    },
    onKeyDown(event) {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const group = groupOf(latest.current, id), index = latest.current[group].indexOf(id) + (event.key === "ArrowUp" ? -1 : 1);
      if (index < 0 || index >= latest.current[group].length) return;
      refocus.current = id;
      change(placeAt(latest.current, id, index));
      setAnnounce({ id, position: index + 1, count: latest.current[group].length });
    },
  });
  const reset = useCallback(() => { latest.current = mergeOrder(null, defaults); setOrder(latest.current); setAnnounce(null); }, [defaults]);
  return { order, lifted, announce, customized, reset, bind };
}
