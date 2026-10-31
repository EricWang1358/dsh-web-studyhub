import { useCallback, useRef, useState } from 'react';
import { browserStorage, readJSON, writeJSON } from './storage.js';
import { clearCount } from './guidance/cleared.js';

/* 「长按并拖动可调整顺序（键盘：Alt+↑/↓）」, told once (issue 569). It used to close every sidebar tooltip, word for word, so a learner
   read it each time they looked along the sidebar. Now it is in the first reorderable row's tooltip the learner opens (hover or keyboard
   focus) and stays for as long as that tooltip is open; when it closes the line is gone from every tooltip, in this browser, for good.
   A learner who reorders before that (a long press, Alt+↑/↓) has found it already, so it is not told at all. The keys stay listed in the
   shortcut sheet (ui/ShortcutHelp.jsx) and on each row as aria-keyshortcuts (ui/nav-order.js), and 设置 › 引导 lists the line
   (ui/guidance/registry.js, 'nav.reorder-hint') with 再显示一次.

   One key, through the same helper as the sidebar's order and its 「从这里开始」 dots (ui/storage.js): study-nav-reorder-hint:v1 = true.
   A browser that cannot store it keeps the memory for the visit only, so the line is still said once a visit, not on every row. */

export const NAV_REORDER_HINT_KEY = 'study-nav-reorder-hint:v1';
export const NAV_REORDER_HINT_ID = 'nav.reorder-hint';

/** Has this browser told the learner how to reorder the sidebar? False when the storage is missing, blocked or unreadable. */
export const reorderHintTold = (storage = browserStorage()) => readJSON(NAV_REORDER_HINT_KEY, null, storage) === true;
/** Remember that it was told; true when the browser kept it. */
export const markReorderHintTold = (storage = browserStorage()) => writeJSON(NAV_REORDER_HINT_KEY, true, storage);

/**
 * show: whether the reorderable rows carry the line now. tipChange(open): a reorderable row's tooltip opened or closed (the line is
 * remembered as told when one opens while it shows, and leaves the rows when that tooltip closes, never while it is on screen).
 * learned(): the learner reordered, so it need not be told. A 再显示一次 in Settings › 引导 in this tab brings it back (ui/guidance/cleared.js).
 */
export function useReorderHint(storage) {
  // null: not told yet. A number: told (or found), at that clear count of the guidance item.
  const [toldAt, setToldAt] = useState(() => (reorderHintTold(storage ?? browserStorage()) ? clearCount(NAV_REORDER_HINT_ID) : null));
  const told = useRef(false); // told in the tooltip open now: it stays until that tooltip closes
  const show = toldAt === null || told.current || (clearCount(NAV_REORDER_HINT_ID) !== toldAt && !reorderHintTold(storage ?? browserStorage()));
  const shown = useRef(show);
  shown.current = show;
  const tipChange = useCallback((visible) => {
    if (visible) {
      if (shown.current && !told.current) { told.current = true; markReorderHintTold(storage ?? browserStorage()); }
      return;
    }
    // Gone at once, before the next render: focus moving straight on to the next row opens its tooltip without the line.
    if (told.current) { told.current = false; shown.current = false; setToldAt(clearCount(NAV_REORDER_HINT_ID)); }
  }, [storage]);
  const learned = useCallback(() => {
    if (!shown.current) return;
    markReorderHintTold(storage ?? browserStorage());
    told.current = false;
    shown.current = false;
    setToldAt(clearCount(NAV_REORDER_HINT_ID));
  }, [storage]);
  return { show, tipChange, learned };
}
