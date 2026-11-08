import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { browserStorage, readJSON, removeKey, writeJSON } from "./storage.js";
import { MAIN_LIMIT, NAV_SECTIONS, PAGES, PAGE_IDS } from "./pages.js";

/* The sidebar's pages and their order (#654). Two places:

   - the main list (`main`): at most MAIN_LIMIT pages under 回到题目, the ones a learner opens every session (ui/pages.js `main: true`);
   - 「更多」: every other page, in sections by what the page is about (ui/pages.js NAV_SECTIONS and each page's `group`, its home section).

   Nothing here is a second list of pages: the defaults are derived from ui/pages.js, in registry order. A page sits either in the main list or in
   its home section, never in another section. The learner reorders by holding an item with the left button and dragging it; dragging an item of
   「更多」 up into the main list puts it there (while the main list has room) and dragging a main item down into 「更多」 sends it home. Alt+Up /
   Alt+Down move the focused item for keyboard users, and past the end of its group into the main list or back home.

   The order is a per-viewer convenience in localStorage (study-nav-order:v2). The order saved by the sidebar of before (groups by how often a
   page is used: 每天 / 阶段性 / 课程准备与管理, or the even older main / upkeep) is read once from its old key and migrated: every new group keeps
   the learner's sequence (migrateOrder); the old key is then removed. Pages added later go to their default place and pages that no longer
   exist are forgotten. Whether 「更多」 is open is remembered the same way (study-nav-more). */

export const NAV_ORDER_KEY = "study-nav-order:v2";
export const LEGACY_ORDER_KEY = "study-nav-order";
export const NAV_MORE_KEY = "study-nav-more";
const HOLD_MS = 350; // the item lifts only after this long, so an ordinary click or a slip never reorders
const SLOP = 6; // moving further than this before the hold ends means the press was something else

const sidebarPages = PAGE_IDS.filter((id) => PAGES[id].group);
/** Each sidebar page's home section in 「更多」. */
export const NAV_HOMES = Object.freeze(Object.fromEntries(sidebarPages.map((id) => [id, PAGES[id].group])));
/** The sidebar's default order: the main list, then every section of 「更多」, each in registry order. */
export const NAV_DEFAULTS = Object.freeze({
  main: sidebarPages.filter((id) => PAGES[id].main),
  ...Object.fromEntries(NAV_SECTIONS.map((section) => [section.id, sidebarPages.filter((id) => !PAGES[id].main && PAGES[id].group === section.id)])),
});
/** The groups as drawn: the main list (no heading on screen), then the sections of 「更多」 with the label that says what they hold. */
export const NAV_GROUPS = Object.freeze([{ id: "main", label: "主导航", more: false }, ...NAV_SECTIONS.map((section) => ({ ...section, more: true }))]);
const DEFAULT_OPTIONS = { homes: NAV_HOMES, limit: MAIN_LIMIT };

const unique = (ids) => ids.filter((id, index, all) => all.indexOf(id) === index);
const known = (defaults) => new Set(Object.values(defaults).flat());

/** May `id` sit in `group`? The main list takes any page, a section only its own. */
const allowed = (id, group, homes) => group === "main" || homes[id] === group;

/** A saved order (study-nav-order:v2) applied to the pages that exist now: each page where it was saved if that place is allowed, the main list
 *  cut to its limit, and every page the saved order does not place (new, or dropped as not allowed) at its default place, or home when the main
 *  list is full. */
export function mergeOrder(saved, defaults = NAV_DEFAULTS, { homes = NAV_HOMES, limit = MAIN_LIMIT } = {}) {
  const pages = known(defaults), placed = new Set();
  const merged = Object.fromEntries(Object.keys(defaults).map((group) => [group, []]));
  const take = (group, ids) => {
    for (const id of ids) {
      if (!pages.has(id) || placed.has(id) || !allowed(id, group, homes) || (group === "main" && merged.main.length >= limit)) continue;
      merged[group].push(id);
      placed.add(id);
    }
  };
  if (saved && typeof saved === "object") for (const group of Object.keys(defaults)) if (Array.isArray(saved[group])) take(group, saved[group]);
  for (const [group, ids] of Object.entries(defaults)) for (const id of ids) {
    if (placed.has(id)) continue;
    take(group === "main" && merged.main.length < limit ? "main" : homes[id], [id]);
  }
  return merged;
}

/** An order saved by the sidebar of before (any shape of groups: 每天 / 阶段性 / 课程准备与管理, or main / upkeep) read as the one sequence the
 *  learner made, and applied to the default groups: nothing moves between groups, and inside every group the learner's sequence holds. */
export function migrateOrder(old, defaults = NAV_DEFAULTS, { homes = NAV_HOMES, limit = MAIN_LIMIT } = {}) {
  const sequence = old && typeof old === "object" ? unique(Object.values(old).filter(Array.isArray).flat().filter((id) => typeof id === "string")) : [];
  const rank = (id) => { const at = sequence.indexOf(id); return at < 0 ? Infinity : at; };
  const sorted = Object.fromEntries(Object.entries(defaults).map(([group, ids]) => [group, ids.map((id, at) => ({ id, at }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.at - b.at).map(({ id }) => id)]));
  return mergeOrder(sorted, defaults, { homes, limit });
}

export const sameOrder = (a, b) => Object.keys(a).every((group) => a[group].length === b[group]?.length && a[group].every((id, index) => id === b[group][index]));
export const groupOf = (order, id) => Object.keys(order).find((group) => order[group].includes(id));

/** `id` moved to `index` among the other items of `group` (default: the group it is in). A move the rules do not allow (another section, a full
 *  main list) answers the order unchanged. */
export function placeAt(order, id, index, group = groupOf(order, id), { homes = NAV_HOMES, limit = MAIN_LIMIT } = {}) {
  const from = groupOf(order, id);
  if (!from || !order[group]) return order;
  if (group !== from && (!allowed(id, group, homes) || (group === "main" && order.main.length >= limit))) return order;
  const next = { ...order, [from]: order[from].filter((item) => item !== id) };
  const rest = [...next[group]];
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  next[group] = rest;
  return next;
}

/** Alt+Up (-1) / Alt+Down (+1) on `id`: one place up or down in its group; past the top of a section into the end of the main list, past the
 *  end of the main list to the top of its home section. { order, id, group, position, count }, { refused: 'full', id } when the main list has
 *  no room, or null when there is nowhere to go. */
export function keyMove(order, id, direction, options = DEFAULT_OPTIONS) {
  const { homes = NAV_HOMES, limit = MAIN_LIMIT } = options;
  const group = groupOf(order, id);
  if (!group) return null;
  const index = order[group].indexOf(id), to = index + direction;
  let target = group, at = to;
  if (to < 0 || to >= order[group].length) {
    if (direction < 0 && group !== "main") { target = "main"; at = order.main.length; }
    else if (direction > 0 && group === "main" && order[homes[id]]) { target = homes[id]; at = 0; }
    else return null;
    if (target === "main" && order.main.length >= limit) return { refused: "full", id };
  }
  const next = placeAt(order, id, at, target, { homes, limit });
  if (next === order) return null;
  return { order: next, id, group: target, position: next[target].indexOf(id) + 1, count: next[target].length };
}

/** Entry slot when a pointer drag crosses between `main` and a `更多` section: promoting into `main` lands at the end, demoting into a home section lands at the top. */
export function crossGroupDropIndex(from, to, targetLength) {
  if (from === to) return targetLength;
  return to === "main" ? targetLength : 0;
}

/** Is 「更多」 drawn open? When the learner opened it, and while the page on screen is one of its pages (the current page is always visible), unless
 *  the learner closed it on this very page (`closedOn`). */
export function moreIsOpen({ open, activePage, order, closedOn = null }) {
  if (open) return true;
  const group = groupOf(order, activePage);
  return !!group && group !== "main" && closedOn !== activePage;
}

/** The order of this browser: the saved one, else the one the sidebar of before saved (migrated), else the defaults. */
export function readNavOrder(storage = browserStorage(), defaults = NAV_DEFAULTS) {
  const saved = readJSON(NAV_ORDER_KEY, null, storage);
  if (saved && typeof saved === "object") return mergeOrder(saved, defaults);
  const old = readJSON(LEGACY_ORDER_KEY, null, storage);
  return old && typeof old === "object" ? migrateOrder(old, defaults) : mergeOrder(null, defaults);
}

/** Keep `order` (null: the defaults, nothing stored) and forget the key of before, which has been read by now. */
export function writeNavOrder(order, storage = browserStorage()) {
  if (order) writeJSON(NAV_ORDER_KEY, order, storage); else removeKey(NAV_ORDER_KEY, storage);
  removeKey(LEGACY_ORDER_KEY, storage);
}

/** The groups drawn on screen that `id` may be dragged into, by their element: its own group and the other place it may sit. */
const targetsOf = (order, id, homes) => [...new Set([groupOf(order, id), "main", homes[id]])].filter((group) => group && order[group]);

/**
 * @param defaults  { group: [id, …] } in the original order
 * @param navRef    the element holding the items; each carries data-nav-id and sits inside an element with data-nav-group
 * @returns order, lifted (the id being dragged), announce ({ id, group, position, count } after a move, or { id, refused } when it could not
 *          move), customized, reset(), and bind(id): the props to spread on an item
 */
export function useNavOrder(defaults, navRef, { homes = NAV_HOMES, limit = MAIN_LIMIT } = {}) {
  const [order, setOrder] = useState(() => (defaults === NAV_DEFAULTS ? readNavOrder() : mergeOrder(null, defaults, { homes, limit })));
  const [lifted, setLifted] = useState(null);
  const [announce, setAnnounce] = useState(null);
  const latest = useRef(order);
  latest.current = order;
  const press = useRef(null);
  const quiet = useRef(false); // the click that ends a drag must not open the page
  const refocus = useRef(null);
  const customized = !sameOrder(order, defaults);
  useEffect(() => { writeNavOrder(customized ? order : null); }, [order, customized]);

  const node = (id) => navRef.current?.querySelector(`[data-nav-id="${id}"]`);
  // A section folded away in a closed 「更多」 is no place to drop: the browser still lays out what a closed <details> hides, so ask whether it is drawn.
  const box = (group) => {
    const element = navRef.current?.querySelector(`[data-nav-group="${group}"] .nav-group-items, [data-nav-group="${group}"][data-nav-items]`);
    return element && (element.checkVisibility?.() ?? true) ? element.getBoundingClientRect() : null;
  };
  const change = (next) => { latest.current = next; setOrder(next); };
  const said = (next, id, group) => setAnnounce({ id, group, position: next[group].indexOf(id) + 1, count: next[group].length });
  /** Keep the lifted item under the pointer, wherever the list has moved around it. */
  const follow = (state) => {
    const natural = state.el.getBoundingClientRect().top - state.dy;
    state.dy = state.y - state.grab - natural;
    state.el.style.transform = `translateY(${state.dy}px)`;
  };
  const finish = (state, { cancel = false } = {}) => {
    clearTimeout(state.timer);
    for (const [type, handler] of state.listeners) window.removeEventListener(type, handler);
    press.current = null;
    if (!state.active) return;
    state.el.style.transform = "";
    if (cancel) change(state.before);
    // A drop the full main list refused leaves the refusal as the thing said, not a move that did not happen.
    else if (state.refused && sameOrder(latest.current, state.before)) { /* announce already holds the refusal */ }
    else { const group = groupOf(latest.current, state.id); said(latest.current, state.id, group); }
    setLifted(null);
    quiet.current = true;
    setTimeout(() => { quiet.current = false; }, 0);
  };
  /** Where the lifted item now sits: among the others of its group, or, once its middle is over the other group it may go to, at that group's
   *  entry boundary (end of `main` when promoted from `更多`, top of home section when demoted from `main`), since the drag ends as soon as
   *  the item crosses groups and unmounts in its old list. */
  const settle = (state) => {
    const order = latest.current, rect = state.el.getBoundingClientRect(), middle = rect.top + rect.height / 2;
    const from = groupOf(order, state.id);
    const over = targetsOf(order, state.id, homes).find((group) => { const area = group !== from && box(group); return area && area.height > 0 && middle >= area.top && middle <= area.bottom; });
    const group = over || from;
    const others = order[group].filter((id) => id !== state.id);
    let index;
    if (group !== from) {
      index = crossGroupDropIndex(from, group, others.length);
    } else {
      index = others.findIndex((id) => { const at = node(id)?.getBoundingClientRect(); return at && middle < at.top + at.height / 2; });
      if (index < 0) index = others.length;
    }
    const next = placeAt(order, state.id, index, group, { homes, limit });
    if (group !== from) {
      if (next === order) { if (group === "main" && !state.refused) { state.refused = true; setAnnounce({ id: state.id, refused: "full" }); } return; }
      change(next);
      finish(state);
      return;
    }
    if (!sameOrder(next, order)) change(next);
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
    // The keys are said on the row itself, so a screen reader names them on every row while the sighted tooltip says them once (ui/nav-reorder-hint.js).
    "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
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
      const moved = keyMove(latest.current, id, event.key === "ArrowUp" ? -1 : 1, { homes, limit });
      if (!moved) return;
      if (moved.refused) { setAnnounce(moved); return; }
      refocus.current = id;
      change(moved.order);
      setAnnounce({ id, group: moved.group, position: moved.position, count: moved.count });
    },
  });
  const reset = useCallback(() => { latest.current = mergeOrder(null, defaults, { homes, limit }); setOrder(latest.current); setAnnounce(null); }, [defaults, homes, limit]);
  return { order, lifted, announce, customized, reset, bind };
}
