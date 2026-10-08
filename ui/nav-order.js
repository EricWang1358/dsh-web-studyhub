import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { readJSON, removeKey, writeJSON } from "./storage.js";

/* The sidebar's pages, grouped by WHEN a page is used (docs/feature-tiers.md), and their order, set by holding an item
   with the left button and dragging it.

   - 每天 (daily): what a learner opens every session, including adding the week's material and making questions from it
     (a new lecture arrives every week, so 资料 and 创建题组 are part of the daily loop, not a once-per-course step), and
     the places the work goes on in (任务, 错题与待巩固, 学习流, 学习笔记, 待办);
   - 阶段性 (periodic): what is opened now and then (a mock exam, 备考补习 once DSH has turned it on, the statistics);
   - 课程准备与管理 (setup): what is done once at the start of a course (draw the skeleton) or only by those who record
     their classes (audio transcription, class recordings), and when a course is looked after.

   Items are reordered inside their own group, so the labels between the groups stay where they are. The order and which
   groups are folded are per-viewer conveniences kept in localStorage; pages added later go last in their group and pages
   that no longer exist are forgotten. Alt+Up / Alt+Down move the focused item for keyboard users. */

const KEY = "study-nav-order";
const GROUPS_KEY = "study-nav-groups";
/** The sidebar's default order: the pages of every day, then those of now and then, then the once-per-course ones. */
export const NAV_DEFAULTS = Object.freeze({
  daily: ["library", "sources", "generate", "tasks", "wrongbook", "workflows", "notes", "board"],
  periodic: ["exam", "examprep", "dashboard"],
  setup: ["skeleton", "audio", "live"],
});
/** The groups as drawn: a plain label, one line saying what they hold, and whether the learner can fold them. */
export const NAV_GROUPS = Object.freeze([
  { id: "daily", label: "每天", hint: "每天都会用：学习库、资料、创建题组、任务、错题与待巩固、学习流、学习笔记、待办", collapsible: false },
  { id: "periodic", label: "阶段性", hint: "隔一阵用一次：模拟考试、备考补习（DSH 开启后出现）、统计", collapsible: true },
  { id: "setup", label: "课程准备与管理", hint: "每门课开头做一次或按需用：知识骨架、音频转写、课堂实录", collapsible: true },
]);
const HOLD_MS = 350; // the item lifts only after this long, so an ordinary click or a slip never reorders
const SLOP = 6; // moving further than this before the hold ends means the press was something else

const read = () => {
  const value = readJSON(KEY);
  return value && typeof value === "object" ? value : null;
};
const write = (value) => { // the order still applies this session when the storage refuses it
  if (value) writeJSON(KEY, value); else removeKey(KEY);
};

/** A saved order applied to the pages that exist now. An order saved before the regrouping (main / upkeep) lends its
 *  sequence to every new group, so a learner's own order survives the move. */
export function mergeOrder(saved, defaults) {
  const merged = {};
  const legacy = saved && typeof saved === "object" && !Object.keys(defaults).some((group) => group in saved) && ("main" in saved || "upkeep" in saved)
    ? [...(Array.isArray(saved.main) ? saved.main : []), ...(Array.isArray(saved.upkeep) ? saved.upkeep : [])] : null;
  for (const [group, ids] of Object.entries(defaults)) {
    const kept = (legacy ?? (Array.isArray(saved?.[group]) ? saved[group] : [])).filter((id, index, all) => ids.includes(id) && all.indexOf(id) === index);
    merged[group] = [...kept, ...ids.filter((id) => !kept.includes(id))];
  }
  return merged;
}

/** The groups the learner folded: { setup: true }. Only collapsible groups, only `true`; anything unreadable is nothing folded. */
export function readNavGroups() {
  const value = readJSON(GROUPS_KEY);
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(NAV_GROUPS.filter((group) => group.collapsible && value[group.id] === true).map((group) => [group.id, true]));
}
export function writeNavGroups(folded) { // the groups still fold this session when the storage refuses it
  const kept = Object.fromEntries(Object.entries(folded || {}).filter(([, value]) => value === true));
  if (Object.keys(kept).length) writeJSON(GROUPS_KEY, kept); else removeKey(GROUPS_KEY);
}
/** Is a group drawn open? A folded group opens by itself while the learner is on one of its pages (the current page is always visible). */
export function groupIsOpen(id, folded, activePage) {
  const group = NAV_GROUPS.find((item) => item.id === id);
  if (!group?.collapsible || !folded?.[id]) return true;
  return NAV_DEFAULTS[id]?.includes(activePage) ?? false;
}
/** The folded groups, remembered; toggle(id) folds or opens one. */
export function useNavGroups() {
  const [folded, setFolded] = useState(readNavGroups);
  const toggle = useCallback((id) => setFolded((current) => {
    const next = { ...current, [id]: !current[id] };
    writeNavGroups(next);
    return next;
  }), []);
  return { folded, toggle };
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
