import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ui, errorMessage } from '../i18n.js';
import { usePolling } from '../use-polling.js';
import { isActiveJob } from '../../lib/job-status.js';
import { aiBlocks } from '../../lib/course-book-ai-text.js';
import { showBlock } from './ai-anchors.js';

/* The AI tasks and deletions of the review book page (docs/review-book.md "AI blocks"), written so the page never jumps: a task started from 问 AI or the
   selection toolbar closes the panel at once and leaves ONE line where its block will go (ui/book/ai-lines.js): 「AI 正在写 · 约 1 分钟 · 取消」; the block
   that lands takes that line's place, folded, with a short highlight (the reader is never scrolled; on another point a toast 「写好了 · 去看」 goes there); a
   failure stands in the same place with the reason and 重试. A deleted block leaves 「已删除这段 · 撤销」 for 8 seconds; 撤销 is course.book.revert with the
   version the delete left, so only the latest deletion comes back (a write since refuses it). No start toast: the line is the feedback. */

export const UNDO_MS = 8000;
const LANDED_MS = 1600;
let made = 0;

const inView = element => { const box = element.getBoundingClientRect(); return box.bottom > 0 && box.top < window.innerHeight; };
const blockElement = id => [...document.querySelectorAll('[data-ai-block]')].find(element => element.dataset.aiBlock === id) || null;

/** A short highlight on a block that landed (opacity only, drawn by book-ai.css; none with reduced motion). */
function markLanded(id) {
  const element = blockElement(id);
  if (!element) return false;
  element.setAttribute('data-ai-landed', '');
  setTimeout(() => element.removeAttribute('data-ai-landed'), LANDED_MS);
  return inView(element);
}

/** The book's point and title of a heading (for the line and the toast). */
const pointOf = (rows, hid) => rows.find(row => row.hid === hid)?.node ?? null;

/**
 * -> { lines (every line of the page), ask, openAsk(target), closeAsk(), start(args), cancel(line), retry(line), dismiss(line), remove(node, block), restore() }.
 * `args` of start: { heading, mode: explain | write | here | follow, words?, instruction?, after?, replace? } (generation.courseBook.explain). `target` of the
 * panel: { heading, words?, anchor (an element, or { getClientRects } of a selection) }. setBook: the page's book (the delete's and the 撤销's answers).
 */
export function useBookAi({ call, course, notify, reload, book, setBook, rows, aiFold, goTo }) {
  const [lines, setLines] = useState([]), [undo, setUndo] = useState(null), [ask, setAsk] = useState(null);
  // The blocks that landed on this page: their folded row keeps one line (as high as the line was, book-ai.css) until the page is opened again.
  const [fresh, setFresh] = useState(() => new Set());
  const latest = useRef({});
  latest.current = { book, rows, aiFold, goTo, notify };
  const edit = useCallback((key, change) => setLines(current => current.flatMap(line => (line.key !== key ? [line] : change ? [{ ...line, ...change(line) }] : []))), []);
  const start = useCallback(async args => {
    setAsk(null);
    window.getSelection?.()?.removeAllRanges?.();
    const node = pointOf(latest.current.rows, args.heading), key = `line-${made += 1}`;
    // The line is there at once (its place does not depend on the task's id), so the page answers the press before the host does.
    setLines(current => [...current, { key, kind: 'writing', id: key, heading: args.heading, mode: args.mode, words: args.words ?? '', title: node?.title ?? '', after: args.after ?? null,
      replace: args.replace ?? null, args }]);
    try {
      const started = await call('generation.courseBook.explain', { course, ...args });
      edit(key, () => ({ id: started.blockId || key, jobId: started.jobId }));
    } catch (failure) { edit(key, () => ({ kind: 'failed', error: errorMessage(failure) })); }
  }, [call, course, edit]);
  const cancel = useCallback(async line => {
    edit(line.key, null);
    if (line.jobId) { try { await call('job.cancel', { jobId: line.jobId }); } catch { /* it had ended */ } }
  }, [call, edit]);
  const retry = useCallback(line => { edit(line.key, null); start(line.args); }, [edit, start]);
  const dismiss = useCallback(line => edit(line.key, null), [edit]);
  // A task started here is looked at now and then (job.status) until it ends; then the book is read again and its block takes the line's place.
  const running = lines.filter(line => line.kind === 'writing' && line.jobId);
  usePolling(async () => {
    for (const line of running) {
      let job;
      try { job = await call('job.status', { jobId: line.jobId }); } catch { continue; }
      const status = job?.status ?? job?.contract?.status;
      if (!status || isActiveJob({ status })) continue;
      if (status === 'failed') edit(line.key, () => ({ kind: 'failed', error: job?.error?.message || job?.contract?.error?.message || ui('没有写成。') }));
      else if (status === 'cancelled') edit(line.key, null);
      else { edit(line.key, () => ({ kind: 'done', revision: latest.current.book?.revision ?? 0 })); reload(); }
    }
  }, { intervalMs: 1500, enabled: running.length > 0 });
  // A task that ended is shown once the book read after it is here: its block, drawn folded in the line's place (ui/book/ai-lines.js `landed`, so it stands
  // as high as the line did), that fold kept, and a short highlight. A new block is folded; one written again (重新生成) keeps the learner's fold.
  // A new block already in the book (read again meanwhile for another reason) lands at once; a block written again waits for the book read after its end.
  useLayoutEffect(() => {
    const has = line => aiBlocks(pointOf(latest.current.rows, line.heading)?.mine).some(block => block.id === line.id);
    const ended = lines.filter(line => line.kind === 'done' && ((!line.replace && has(line)) || (book?.revision ?? 0) > line.revision));
    if (!ended.length) return;
    const written = ended.filter(has), landed = written.filter(line => !line.replace).map(line => line.id);
    landed.forEach(id => latest.current.aiFold?.fold(id, true));
    if (landed.length) setFresh(current => new Set([...current, ...landed]));
    setLines(current => current.filter(line => !ended.includes(line)));
    for (const line of written) {
      if (markLanded(line.id)) continue;
      latest.current.notify({ text: ui('AI 段落写好了'), tone: 'success', action: { label: ui('去看'), onClick: () => {
        latest.current.goTo?.(line.heading);
        setTimeout(() => { flushSync(() => latest.current.aiFold?.fold(line.id, false)); showBlock(line.id); }, 120);
      } } });
    }
  }, [book, lines]); // eslint-disable-line react-hooks/exhaustive-deps
  // 删除: the block goes, a line says so for 8 seconds; 撤销 takes it back only while nothing else was written to the file.
  const remove = useCallback(async (node, block) => {
    const file = node.files.mine, index = aiBlocks(node.mine).findIndex(item => item.id === block.id);
    try {
      const view = await call('course.book.block', { course, file, id: block.id, action: 'delete' });
      setBook(view);
      setUndo({ key: `undo-${block.id}`, kind: 'undo', id: block.id, heading: node.hid, index, block, file, version: view?.files?.[file]?.version });
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, notify, setBook]);
  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo(current => (current === undo ? null : current)), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);
  const restore = useCallback(async () => {
    const was = undo;
    if (!was) return;
    setUndo(null);
    try { setBook(await call('course.book.revert', { course, file: was.file, version: was.version })); } catch (failure) {
      notify({ text: failure?.code === 'course-book-conflict' ? ui('这段删除之后书又改过了，没法撤销。') : errorMessage(failure), tone: 'error' });
    }
  }, [undo, call, course, notify, setBook]);
  const all = useMemo(() => (undo ? [...lines, undo] : lines), [lines, undo]);
  // A second press on the same 问 AI closes its panel.
  const openAsk = useCallback(target => setAsk(current => (current && !current.words && !target.words && current.heading === target.heading ? null : target)), []);
  const closeAsk = useCallback(() => setAsk(null), []);
  return useMemo(() => ({ lines: all, fresh, ask, openAsk, closeAsk, start, cancel, retry, dismiss, remove, restore }), [all, fresh, ask, openAsk, closeAsk, start, cancel, retry, dismiss, remove, restore]);
}
