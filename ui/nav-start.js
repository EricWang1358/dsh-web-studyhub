import { browserStorage, readJSON, writeJSON } from './storage.js';

/* 「从这里开始」: the five sidebar entries a learner needs first, and the memory of which ones they have opened.

   The marker hides nothing and moves nothing: every entry stays where it is, in its group and its own order (ui/nav-order.js), and a marked entry
   works exactly as before. It goes away once its page has been open, from anywhere (a row, the home's first-run line, the S key): the marker is
   about "not been there yet", not about "not clicked this row". One key holds the ids, in this browser only, through the same helper as the
   sidebar's order and folders (ui/storage.js): study-nav-start:v1 = ["library", ...]. A browser that cannot store it keeps the memory for the
   visit only, and the marker still goes away.

   'review' is the 回到题目 row: it is a page of its own (ui/pages.js) and it is where practice starts, so it is one of the five. It is not a
   guidance item (ui/guidance/registry.js): nothing here appears by itself or asks for a decision, and 设置 › 引导 keeps to tips and cards. */

export const NAV_START_KEY = 'study-nav-start:v1';

/** The five entries: 学习库, 资料, 创建题组, 错题与待巩固, 回到题目. */
export const START_PAGES = Object.freeze(['library', 'sources', 'generate', 'wrongbook', 'review']);

/** Is this one of the starting entries? */
export const isStartPage = (id) => START_PAGES.includes(id);

/** The stored ids that still name a starting entry, in the order they were first opened; [] when the storage is missing, blocked or unreadable. */
export function readStarts(storage = browserStorage()) {
  const value = readJSON(NAV_START_KEY, [], storage);
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && isStartPage(id)))];
}

/** Remember that entry `id` has been opened; answers the ids remembered now. A write the browser refuses leaves the marker gone for this visit. */
export function markStart(id, storage = browserStorage()) {
  const starts = readStarts(storage);
  if (!isStartPage(id) || starts.includes(id)) return starts;
  const next = [...starts, id];
  writeJSON(NAV_START_KEY, next, storage);
  return next;
}

/** Does entry `id` still carry the marker, given the ids already opened? */
export const startHere = (id, starts = []) => isStartPage(id) && !starts.includes(id);
