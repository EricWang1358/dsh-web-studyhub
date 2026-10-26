import { useState } from 'react';
import { browserStorage, readJSON, writeJSON } from '../../storage.js';
import { guidanceAllows } from '../../guidance/budget.js';
import { clearCount } from '../../guidance/cleared.js';

/*
 * The first-visit hints of the reader's 原始 PDF panel (issue #456): each says one thing once and goes away for good when the learner closes it. Closing is
 * remembered in this browser only, the way the reader remembers a closed 补全原文件 notice (original-file.js: storage.js readJSON / writeJSON, a short
 * list of ids). A browser without storage (a blocked or private window) remembers the closing for this visit instead, so a hint closed there does not come
 * back when the panel is closed and opened again. Pure helpers plus one hook.
 */
/** The one stored list of closed hint ids; 设置 › 引导 reads and clears it through ui/guidance/registry.js (item reader.<id>). */
export const HINTS_KEY = 'study-reader-hints';

/** The hints there are: the page bar (which page is asked), and the presets with the way to the main chat. */
export const READER_HINTS = Object.freeze({ page: 'pdf-page', presets: 'page-presets' });

/** The 设置 › 引导 item of hint `id`. */
export const hintItem = id => `reader.${id}`;

/** Closed during this visit even when the browser has no storage: closing the reader and opening it again mounts a new panel. Each closing keeps the
    clear count of its item (ui/guidance/cleared.js): 再显示一次 in this tab undoes the memory, a reset in another tab does not. */
const closedThisVisit = new Map();

const closedIds = storage => { const stored = readJSON(HINTS_KEY, [], storage); return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []; };
const closedInVisit = id => closedThisVisit.has(id) && closedThisVisit.get(id) === clearCount(hintItem(id));
/** Has the learner closed hint `id` in this browser, or during this visit? */
export const hintClosed = (id, storage = browserStorage()) => closedInVisit(id) || closedIds(storage).includes(id);
/** Remember that hint `id` was closed; true when it was stored (this visit remembers it either way). */
export const closeHint = (id, storage = browserStorage()) => {
  closedThisVisit.set(id, clearCount(hintItem(id)));
  return writeJSON(HINTS_KEY, [...new Set([...closedIds(storage), id])], storage);
};
/** Start a new visit (tests call it between renders): the closings of this visit are forgotten, the stored ones stay. */
export const forgetClosedHints = () => closedThisVisit.clear();

/** [shown, close] of hint `id`. A hint is proactive guidance: 设置 › 引导's master switch and its own switch (reader.<id>) can keep it away. */
export function useReaderHint(id) {
  const [closed, setClosed] = useState(() => hintClosed(id) || !guidanceAllows(hintItem(id)));
  return [!closed, () => { closeHint(id); setClosed(true); }];
}
