/* 找功能: the keys. Pure, so the rules are the same in the app root's handler (ui/finder/use-finder.js), the usage capture (ui/usage/capture.js) and the tests.

   Ctrl K (⌘K on a Mac) opens the finder wherever the focus is inside the app, a text field too: it is no letter anyone types. `/` opens it only when the
   learner is not typing. Neither is listened for on window or document, only on the app's own root (ui/App.jsx), so the keys of the DSH host stay the host's. */

/** Is this a Mac (⌘ instead of Ctrl)? */
export function isMacPlatform(environment = typeof navigator === 'undefined' ? null : navigator) {
  return /Mac|iPhone|iPad/i.test(String(environment?.platform || environment?.userAgent || ''));
}

/** How the shortcut is written on the sidebar row, for this platform. */
export const finderShortcutLabel = (mac = isMacPlatform()) => (mac ? '⌘K' : 'Ctrl K');

/** Does this key event ask for the finder? `typing`: the target is a text field or an editor. */
export function opensFinder(event, { typing = false } = {}) {
  if (!event || event.repeat || event.isComposing || event.altKey) return false;
  const key = typeof event.key === 'string' ? event.key : '';
  if (event.ctrlKey || event.metaKey) return !event.shiftKey && key.toLowerCase() === 'k';
  return key === '/' && !event.shiftKey && !typing;
}

/** The row to select after an arrow key in a list of ids: ↓ and ↑ move by one and wrap; an id that is not in the list starts at the first (↓) or last (↑). */
export function moveActive(ids, active, key) {
  if (!ids.length) return null;
  const at = ids.indexOf(active);
  if (key === 'ArrowDown') return ids[(at + 1) % ids.length];
  if (key === 'ArrowUp') return ids[at < 0 ? ids.length - 1 : (at - 1 + ids.length) % ids.length];
  return ids.includes(active) ? active : ids[0];
}
