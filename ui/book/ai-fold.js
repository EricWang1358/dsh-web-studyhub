import { createContext, useCallback, useEffect, useMemo, useRef } from 'react';
import { usePersistentState } from '../storage.js';
import { aiBlocks } from '../../lib/course-book-ai-text.js';
import { showBlock } from './ai-anchors.js';

/* Which AI blocks of the book the learner folded or opened (复习全书 M4), and the points where only what the learner wrote shows (整理 › 只留我写的): kept
   per library and course in this browser (like the book's mode), never in the book's text, so they change nothing in the files, the export or the
   editor. A block the learner never folded or opened follows its point's layer: open, or folded when the layer starts folded (ui/book/point-parts.js
   pointView). Hiding is never deleting: 全部显示 brings the blocks back. */

/** The page's fold, for the points under it (null: nothing is folded and there is no 整理 menu). */
export const AiFoldContext = createContext(null);

const KEPT = 1000;
const codec = {
  parse: value => { try { const list = JSON.parse(value); return Array.isArray(list) ? list.filter(id => typeof id === 'string') : []; } catch { return []; } },
  serialize: value => JSON.stringify(value),
};
const edit = (list, ids, on) => {
  const next = new Set(list);
  for (const id of ids) { if (on) next.add(id); else next.delete(id); }
  return next.size === list.length && ids.every(id => list.includes(id) === on) ? list : [...next].slice(-KEPT);
};

/** -> { folded(id, byDefault), fold(id, on), foldAll(ids, on), mineOnly(hid), setMineOnly(hid, on) }: `folded` is true for a block the learner folded,
    and for one they never opened when `byDefault`; `foldAll` folds or opens every block of `ids`; `mineOnly` says a point hides the blocks the learner
    did not write (new, under the heading). */
export function useAiFold(root, course) {
  const [list, setList] = usePersistentState(`study-book-ai-folded:${root}:${course}`, [], codec);
  const [openList, setOpenList] = usePersistentState(`study-book-ai-opened:${root}:${course}`, [], codec);
  const [onlyList, setOnlyList] = usePersistentState(`study-book-ai-mine-only:${root}:${course}`, [], codec);
  const shut = useMemo(() => new Set(list), [list]), open = useMemo(() => new Set(openList), [openList]), only = useMemo(() => new Set(onlyList), [onlyList]);
  const folded = useCallback((id, byDefault = false) => shut.has(id) || (byDefault && !open.has(id)), [shut, open]);
  const foldAll = useCallback((ids, on) => {
    setList(current => edit(current, ids, on));
    setOpenList(current => edit(current, ids, !on));
  }, [setList, setOpenList]);
  const fold = useCallback((id, on) => foldAll([id], on), [foldAll]);
  const mineOnly = useCallback(hid => only.has(hid), [only]);
  const setMineOnly = useCallback((hid, on) => setOnlyList(current => edit(current, [hid], on)), [setOnlyList]);
  return useMemo(() => ({ folded, fold, foldAll, mineOnly, setMineOnly }), [folded, fold, foldAll, mineOnly, setMineOnly]);
}

/** A block the learner did not write: new (never kept) and written for the whole point (under the heading). 只留我写的 hides these. */
export const notWritten = block => block.state === 'new' && block.mode === 'here';

const blocksOf = book => {
  const out = new Map();
  const walk = list => (list || []).forEach(node => { if (node.leaf) for (const block of aiBlocks(node.mine)) out.set(block.id, node.hid); walk(node.children); });
  walk(book?.status === 'ok' ? book.nodes : []);
  return out;
};
/** A block that lands from a task started on the page is opened (whatever its layer's fold), shown even where 只留我写的 is on, and scrolled to.
    -> expect(): call when such a task ended; the next book with a block it did not have before shows it. */
export function useLandedBlocks(book, aiFold) {
  const known = useRef(null), waiting = useRef(false);
  useEffect(() => {
    if (book?.status !== 'ok') return undefined;
    const now = blocksOf(book), before = known.current;
    known.current = now;
    const fresh = before && waiting.current ? [...now.keys()].filter(id => !before.has(id)) : [];
    if (!fresh.length) return undefined;
    waiting.current = false;
    aiFold.foldAll(fresh, false);
    for (const hid of new Set(fresh.map(id => now.get(id)))) aiFold.setMineOnly(hid, false);
    const timer = setTimeout(() => showBlock(fresh[0]), 80);
    return () => clearTimeout(timer);
  }, [book]); // eslint-disable-line react-hooks/exhaustive-deps
  return useCallback(() => { waiting.current = true; }, []);
}
