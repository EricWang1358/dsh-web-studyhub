import { useCallback, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { ui, errorMessage } from '../i18n.js';
import { useLiveEffect } from '../use-async.js';
import { localDate } from '../../lib/board-model.js';
import { goneSet, rowOf } from './model.js';
import { STRUCTURE_DONE, structureFailureText } from './book-structure.js';
import { STRUCTURE_FILE } from '../../lib/course-book-own-titles.js';
import { UNDO_TIMEOUT } from '../undoable.js';
import { showBlock, showWords } from './ai-anchors.js';
import { bookStartedText } from '../outline/words.js';

/* What the review book page does besides placing the reader (ui/book/BookPage.jsx): the 期末一周 plan, the 备考计划, the export's page estimate, the handlers every
   point reads, and the book's structure (改名 / 移动到… / 删除这个知识点…, one compare-and-set write each; ui/book/BookStructure.jsx). The AI tasks and
   deletions they start are ui/book/use-book-ai.js. */

/** 生成复习全书 on a course without a book: act() asked to rethrow says nothing itself (ui/act-runner.js), so a refused start is said here. */
export async function startBookBuild({ act, course, notify }) {
  try { await act('generation.courseBook.build', { course }, result => notify({ text: bookStartedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true }); }
  catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
}

/** 期末一周 (M7, book.crunch): the plan of the course's last days, asked again when the book changes or a mark is set. -> { crunch, day, points, mark }. */
export function useBookCrunch({ call, course, book, notify }) {
  const [crunch, setCrunch] = useState(null);
  useLiveEffect(isLive => {
    if (book?.status !== 'ok' || !book.notes) return;
    call('book.crunch', { course, date: localDate() }).then(next => { if (isLive()) setCrunch(next); }, () => { if (isLive()) setCrunch({ status: 'error' }); });
  }, [call, course, book?.revision, book?.status, book?.notes]);
  const day = crunch?.status === 'ok' ? crunch.plan.today : null;
  const points = useMemo(() => { const byId = new Map((crunch?.points || []).map(point => [point.id, point])); return (day?.points || []).map(id => byId.get(id)).filter(Boolean); }, [crunch, day]);
  // 读完了 / 已看 (book.crunch.mark): kept per course in the book's record; the answer is the plan again.
  const mark = useCallback(async (hid, kind, on) => {
    try { setCrunch(await call('book.crunch.mark', { course, hid, kind, on, date: localDate() })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, notify]);
  return { crunch, day, points, mark };
}

/** 备考计划 (course.plan, lib/course-plan.js): the course's whole-period plan, asked again when the book or the library changes (a plan agreed in the chat, an exam date,
    answers: `revision` is the snapshot's) or when 刷新 is pressed; the program makes it again from what was done, no model call. -> { answer, refresh }; answer: null
    until the first answer, { status: 'error' } when it could not be asked. */
export function useCoursePlan({ call, course, book, revision }) {
  const [answer, setAnswer] = useState(null), [ticket, setTicket] = useState(0);
  useLiveEffect(isLive => {
    if (book?.status !== 'ok' || !book.notes || !course) return;
    call('course.plan', { course, date: localDate() }).then(next => { if (isLive()) setAnswer(next); }, () => { if (isLive()) setAnswer({ status: 'error' }); });
  }, [call, course, book?.revision, book?.status, book?.notes, revision, ticket]);
  const refresh = useCallback(() => setTicket(value => value + 1), []);
  return { answer, refresh };
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

/** Copies text to the clipboard; false when the browser refused. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** The handlers every point reads (ui/book/PointBody.jsx and below). ai: the stable ctions of ui/book/use-book-ai.js (the lines themselves reach the points
    through BookAiContext, so a line or the 问 AI panel never gives every point new handlers). */
export function useBookHandlers({ call, course, notify, book, setBook, rows, reload, remember, onPractice, onCreate, onOpenSource, ai, foldAi, onPlace }) {
  const [qa, setQa] = useState(() => new Set());
  const [choosing, setChoosing] = useState(false);
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
        if (!scope.length) { notify(ui('这个知识点还没有题。先到「创建题组」从资料出题。')); return; }
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
    // 改名 / 移动到… / 删除这个知识点… (ui/book/BookStructure.jsx): course.book.rename / move / delete, compare-and-set on the structureVersion the book has
    // now, the whole book back in one round trip. A stale version is said and the book read again, so the dialog keeps what was typed (never lost silently).
    structure: async (action, args) => {
      try {
        const next = await call(action, { course, ...args, version: book.structureVersion, answer: 'book' });
        setBook(next);
        // 放回 can be taken back at once: both files, in one undo (lib/course-book-structure.js placeUnplacedSection).
        const takeBack = async () => {
          try { setBook(await call('course.book.revert', { course, file: STRUCTURE_FILE, version: next.structureVersion, answer: 'book' })); notify({ text: ui('已撤销'), tone: 'success' }); }
          catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); reload(); }
        };
        notify({ text: ui(STRUCTURE_DONE[action]), tone: 'success', ...(action === 'course.book.place' ? { undo: true, timeout: UNDO_TIMEOUT, action: { label: ui('撤销'), onClick: takeBack } } : {}) });
        return { ok: true, book: next };
      } catch (failure) {
        if (failure?.code === 'course-book-conflict') { notify({ text: structureFailureText(failure), tone: 'error' }); reload(); }
        return { ok: false, failure };
      }
    },
    // 未归位's sections and 放回… (ui/book/BookChapter.jsx UnplacedBody, ui/book/BookStructure.jsx PlaceDialog).
    unplacedSections: book?.unplaced?.sections,
    place: onPlace,
    // 问 AI at a point's title (ui/book/BookAsk.jsx); 保留 / 重新生成 / 复制 / 删除 / 接着问 of an AI block; the lines tasks and deletions leave (ui/book/use-book-ai.js).
    ask: (node, element) => ai.openAsk({ heading: node.hid, anchor: element }),
    aiAction: async (node, action, block) => {
      if (action === 'again') {
        ai.start({ heading: node.hid, mode: block.mode === 'follow' ? 'follow' : block.mode, ...(block.mode !== 'here' ? { words: block.about } : {}),
          ...(block.ask ? { instruction: block.ask } : {}), replace: block.id });
        return;
      }
      if (action === 'delete') { ai.remove(node, block); return; }
      if (action === 'copy') { notify(await copyText(block.body) ? ui('已复制') : { text: ui('没能复制：浏览器不让写剪贴板'), tone: 'error' }); return; }
      setChoosing(true);
      try { setBook(await call('course.book.block', { course, file: node.files.mine, id: block.id, action })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
      finally { setChoosing(false); }
    },
    aiFollow: (node, block, question) => ai.start({ heading: node.hid, mode: 'follow', words: block.about || node.title, instruction: question, after: block.id }),
    aiCancel: ai.cancel, aiRetry: ai.retry, aiDismiss: ai.dismiss, aiUndo: ai.restore, aiForget: ai.forget,
    // The fold of the blocks (kept in this browser), and the two ways between a block and its dashed words (ui/book/ai-anchors.js): open the block, then show it.
    aiOpen: id => { flushSync(() => foldAi(id, false)); showBlock(id); },
    aiWords: id => showWords(id),
  }), [book, qa, rows, call, course, notify, onCreate, onOpenSource, onPractice, remember, choosing, setBook, ai, foldAi, reload, onPlace]);
}
