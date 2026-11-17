import { useLayoutEffect } from 'react';

/* The names on the rows' facts lines of one picker follow one rule for the whole list (#1084, round 8): a run of rows reads the same. Each row lays its
   names out on its own (ui/source-picker.css: the first course whole or shortened to 6em at least, the names after it whole or on the hidden line); then
   the list looks at what every drawn row could hold and says it on its root as `data-names`:
   'all'   every row holds all its names: they are shown;
   'first' every row holds its first name, but some row cannot hold the ones after it: only the first is shown, on every row;
   'none'  some row cannot hold even its first name (at its least width): no row shows a name.
   A name a row does not show is hidden in place (visibility), so the rows keep their layout and the next look reads the same boxes. The room a row gives
   its names does not depend on the index answer (the badge's column is the same width coming, with a badge and without), so the answer landing changes
   nothing here. One ResizeObserver per picker looks again when the list's width or its drawn rows change, after layout and before the paint, so the first
   frame already reads the same on every row. */

/** 'all' | 'first' | 'none' for the rows drawn under `root`, '' when no row has a name. */
export function namesFit(root) {
  let any = false, first = true, rest = true;
  for (const facts of root.querySelectorAll('.source-picker__facts')) {
    const names = facts.querySelectorAll('[data-name]');
    if (!names.length || !facts.clientHeight) continue;
    any = true;
    const line = facts.getBoundingClientRect(), half = facts.clientHeight / 2;
    for (const name of names) {
      const box = name.getBoundingClientRect();
      if (box.width > 0 && box.top < line.top + half) continue;
      if (name.dataset.name === 'first') first = false; else rest = false;
    }
  }
  return !any ? '' : !first ? 'none' : !rest ? 'first' : 'all';
}

/** Keep `data-names` on the picker's root (`ref`) up to date; `key` changes when the rows' names do (another scope, other materials). */
export function useNamesFit(ref, key) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const look = () => {
      const fit = namesFit(root);
      if (fit) root.dataset.names = fit; else delete root.dataset.names;
    };
    if (typeof ResizeObserver === 'undefined') { look(); return undefined; }
    const observer = new ResizeObserver(look);
    observer.observe(root);
    const list = root.querySelector('.source-picker__list');
    if (list) observer.observe(list);
    // A web font that arrives later changes the words' widths, not the boxes the observer watches.
    let live = true;
    document.fonts?.ready?.then(() => { if (live) look(); });
    return () => { live = false; observer.disconnect(); };
  }, [ref, key]);
}
