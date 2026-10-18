import { createContext, useCallback, useMemo } from 'react';
import { usePersistentState } from '../storage.js';

/* Which AI blocks of the book the learner folded or opened (复习全书 M4): kept per library and course in this browser (like the book's mode), never in the
   book's text, so it changes nothing in the files, the export or the editor. A block the learner never folded or opened follows the default of its own size
   (ui/book/point-parts.js foldsByDefault: folded over 1,500 characters unless kept, else open); a block that lands from a task started on the page is folded
   (ui/book/use-book-ai.js). The old 只留我写的 list of an earlier version is not read. */

/** The page's fold, for the points under it (null: nothing is folded). */
export const AiFoldContext = createContext(null);
/** The lines AI tasks and deletions leave on the page (ui/book/use-book-ai.js `lines`), for the points under it: kept out of the points' handlers so a line
    that comes or goes re-renders no point's text (null: no lines). */
export const BookAiContext = createContext(null);

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

/** -> { folded(id, byDefault), fold(id, on), foldAll(ids, on) }: `folded` is true for a block the learner folded, and for one they never opened when
    `byDefault`; `foldAll` folds or opens every block of `ids`. */
export function useAiFold(root, course) {
  const [list, setList] = usePersistentState(`study-book-ai-folded:${root}:${course}`, [], codec);
  const [openList, setOpenList] = usePersistentState(`study-book-ai-opened:${root}:${course}`, [], codec);
  const shut = useMemo(() => new Set(list), [list]), open = useMemo(() => new Set(openList), [openList]);
  const folded = useCallback((id, byDefault = false) => shut.has(id) || (byDefault && !open.has(id)), [shut, open]);
  const foldAll = useCallback((ids, on) => {
    setList(current => edit(current, ids, on));
    setOpenList(current => edit(current, ids, !on));
  }, [setList, setOpenList]);
  const fold = useCallback((id, on) => foldAll([id], on), [foldAll]);
  return useMemo(() => ({ folded, fold, foldAll }), [folded, fold, foldAll]);
}
