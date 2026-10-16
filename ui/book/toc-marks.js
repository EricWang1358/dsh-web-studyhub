/* 复习全书, the one mark at the end of a 目录 row (ui/book/BookToc.jsx; docs/review-book.md "The contents"): 易错 N (the point's mistakes, counted as 翻看 and the
   速查页 count them, lib/book-flip.js pointMistakes) wins over the dot of a pending update suggestion, which wins over ✓ (读完). Pure, no React, no DOM. */
import { bookRows } from './model.js';

/** -> { kind: 'mistakes', count } | { kind: 'suggestion' } | { kind: 'read' } | null */
export const markOf = ({ mistakes = 0, suggestion = false, read = false } = {}) => (mistakes > 0 ? { kind: 'mistakes', count: mistakes }
  : suggestion ? { kind: 'suggestion' } : read ? { kind: 'read' } : null);

/** The mark of every point of the book: Map<heading id, mark> (points without a mark left out). mistakes: pointMistakes(book); read: Set of the points 读完. */
export function tocMarks(book, mistakes, read) {
  const out = new Map();
  if (book?.status !== 'ok') return out;
  for (const row of bookRows(book.nodes)) {
    if (!row.leaf) continue;
    const mark = markOf({ mistakes: mistakes?.get(row.hid)?.length ?? 0, suggestion: (book.files?.[row.node.files?.gen]?.suggestions?.length ?? 0) > 0, read: !!read?.has(row.hid) });
    if (mark) out.set(row.hid, mark);
  }
  return out;
}
