import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ui, errorMessage } from '../i18n.js';
import { usePolling } from '../use-polling.js';
import { isActiveJob } from '../../lib/job-status.js';
import { aiBlocks } from '../../lib/course-book-ai-text.js';
import { showBlock } from './ai-anchors.js';
import { deletedLine } from './ai-lines.js';

/* The AI tasks and deletions of the review book page (docs/review-book.md "AI blocks"), written so the page never jumps: a task started from 问 AI or the
   selection toolbar closes the panel at once and leaves ONE line where its block will go (ui/book/ai-lines.js): 「AI 正在写 · 约 1 分钟 · 取消」; the block
   that lands takes that line's place, folded, with a short highlight (the reader is never scrolled; on another point a toast 「写好了 · 去看」 goes there); a
   failure stands in the same place with the reason and 重试. A deleted block leaves 「已删除这段 · 撤销」 for 8 seconds, then the line fades out and keeps its
   room until it is off screen or the book is read again (nothing below moves by itself); 撤销 is course.book.revert with the version the delete left, so only
   the latest deletion comes back (a write since refuses it), and a block that was already gone leaves no 撤销 at all. No start toast: the line is the feedback. */

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
/** The raw text of a block of a point's own file (a 重新生成 has ended once its block's text is not the one it started from). */
const rawOf = (rows, heading, id) => aiBlocks(pointOf(rows, heading)?.mine).find(block => block.id === id)?.raw ?? null;

/**
 * -> { lines (every line of the page), ask, actions }. `actions` never changes identity (the points' handlers hold it, so a line or the panel re-renders no
 * point's text): { openAsk(target), closeAsk(), start(args), cancel(line), retry(line), dismiss(line), remove(node, block), restore(), forget(line) }.
 * `args` of start: { heading, mode: explain | write | here | follow, words?, instruction?, after?, replace? } (generation.courseBook.explain). `target` of the
 * panel: { heading, words?, anchor (an element, or { getClientRects } of a selection) }. setBook: the page's book (the delete's and the 撤销's answers).
 */
export function useBookAi({ call, course, notify, reload, book, setBook, rows, aiFold, goTo }) {
  const [lines, setLines] = useState([]), [undo, setUndo] = useState(null), [ask, setAsk] = useState(null);
  const latest = useRef({}), undoRef = useRef(null);
  // The tasks' ids by line (a 取消 pressed before the host answered stops the task as soon as its id is known).
  const jobs = useRef(new Map()), cancelled = useRef(new Set());
  latest.current = { book, rows, aiFold, goTo, notify, setBook };
  undoRef.current = undo;
  const edit = useCallback((key, change) => setLines(current => current.flatMap(line => (line.key !== key ? [line] : change ? [{ ...line, ...change(line) }] : []))), []);
  const stop = useCallback(async jobId => { try { await call('job.cancel', { jobId }); } catch { /* it had ended */ } }, [call]);
  const start = useCallback(async args => {
    setAsk(null);
    window.getSelection?.()?.removeAllRanges?.();
    const now = latest.current.rows, node = pointOf(now, args.heading), key = `line-${made += 1}`;
    // The line is there at once (its place does not depend on the task's id), so the page answers the press before the host does. (重新生成) The block's
    // text at the start tells later that the new one has been read.
    setLines(current => [...current, { key, kind: 'writing', id: key, heading: args.heading, mode: args.mode, words: args.words ?? '', title: node?.title ?? '', after: args.after ?? null,
      replace: args.replace ?? null, was: args.replace ? rawOf(now, args.heading, args.replace) : null, args }]);
    try {
      const started = await call('generation.courseBook.explain', { course, ...args });
      jobs.current.set(key, started.jobId);
      if (cancelled.current.delete(key)) { if (started.jobId) stop(started.jobId); return; }
      edit(key, () => ({ id: started.blockId || key, jobId: started.jobId }));
    } catch (failure) { if (!cancelled.current.delete(key)) edit(key, () => ({ kind: 'failed', error: errorMessage(failure) })); }
  }, [call, course, edit, stop]);
  const cancel = useCallback(line => {
    edit(line.key, null);
    const jobId = line.jobId || jobs.current.get(line.key);
    if (jobId) stop(jobId);
    else cancelled.current.add(line.key);
  }, [edit, stop]);
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
      // The book shown when the end was seen: any book read after it (the one asked for here, or one read meanwhile for another reason) holds the write.
      else { edit(line.key, () => ({ kind: 'done', seenOn: latest.current.book })); reload(); }
    }
  }, { intervalMs: 1500, enabled: running.length > 0 });
  // A task that ended is shown once the book read after it is here: its block, drawn folded in the line's place (ui/book/ai-lines.js `landed`, so it stands
  // as high as the line did), that fold kept, and a short highlight. A new block is folded; one written again (重新生成) keeps the learner's fold.
  // A new block in the book, or a block written again whose text is not the one it started from, has landed (whichever read of the book brought it); else the
  // first book read after the end was seen ends the line (a task that wrote nothing, or a 重新生成 that wrote the same text).
  useLayoutEffect(() => {
    const now = latest.current.rows, has = line => aiBlocks(pointOf(now, line.heading)?.mine).some(block => block.id === line.id);
    const arrived = line => has(line) && (!line.replace || rawOf(now, line.heading, line.replace) !== line.was);
    const ended = lines.filter(line => line.kind === 'done' && (arrived(line) || book !== line.seenOn));
    if (!ended.length) return;
    const written = ended.filter(has), landed = written.filter(line => !line.replace).map(line => line.id);
    landed.forEach(id => latest.current.aiFold?.fold(id, true));
    setLines(current => current.filter(line => !ended.includes(line)));
    for (const line of written) {
      if (markLanded(line.id)) continue;
      latest.current.notify({ text: ui('AI 段落写好了'), tone: 'success', action: { label: ui('去看'), onClick: () => {
        latest.current.goTo?.(line.heading);
        setTimeout(() => { flushSync(() => latest.current.aiFold?.fold(line.id, false)); showBlock(line.id); }, 120);
      } } });
    }
  }, [book, lines]);
  // 删除: the block goes, a line says so for 8 seconds; 撤销 takes it back only while nothing else was written to the file. A block another writer had taken out
  // already ('unchanged') is only said: there is nothing of this page's to take back.
  const remove = useCallback(async (node, block) => {
    try {
      const view = await call('course.book.block', { course, file: node.files.mine, id: block.id, action: 'delete' });
      latest.current.setBook(view);
      const line = deletedLine(view, node, block);
      if (line) setUndo(line);
      else latest.current.notify(ui('这段已经不在书里了'));
    } catch (failure) { latest.current.notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course]);
  // After 8 seconds the line fades out and keeps its room (BookAiLine drops it once it is off screen); the next book read drops it too.
  useEffect(() => {
    if (!undo || undo.faded) return undefined;
    const timer = setTimeout(() => setUndo(current => (current === undo ? { ...current, faded: true } : current)), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);
  useEffect(() => { setUndo(current => (current?.faded ? null : current)); }, [book]);
  const forget = useCallback(line => setUndo(current => (current && current.key === line.key && current.faded ? null : current)), []);
  const restore = useCallback(async () => {
    const was = undoRef.current;
    if (!was || was.faded) return;
    setUndo(null);
    try { latest.current.setBook(await call('course.book.revert', { course, file: was.file, version: was.version })); } catch (failure) {
      latest.current.notify({ text: failure?.code === 'course-book-conflict' ? ui('这段删除之后书又改过了，没法撤销。') : errorMessage(failure), tone: 'error' });
    }
  }, [call, course]);
  const all = useMemo(() => (undo ? [...lines, undo] : lines), [lines, undo]);
  // A second press on the same 问 AI closes its panel.
  const openAsk = useCallback(target => setAsk(current => (current && !current.words && !target.words && current.heading === target.heading ? null : target)), []);
  const closeAsk = useCallback(() => setAsk(null), []);
  const actions = useMemo(() => ({ openAsk, closeAsk, start, cancel, retry, dismiss, remove, restore, forget }), [openAsk, closeAsk, start, cancel, retry, dismiss, remove, restore, forget]);
  return useMemo(() => ({ lines: all, ask, actions, ...actions }), [all, ask, actions]);
}
