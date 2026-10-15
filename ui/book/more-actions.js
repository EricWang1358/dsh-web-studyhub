import { useCallback, useMemo } from 'react';
import { ui } from '../i18n.js';
import { aiBlocks } from '../../lib/course-book-ai-text.js';
import { foldsByDefault } from './point-parts.js';
import { pointCode } from './model.js';

/* What each item of 「⋯ 更多」 (ui/book/BookMore.jsx) does on the review book page, and the fold state its two AI items name (收起 or 展开). */

const blocksOf = node => (node && node.hid !== 'unplaced' ? aiBlocks(node.mine) : []);
const allBlocks = book => (book?.status === 'ok' ? (function walk(list) { return (list || []).flatMap(node => (node.leaf ? blocksOf(node) : walk(node.children))); })(book.nodes) : []);

/** Copies text to the clipboard; false when the browser refused. */
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** -> { select(id), pointFold: { folded } | null, bookFold: { folded } | null }. step: the point being read (ui/book/reading.js bookSteps). */
export function useMoreActions({ step, course, book, notify, aiFold, reading, where, setView, setDialog, setTodayOpen, onCreate, onCourseSettings, courseRecord }) {
  const pointBlocks = useMemo(() => blocksOf(step?.node), [step]);
  const bookBlocks = useMemo(() => allBlocks(book), [book]);
  const folded = blocks => blocks.every(block => aiFold.folded(block.id, foldsByDefault(block)));
  const pointFold = pointBlocks.length ? { folded: folded(pointBlocks) } : null, bookFold = bookBlocks.length ? { folded: folded(bookBlocks) } : null;
  const select = useCallback(async id => {
    if (id === 'edit') setView('edit');
    else if (id === 'create') onCreate?.();
    else if (id === 'code' && step) notify(await copy(pointCode(step.node, course)) ? ui('已复制') : { text: ui('没能复制：浏览器不让写剪贴板'), tone: 'error' });
    else if (id === 'fold-point') aiFold.foldAll(pointBlocks.map(block => block.id), !pointFold?.folded);
    else if (id === 'fold-book') aiFold.foldAll(bookBlocks.map(block => block.id), !bookFold?.folded);
    else if (id === 'scroll') where.switchReading(reading.mode === 'scroll' ? 'step' : 'scroll');
    else if (id === 'flip') setView('flip');
    else if (id === 'today') setTodayOpen(value => !value);
    else if (id === 'exam-date' || id === 'settings') onCourseSettings?.(courseRecord?.id);
    else setDialog(id);
  }, [step, course, notify, aiFold, pointBlocks, bookBlocks, pointFold, bookFold, where, reading.mode, setView, setDialog, setTodayOpen, onCreate, onCourseSettings, courseRecord]);
  return { select, pointFold, bookFold };
}
