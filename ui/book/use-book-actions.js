import { useCallback, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { useLiveEffect } from '../use-async.js';
import { localDate } from '../../lib/board-model.js';
import { goneSet, rowOf } from './model.js';
import { STRUCTURE_DONE, structureFailureText } from './book-structure.js';
import { STRUCTURE_FILE } from '../../lib/course-book-own-titles.js';
import { UNDO_TIMEOUT } from '../undoable.js';
import { showBlock, showWords } from './ai-anchors.js';
import { cardShown, showCard } from './term-card-go.js';
import { bookStartedText, readMoreStartedText } from '../outline/words.js';
import { resolveBookGapHint } from '../evidence-hint.js';
import { findPointCompanion, openCompanionTarget } from '../companions/companion-ref.js';
import { rescueGate } from '../wrongbook-model.js';

/* What the review book page does besides placing the reader (ui/book/BookPage.jsx): the 期末一周 plan, the 备考计划, the export's page estimate, the handlers every
   point reads, and the book's structure (改名 / 移动到… / 删除这个知识点…, one compare-and-set write each; ui/book/BookStructure.jsx). The AI tasks and
   deletions they start are ui/book/use-book-ai.js. */

/** 生成复习全书 on a course without a book (or, with `extra` { sample: 'confirm' }, the rest of a waiting sample, #710): act() asked to rethrow says nothing itself
    (ui/act-runner.js), so a refused start is said here. */
export async function startBookBuild({ act, course, notify, extra = {} }) {
  try { await act('generation.courseBook.build', { course, ...extra }, result => notify({ text: bookStartedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true }); }
  catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
}

/** 补这些知识点 from the Review Book: starts a course-level point top-up into a new reviewed draft, surfacing refusals clearly. */
export async function startCoursePointTopUp({ act, course, courseName, pointIds, notify, options = {} }) {
  if (!Array.isArray(pointIds) || !pointIds.length) return null;
  const label = options.label || courseName || course || ui('未分类课程');
  const title = options.title || uiFormat('{0} · 补知识点', [label]);
  const fallbackNotice = (name, started) => uiFormat('已开始为「{0}」补 {1} 个知识点，约 {2} 题；通过检查后会保存为新草稿。',
    [name, pointIds.length, started?.coverage?.questions ?? options.questions ?? pointIds.length]);
  try {
    return await act('generate', { course, title, coverage: { pointIds } },
      started => notify({ text: (options.notice ?? fallbackNotice)(label, started), tone: 'success' }),
      { rethrow: true });
  } catch (failure) {
    notify({ text: errorMessage(failure), tone: 'error' });
    return null;
  }
}

/** 期末一周 (M7, book.crunch): the plan of the course's last days, asked again when the book changes or a mark is set. -> { crunch, day, points, mark }. */
export function useBookCrunch({ call, course, book, notify }) {
  const [crunch, setCrunch] = useState(null);
  const [ticket, setTicket] = useState(0);
  useLiveEffect(isLive => {
    if (book?.status !== 'ok' || !book.notes) return;
    call('book.crunch', { course, date: localDate() }).then(next => { if (isLive()) setCrunch(next); }, () => { if (isLive()) setCrunch({ status: 'error' }); });
  }, [call, course, book?.revision, book?.status, book?.notes, ticket]);
  const refresh = useCallback(() => setTicket(value => value + 1), []);
  const day = crunch?.status === 'ok' ? crunch.plan.today : null;
  const points = useMemo(() => { const byId = new Map((crunch?.points || []).map(point => [point.id, point])); return (day?.points || []).map(id => byId.get(id)).filter(Boolean); }, [crunch, day]);
  // 读完了 / 已看 (book.crunch.mark): kept per course in the book's record; the answer is the plan again.
  const mark = useCallback(async (hid, kind, on) => {
    try { setCrunch(await call('book.crunch.mark', { course, hid, kind, on, date: localDate() })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, notify]);
  return { crunch, day, points, mark, refresh };
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

/** Unified hid evidence summary (course.evidence.summary, 0-token): Map(hid -> PointEvidence) for conditional point-header gap hints. */
export function useCourseEvidence({ call, course, book, revision }) {
  const [byHid, setByHid] = useState(() => new Map());
  const [ticket, setTicket] = useState(0);
  useLiveEffect(isLive => {
    if (book?.status !== 'ok' || !course) { setByHid(new Map()); return; }
    call('course.evidence.summary', { course, date: localDate() }).then(
      next => { if (isLive()) setByHid(new Map((next?.points || []).map(point => [point.hid, point]))); },
      () => { if (isLive()) setByHid(new Map()); },
    );
  }, [call, course, book?.revision, book?.status, revision, ticket]);
  const refresh = useCallback(() => setTicket(value => value + 1), []);
  return { byHid, refresh };
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
export function useBookHandlers({
  call, act, course, notify, book, setBook, rows, reload, remember, onPractice, onCreate, onOpenSource,
  modelReady = true, model, onBack, ai, foldAi, onPlace, goTo, inlinePractice = null, evidenceByHid = null, onEvidenceChanged = null,
  courses = null, decks = null, sources = null, openModal = null, openModel = null, canChat = true, rescueJobs = null, onStartRescue = null,
  onTopUpPoints = null, pointGapBusy = false,
}) {
  const [qa, setQa] = useState(() => new Set());
  const [retell, setRetell] = useState(() => new Set());
  const [retoldByHid, setRetoldByHid] = useState(() => ({ course, records: {} }));
  const [choosing, setChoosing] = useState(false);
  const [rescuePrompt, setRescuePrompt] = useState(null);
  const activeRescuePrompt = rescuePrompt && !modelReady ? rescuePrompt : null;
  return useMemo(() => {
    const courseRetold = retoldByHid.course === course ? retoldByHid.records : {};
    return ({
    gone: goneSet(book?.missing),
    qaOpen: heading => qa.has(heading),
    toggleQa: heading => setQa(current => { const next = new Set(current); if (next.has(heading)) next.delete(heading); else next.add(heading); return next; }),
    // 用自己的话讲一遍 of a point (#1016, ui/review/RetellPanel.jsx): which points have it open; `model` is the readiness its gate shows.
    retellOpen: heading => retell.has(heading),
    toggleRetell: heading => setRetell(current => { const next = new Set(current); if (next.has(heading)) next.delete(heading); else next.add(heading); return next; }),
    retoldOf: heading => (heading && Object.hasOwn(courseRetold, heading) ? courseRetold[heading] : null),
    onRetold: (heading, record) => {
      if (!heading) return;
      setRetoldByHid(current => ({ course, records: { ...(current.course === course ? current.records : {}), [heading]: record } }));
    },
    gapHintOf: nodeOrHid => {
      const node = nodeOrHid && typeof nodeOrHid === 'object' ? nodeOrHid : null;
      const hid = node ? node.hid : nodeOrHid;
      if (!hid) return null;
      const ev = evidenceByHid?.get?.(hid) ?? null;
      const nodeId = node?.key ? String(node.key).replace(/^bk:/, '') : (ev?.nodeId || '');
      const linkedCompanion = findPointCompanion({
        hid,
        nodeId,
        questions: node?.questions || [],
        course,
        courses,
        decks,
        sources,
      });
      return resolveBookGapHint(ev, { linkedCompanion, rescueState: rescueJobs?.[hid] ?? null });
    },
    rescueStateOf: hid => rescueJobs?.[hid] ?? null,
    rescuePromptOf: hid => (activeRescuePrompt?.hid === hid ? activeRescuePrompt : null),
    dismissRescuePrompt: () => setRescuePrompt(null),
    openModel,
    onEvidenceChanged,
    actGapHint: async (node, hint, element) => {
      if (!hint || !node) return;
      if (hint.kind === 'companion_open' && hint.companionId) {
        openCompanionTarget(openModal, hint, { returnLabel: ui('返回复习全书'), from: 'book' });
        return;
      }
      if (hint.kind === 'rescue_experiment') {
        const gate = rescueGate('experiment', { modelReady, canChat });
        if (gate.type !== 'run') {
          setRescuePrompt({ hid: node.hid, ...gate });
          return;
        }
        setRescuePrompt(null);
        if (onStartRescue) {
          const questions = Array.isArray(node.questions) ? node.questions : [];
          const cardIds = [...new Set(questions.map(q => q?.cardId).filter(Boolean))].slice(0, 4);
          const deckIds = [...new Set(questions.map(q => q?.deckId).filter(Boolean))];
          await onStartRescue(node.hid, {
            course,
            hid: node.hid,
            topic: node.title || '',
            cardIds,
            ...(deckIds.length === 1 ? { deckId: deckIds[0] } : {}),
          });
        }
        return;
      }
      if (hint.kind === 'prereq' && hint.targetHid) {
        const exists = rowOf(rows, hint.targetHid) || Boolean(book?.files?.[`${hint.targetHid}.gen`]);
        if (!exists) { notify(ui('前置知识点还未生成复习全书内容。')); return; }
        goTo?.(hint.targetHid);
        return;
      }
      if (hint.kind === 'retell' || hint.kind === 'retell_gap') {
        setRetell(current => { const next = new Set(current); next.add(node.hid); return next; });
        if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined') {
          requestAnimationFrame(() => {
            const safeHid = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(node.hid) : node.hid;
            const panel = document.querySelector(`[data-book-retell="${safeHid}"], [data-point="${safeHid}"] .retell-panel, .retell-panel`);
            panel?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
          });
        }
        return;
      }
      const row = rowOf(rows, node.hid);
      if (!row) { notify(ui('这一节已不在总纲里。')); return; }
      try {
        const { practice } = await call('course.outline', { course, pick: { keys: [row.key] } });
        const scope = practice?.scope.slice(0, 5) || [];
        if (!scope.length) { notify(ui('这个知识点还没有题。先到「创建题组」从资料出题。')); return; }
        onPractice(scope, { resume: true, place: remember(node.hid, element) });
      } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    },
    inlineOpen: inlinePractice?.isOpen,
    inlineShown: inlinePractice?.shown ?? true,
    inlineRunFor: inlinePractice?.runFor,
    closeInlineRun: inlinePractice?.close,
    InlineRun: inlinePractice?.Run,
    inlineCheck: inlinePractice ? async (node, element) => {
      if (inlinePractice.isOpen(node.hid)) { inlinePractice.close(); return; }
      const row = rowOf(rows, node.hid);
      if (!row) { notify(ui('这一节已不在总纲里。')); return; }
      try {
        const { practice } = await call('course.outline', { course, pick: { keys: [row.key] } });
        const scope = practice?.scope.slice(0, 5) || [];
        if (!scope.length) { notify(ui('这个知识点还没有题。先到「创建题组」从资料出题。')); return; }
        inlinePractice.open(node, scope, remember(node.hid, element));
      } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    } : undefined,
    model: model ?? { ready: modelReady },
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
    // 补漏 of a point left short: only its missing concepts, the same task as on the 总纲 page (without a model it goes there, like 更新全书).
    fillGaps: async node => {
      if (!modelReady) { onBack?.(); return; }
      try { await act('generation.courseBook.build', { course, point: String(node.key).replace(/^bk:/, '') }, result => notify({ text: readMoreStartedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true }); }
      catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    },
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
    pointGapOf: node => {
      if (!node?.hid || book?.pointGaps?.status !== 'ok') return null;
      return book.pointGaps.leaves?.[node.hid] ?? null;
    },
    pointGapBusy,
    fillPointGap: onTopUpPoints ? (node, pointGap) => {
      if (!pointGap?.id || !pointGap.coverable) return;
      if (!modelReady) { openModel?.(); return; }
      onTopUpPoints([pointGap.id], {
        title: uiFormat('{0} · 补知识点', [node?.title || course || ui('未分类课程')]),
        label: node?.title || course || ui('未分类课程'),
        questions: pointGap.quota,
      });
    } : null,
    // The fold of the blocks (kept in this browser), and the two ways between a block and its dashed words (ui/book/ai-anchors.js): open the block, then show it.
    aiOpen: id => { flushSync(() => foldAi(id, false)); showBlock(id); },
    aiWords: id => showWords(id),
    // A 术语卡's link (#710): its point opened when the card is not drawn, then the card shown (ui/book/term-card-go.js).
    goCard: (hid, code) => { if (!cardShown(code)) goTo?.(hid, { hold: false }); showCard(code); },
  }); }, [book, qa, retell, retoldByHid, rows, call, course, notify, onCreate, onOpenSource, onPractice, remember, choosing, setBook, modelReady, model, onBack, ai, foldAi, reload, act, onPlace, goTo, inlinePractice, evidenceByHid, onEvidenceChanged, courses, decks, sources, openModal, openModel, canChat, rescueJobs, onStartRescue, activeRescuePrompt, onTopUpPoints, pointGapBusy]);
}
