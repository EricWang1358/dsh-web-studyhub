import { createContext, useCallback, useMemo } from 'react';
import { usePersistentState } from '../storage.js';

/* Which AI blocks of the book the learner folded (复习全书 M4): kept per library and course in this browser (like the book's mode), never in the book's text,
   so a fold changes nothing in the files, the export or the editor. A block never folded is open; a new one opens open. */

/** The page's fold, for the points under it (null: nothing is folded and there is no 全部收起). */
export const AiFoldContext = createContext(null);

const parse = value => {
  try { const list = JSON.parse(value); return Array.isArray(list) ? list.filter(id => typeof id === 'string') : []; } catch { return []; }
};

/** -> { folded(id), fold(id, on), foldAll(ids, on) }: `folded` is true for a block the learner folded; `foldAll` folds or opens every block of `ids`. */
export function useAiFold(root, course) {
  const [list, setList] = usePersistentState(`study-book-ai-folded:${root}:${course}`, [], { parse, serialize: value => JSON.stringify(value) });
  const set = useMemo(() => new Set(list), [list]);
  const folded = useCallback(id => set.has(id), [set]);
  const foldAll = useCallback((ids, on) => setList(current => {
    const next = new Set(current);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return [...next];
  }), [setList]);
  const fold = useCallback((id, on) => foldAll([id], on), [foldAll]);
  return useMemo(() => ({ folded, fold, foldAll }), [folded, fold, foldAll]);
}
