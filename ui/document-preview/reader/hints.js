import { useState } from 'react';
import { browserStorage, readJSON, writeJSON } from '../../storage.js';

/*
 * The first-visit hints of the reader's 原始 PDF panel (issue #456): each says one thing once and goes away for good when the learner closes it. Closing is
 * remembered in this browser only, the way the reader remembers a closed 补全原文件 notice (original-file.js: storage.js readJSON / writeJSON, a short
 * list of ids). A browser without storage (a blocked or private window) remembers the closing for this visit instead, so a hint closed there does not come
 * back when the panel is closed and opened again. Pure helpers plus one hook.
 */
const HINTS_KEY = 'study-reader-hints';

/** The hints there are: the page bar (which page is asked), and the presets with the way to the main chat. */
export const READER_HINTS = Object.freeze({ page: 'pdf-page', presets: 'page-presets' });

/** Closed during this visit even when the browser has no storage: closing the reader and opening it again mounts a new panel. */
const closedThisVisit = new Set();

const closedIds = storage => { const stored = readJSON(HINTS_KEY, [], storage); return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []; };
/** Has the learner closed hint `id` in this browser, or during this visit? */
export const hintClosed = (id, storage = browserStorage()) => closedThisVisit.has(id) || closedIds(storage).includes(id);
/** Remember that hint `id` was closed; true when it was stored (this visit remembers it either way). */
export const closeHint = (id, storage = browserStorage()) => { closedThisVisit.add(id); return writeJSON(HINTS_KEY, [...new Set([...closedIds(storage), id])], storage); };
/** Start a new visit (tests call it between renders): the closings of this visit are forgotten, the stored ones stay. */
export const forgetClosedHints = () => closedThisVisit.clear();

/** [shown, close] of hint `id`. */
export function useReaderHint(id) {
  const [closed, setClosed] = useState(() => hintClosed(id));
  return [!closed, () => { closeHint(id); setClosed(true); }];
}
