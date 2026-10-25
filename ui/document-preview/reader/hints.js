import { useState } from 'react';
import { browserStorage, readJSON, writeJSON } from '../../storage.js';

/*
 * The first-visit hints of the reader's 原始 PDF panel (issue #456): each says one thing once and goes away for good when the learner closes it. Closing is
 * remembered in this browser only, the way the reader remembers a closed 补全原文件 notice (original-file.js: storage.js readJSON / writeJSON, a short
 * list of ids); without storage (a blocked or private browser) the hint closes for this visit and comes back next time. Pure helpers plus one hook.
 */
const HINTS_KEY = 'study-reader-hints';

/** The hints there are: the page bar (which page is asked), and the presets with the way to the main chat. */
export const READER_HINTS = Object.freeze({ page: 'pdf-page', presets: 'page-presets' });

const closedIds = storage => { const stored = readJSON(HINTS_KEY, [], storage); return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []; };
/** Has the learner closed hint `id` in this browser? */
export const hintClosed = (id, storage = browserStorage()) => closedIds(storage).includes(id);
/** Remember that hint `id` was closed; true when it was stored. */
export const closeHint = (id, storage = browserStorage()) => writeJSON(HINTS_KEY, [...new Set([...closedIds(storage), id])], storage);

/** [shown, close] of hint `id`. */
export function useReaderHint(id) {
  const [closed, setClosed] = useState(() => hintClosed(id));
  return [!closed, () => { closeHint(id); setClosed(true); }];
}
