import { resolveUsageControl, usageAreaOf } from './keys.js';

/* The one delegated listener of the usage frequency record. Installed on the app root only while the record is on (ui/usage/controller.js);
   removed completely when it is turned off or paused.

   - `click` in the capture phase: the control under the pointer, or the focused control activated by Enter or Space (a keyboard-made click has
     detail 0), resolved to its key (ui/usage/keys.js) and handed to `record`;
   - `keydown`: the documented app shortcuts (S, A, ?, P and, on the practice page, the number keys, Enter, arrows, Space, H, T), only where the app itself
     would act on them: not while typing, only P inside a reader dialog, and Enter or Space on a focused button is that button's click, not a second count;
   - a held key (auto-repeat) counts once: its repeated keydowns are not shortcuts, and the clicks a held Enter or Space makes are ignored until it is released.

   It reads attributes only: no layout, no state, nothing React. */

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const MAX_DEPTH = 80;

/**
 * The registry key of the documented shortcut this key event is, or null. Mirrors the app's own rules (ui/App.jsx): no modifier keys, no repeat,
 * nothing typed into an input, textarea, select or editor. Dialogs only accept the reader's P shortcut; Enter or Space on a focused button belongs to the button.
 */
export function shortcutKeyFor(event, { fallbackArea = 'other' } = {}) {
  if (!event || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = typeof event.key === 'string' ? event.key : '';
  const practice = key.toLowerCase() === 'p' && !event.shiftKey;
  let onButton = false, area = null;
  for (let node = event.target, depth = 0; node && depth < MAX_DEPTH; node = node.parentElement, depth += 1) {
    if (EDITABLE.has(node.tagName) || (typeof node.hasAttribute === 'function' && node.hasAttribute('data-usage-ignore'))) return null;
    const editable = typeof node.getAttribute === 'function' ? node.getAttribute('contenteditable') : null;
    if (editable !== null && editable !== 'false') return null;
    if (node.tagName === 'BUTTON' || node.tagName === 'A') onButton = true;
    if (!area && typeof node.getAttribute === 'function') area = node.getAttribute('data-usage-area');
    if (practice && area === 'reader' && node.getAttribute?.('data-mode') === 'original') return null;
    if (node.tagName === 'DIALOG' && !(practice && area === 'reader')) return null;
  }
  if (key === '?' || (event.shiftKey && event.code === 'Slash')) return 'shortcut.help';
  if (event.shiftKey) return null;
  const letter = key.length === 1 ? key.toLowerCase() : '';
  const page = area || fallbackArea;
  if (letter === 's') return 'shortcut.resume';
  if (letter === 'a') return 'shortcut.autopilot';
  if (letter === 'p' && page === 'reader') return 'shortcut.practice';
  if (page !== 'review') return null;
  if (/^[0-6]$/.test(key)) return 'shortcut.digit';
  const space = key === ' ' || event.code === 'Space';
  if ((key === 'Enter' || space) && onButton) return null;
  if (key === 'Enter' || key === 'ArrowRight') return 'shortcut.next';
  if (key === 'ArrowLeft') return 'shortcut.prev';
  if (space) return 'shortcut.flip';
  if (letter === 'h') return 'shortcut.hint';
  if (letter === 't') return 'shortcut.explain';
  return null;
}

/**
 * Install the capture on `root`; resolves to the function that removes it. `record(key, area)` is the collector's. Keys are listened for on
 * `keyScope` (the document, so a shortcut pressed while focus has dropped to the page body still counts, as the app's own handler allows);
 * only events inside `root` or on the body itself count.
 */
export function installUsageCapture(root, { record, resolve = resolveUsageControl, keyScope = root } = {}) {
  let repeating = false;
  const fallback = () => (typeof root.getAttribute === 'function' ? root.getAttribute('data-usage-area') : null) || 'other';
  const onClick = event => {
    if (event.detail === 0 && repeating) return;
    const hit = resolve(event.target, { fallbackArea: fallback() });
    if (hit) record(hit.key, hit.area);
  };
  const inside = target => keyScope === root || typeof root.contains !== 'function' || !target || root.contains(target) || target === keyScope.body || target === keyScope.documentElement;
  const onKeyDown = event => {
    if (event.repeat) { repeating = true; return; }
    repeating = false;
    if (!inside(event.target)) return;
    const key = shortcutKeyFor(event, { fallbackArea: fallback() });
    if (key) record(key, usageAreaOf(event.target, fallback()));
  };
  const onKeyUp = () => { repeating = false; };
  root.addEventListener('click', onClick, true);
  keyScope.addEventListener('keydown', onKeyDown, true);
  keyScope.addEventListener('keyup', onKeyUp, true);
  return () => {
    root.removeEventListener('click', onClick, true);
    keyScope.removeEventListener('keydown', onKeyDown, true);
    keyScope.removeEventListener('keyup', onKeyUp, true);
  };
}
