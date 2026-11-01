import { readText, removeKey, writeText } from '../storage.js';

/* What the editor could not ask about (#489): the app's leave gate asks before every way out it knows of, but the page can also go with no question possible (the host switches to another of
   its own views, the main chat or another tab changes the current course or the library). Then the unsaved text waits in this browser, per library, course and file, until the editor
   opens that file again and offers it back. Only then: an answered 丢掉改动 keeps nothing. */

const keyOf = (root, course, file) => `study-book-unsaved:${root}:${course}:${file}`;

/** Keep the text and the file's version it was edited from (a save later is compare-and-set on it, so a newer file is not written over). -> stored? */
export const keepUnsaved = (root, course, file, text, version) => writeText(keyOf(root, course, file), JSON.stringify({ text, version }));

/** { text, version } kept for that file, or null. */
export function readUnsaved(root, course, file) {
  try {
    const kept = JSON.parse(readText(keyOf(root, course, file), null));
    return typeof kept?.text === 'string' ? kept : null;
  } catch { return null; }
}

export const forgetUnsaved = (root, course, file) => removeKey(keyOf(root, course, file));
