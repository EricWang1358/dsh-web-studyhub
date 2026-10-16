import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ui, errorMessage } from '../i18n.js';
import { useLiveEffect } from '../use-async.js';
import { usePolling } from '../use-polling.js';
import { isActiveJob } from '../../lib/job-status.js';
import { localDate } from '../../lib/board-model.js';
import { goneSet, rowOf } from './model.js';
import { showBlock, showWords } from './ai-anchors.js';
import { bookStartedText } from '../outline/words.js';

/* What the review book page does besides placing the reader (ui/book/BookPage.jsx): the 期末一周 plan, the export's page estimate, the AI tasks started on the
   page (弄懂 / 加一段 / 接着问) and the handlers every point reads. */

/** 生成复习全书 on a course without a book: act() asked to rethrow says nothing itself (ui/act-runner.js), so a refused start is said here. */
export async function startBookBuild({ act, course, notify }) {
  try { await act('generation.courseBook.build', { course }, result => notify({ text: bookStartedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true }); }
  catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
}

/** 期末一周 (M7, book.crunch): the plan of the course's last days, asked again when the book changes or a mark is set.
    -> { crunch, day, points, mark(hid, kind, on) -> marked?, ready, today: { ids, count, done, flip } | null, read: Set, seen: Set }: `today` only inside the
    期末一周 (a learn or 翻看 day with points); read / seen: the points 读完 / 已看, the plan's once it answered (`ready`), the book's own marks until then. */
export function useBookCrunch({ call, course, book, notify }) {
  const [crunch, setCrunch] = useState(null);
  const latest = useRef(null);
  latest.current = crunch;
  // Asked at once, beside course.book.open (the page waits for both inside the 期末一周), and again when the book's revision moves past the plan's.
  useLiveEffect(isLive => {
    if (book && (book.status !== 'ok' || !book.notes)) return;
    if (book && latest.current?.revision === book.revision) return;
    call('book.crunch', { course, date: localDate() }).then(next => { if (isLive()) setCrunch(next); }, () => { if (isLive()) setCrunch({ status: 'error' }); });
  }, [call, course, book?.revision, book?.status, book?.notes]);
  const day = crunch?.status === 'ok' ? crunch.plan.today : null;
  const points = useMemo(() => { const byId = new Map((crunch?.points || []).map(point => [point.id, point])); return (day?.points || []).map(id => byId.get(id)).filter(Boolean); }, [crunch, day]);
  // 读完了 / 已看 (book.crunch.mark): kept per course in the book's record; the answer is the plan again.
  const mark = useCallback(async (hid, kind, on) => {
    try { setCrunch(await call('book.crunch.mark', { course, hid, kind, on, date: localDate() })); return true; } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); return false; }
  }, [call, course, notify]);
  const marks = book?.marks;
  const status = useMemo(() => {
    const known = Array.isArray(crunch?.points) ? crunch.points : null;
    const of = kind => new Set(known ? known.filter(point => point[kind === 'read' ? 'done' : 'seen']).map(point => point.id) : Object.keys(marks?.[kind] || {}));
    const today = day && (day.mode === 'learn' || day.mode === 'flip') && day.points.length ? { ids: day.points, count: day.points.length, done: day.done.length, flip: day.mode === 'flip' } : null;
    return { ready: crunch !== null, today, read: of('read'), seen: of('seen') };
  }, [crunch, day, marks]);
  return { crunch, day, points, mark, ...status };
}

/** 导出's estimate against the page limit (settings.book.pageLimit): the A4 pages of the book, or null until known (and without a book). */
export function useBookPages({ call, course, book }) {
  const [pages, setPages] = useState(null);
  useLiveEffect(isLive => {
    if (book?.status !== 'ok' || !book.notes) { setPages(null); return; }
    call('course.book.export', { course, estimateOnly: true }).then(done => { if (isLive()) setPages(done?.estimate?.book ?? null); }, () => {});
  }, [call, course, book?.revision, book?.status, book?.notes]);
  return pages;
}

/** The AI tasks started on the page: the panel over selected words (or a heading), the tasks running, and the book read again when one ends.
    -> { ask, setAsk, closeAsk, startAi, onSelect }. */
export function useBookAi({ call, course, notify, reload, expectBlock }) {
  const [ask, setAsk] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  // `fromPanel`: started from the panel over selected words, which stays showing its state until the block appears (the one under a heading closes now).
  const startAi = useCallback(async (args, fromPanel = false) => {
    try {
      const started = await call('generation.courseBook.explain', { course, ...args });
      setPending(current => new Set([...current, started.jobId]));
      notify({ text: ui('已开始：写好后会出现在这一节里；任务页可以看进度。'), tone: 'success' });
      setAsk(current => (fromPanel && current?.words ? { ...current, jobId: started.jobId } : null));
      window.getSelection?.()?.removeAllRanges?.();
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, notify]);
  // The panel of a task closes when the task is over (its block is in the book, or the failure said).
  useEffect(() => { if (ask?.jobId && !pending.has(ask.jobId)) setAsk(null); }, [ask, pending]);
  const closeAsk = useCallback(() => setAsk(null), []);
  // A task started here is looked at now and then (job.status) until it ends; then the book is read again, its block in place.
  usePolling(async () => {
    for (const jobId of pending) {
      let job;
      try { job = await call('job.status', { jobId }); } catch { continue; }
      const status = job?.status ?? job?.contract?.status;
      if (!status || isActiveJob({ status })) continue;
      setPending(current => { const next = new Set(current); next.delete(jobId); return next; });
      if (status === 'failed') notify({ text: job?.error?.message || job?.contract?.error?.message || ui('没有写成，可以在任务页重试。'), tone: 'error' });
      else expectBlock();
      reload();
    }
  }, { intervalMs: 1500, enabled: pending.size > 0 });
  // Words selected in a point's text open the panel under them.
  const onSelect = useCallback(() => {
    const selection = window.getSelection?.(), words = selection?.toString().replace(/\s+/g, ' ').trim();
    if (!words || words.length < 2 || !selection.rangeCount) return;
    const point = (selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement)?.closest?.('[data-book-point]');
    if (!point) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setAsk({ heading: point.dataset.bookPoint, words: words.slice(0, 600), top: rect.bottom + 6, left: rect.left });
  }, []);
  return { ask, setAsk, closeAsk, startAi, onSelect };
}

/** The handlers every point reads (ui/book/PointBody.jsx and below). */
export function useBookHandlers({ call, course, notify, book, setBook, rows, reload, remember, onPractice, onCreate, onOpenSource, ai, foldAi }) {
  const [qa, setQa] = useState(() => new Set());
  const [choosing, setChoosing] = useState(false);
  const { startAi, setAsk } = ai;
  return useMemo(() => ({
    gone: goneSet(book?.missing),
    qaOpen: heading => qa.has(heading),
    toggleQa: heading => setQa(current => { const next = new Set(current); if (next.has(heading)) next.delete(heading); else next.add(heading); return next; }),
    source: (sourceId, quote) => onOpenSource?.(sourceId, quote),
    card: (ref, from, element) => { const place = remember(from, element); onPractice([ref], { resume: true, place }); },
    // 练 N 道: the next N of the point's questions in a practice round's order (due, weak, new); an open round of exactly those goes on.
    practice: async (heading, n, from, element) => {
      const row = rowOf(rows, heading);
      if (!row) { notify(ui('这一节已不在总纲里。')); return; }
      try {
        const { practice } = await call('course.outline', { course, pick: { keys: [row.key] } });
        const scope = practice?.scope.slice(0, n) || [];
        if (!scope.length) { notify(ui('还没出题')); return; }
        onPractice(scope, { resume: true, place: remember(from, element) });
      } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    },
    create: onCreate,
    reload,
    files: book?.files,
    busy: choosing,
    // 采用 / 忽略 of a file's suggestion, compare-and-set on the version shown.
    choose: async (name, action, id) => {
      setChoosing(true);
      try { setBook(await call('course.book.suggestion', { course, file: name, action, id, version: book.files[name].version })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
      finally { setChoosing(false); }
    },
    // 弄懂 / 加一段 (M4): 「在这里加一段」 on a point; 保留 / 删除 / 重新生成 / 接着问 of an AI block.
    addHere: (node, element) => { const rect = element.getBoundingClientRect(); setAsk({ heading: node.hid, top: rect.bottom + 6, left: rect.left }); },
    aiAction: async (node, action, block) => {
      if (action === 'again') {
        startAi({ heading: node.hid, mode: block.mode === 'follow' ? 'follow' : block.mode, ...(block.mode !== 'here' ? { words: block.about } : {}),
          ...(block.ask ? { instruction: block.ask } : {}), replace: block.id });
        return;
      }
      setChoosing(true);
      try { setBook(await call('course.book.block', { course, file: node.files.mine, id: block.id, action })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
      finally { setChoosing(false); }
    },
    aiFollow: (node, block, question) => startAi({ heading: node.hid, mode: 'follow', words: block.about || node.title, instruction: question, after: block.id }),
    // The fold of the blocks (kept in this browser), and the two ways between a block and its dashed words (ui/book/ai-anchors.js): open the block, then show it.
    aiOpen: id => { flushSync(() => foldAi(id, false)); showBlock(id); },
    aiWords: id => showWords(id),
  }), [book, qa, rows, call, course, notify, onCreate, onOpenSource, onPractice, remember, choosing, setBook, startAi, setAsk, foldAi, reload]);
}
