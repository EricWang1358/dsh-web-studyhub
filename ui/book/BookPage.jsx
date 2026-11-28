import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, getUiLanguage, ui, uiFormat } from '../i18n.js';
import { Button, EmptyState, ErrorState, LoadingState } from '../components/index.js';
import { usePersistentState, readText, removeKey } from '../storage.js';
import { useStudy } from '../study-context.jsx';
import { AppContext } from '../app/app-context.js';
import { hasChatHost } from '../hand-off/use-hand-off.js';
import { openCompanionTarget } from '../companions/companion-ref.js';
import { useRescueExperiments } from '../companions/use-rescue-experiments.js';
import { useInjectCss } from '../shared.js';
import { useNarrow } from '../use-narrow.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { modelReadiness } from '../generation-status.js';
import { BOOK_BUILD_KIND, runningBuild } from '../outline/model.js';
import { bookCostTipText, writingText } from '../outline/words.js';
import { ReadingBlock } from '../reading-settings/ReadingSettings.jsx';
import BookHeader from './BookHeader.jsx';
import BookBar from './BookBar.jsx';
import BookMore from './BookMore.jsx';
import BookToc from './BookToc.jsx';
import BookChapter from './BookChapter.jsx';
import BookStep from './BookStep.jsx';
import BookAskLayer from './BookAskLayer.jsx';
import BookExport from './BookExport.jsx';
import BookStructureDialog from './BookStructure.jsx';
import PlanSection from './PlanSection.jsx';
import { CheatView, EditView, FlipView, HistoryDialog, KitDialog, LookupDialog, MockDialog, TodayPanel, useUnsavedWarning } from './book-views.jsx';
import { BookReadContext, bookSteps, useBookReading, useStepKeys } from './reading.js';
import { AiFoldContext, BookAiContext, useAiFold } from './ai-fold.js';
import { useBookData } from './use-book-data.js';
import { cheatSheet } from './cheat-sheet-model.js';
import { useBookPlace } from './use-book-place.js';
import { useBookAi } from './use-book-ai.js';
import { useBookRebuild } from './use-book-rebuild.js';
import { useFoundMarks } from './use-found-marks.js';
import BookRebuildPreview from './BookRebuildPreview.jsx';
import BookSample from './BookSample.jsx';
import BookPointGaps from './BookPointGaps.jsx';
import { startBookBuild, startCoursePointTopUp, useBookCrunch, useBookHandlers, useBookPages, useCourseEvidence, useCoursePlan } from './use-book-actions.js';
import { startCardPass, useCardPass } from './use-card-pass.js';
import { useMoreActions } from './more-actions.js';
import useIndexCoverage from '../use-index-coverage.js';
import { hintDocOf, indexHintFor, INDEX_HINT_PAGES } from '../index-hint.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';
import { bookParts, showsPart } from './book-parts.js';
import { bookConfusableDrill, bookCoverage, bookInlinePractice, crunchWindow, resolveBookSettings } from '../../lib/book-settings.js';
import { bookRows, crunchDateHint, keepBook, rowOf, tocEntries } from './model.js';
import css from './book.css';
import aiCss from './book-ai.css';

/* 复习全书 (docs/review-book.md). The book of the current course (course.book.open, lib/course-book-files.js) on ONE reading surface: the header, the sticky book
   bar (目录 · where · ‹ › · Aa · ⋯ 更多, ui/book/BookBar.jsx), the 目录 beside the text at wide widths and sliding over it on a narrow page, and the point being
   read (逐节读) or the chapters in one scroll (整章连着读, from 更多). Every other view (编辑, 翻看, 速查页, 导出, 模拟卷, 发给主会话) opens from 更多 and comes
   back to the same point. The place is kept for the next visit (ui/book/use-book-place.js); what the main chat wrote shows up when the page comes back into view. */

export function selectedBookFindQuery() {
  const selected = typeof window !== 'undefined' ? window.getSelection?.()?.toString().trim() : '';
  return selected && selected.length <= 80 && !/[\r\n]/.test(selected) ? selected : '';
}

export function isBookFindShortcut(event) {
  return Boolean(event && (event.ctrlKey || event.metaKey) && !event.altKey && String(event.key ?? '').toLowerCase() === 'f');
}

export function handleBookFindShortcut(event, { view, ready, inOverlay, onOpen }) {
  if (!event || event.defaultPrevented || !isBookFindShortcut(event)) return false;
  if (view !== 'read' || !ready || inOverlay) return false;
  event.preventDefault?.();
  onOpen?.();
  return true;
}

/** data: the snapshot; onBack() (the 总纲); onPractice(scope, { resume, place }); onOpenSource(sourceId, quote); onCreate() (出题); onOpenTask(jobId);
    onExamRun(run): enters a mock exam started here (M7); onCourseSettings(courseId); theme: 'light' | 'dark' (the editor's); holdLeave(ask): the app's leave gate, held while the editor has unsaved text. */
export default function BookPage({ data, onBack, backLabel = '', onReturnBack = null, onPractice, inlinePractice = null, onOpenSource, onCreate, onOpenTask, onExamRun, onCourseSettings, onBuildIndex, theme, holdLeave, paragraphIndex = null, searchQuery = '' }) {
  useInjectCss(css, 'study-book');
  useInjectCss(aiCss, 'study-book-ai');
  const { call, act, busy, notify, openModal, openSettings, host } = useStudy();
  const app = useContext(AppContext);
  const canChat = hasChatHost(host);
  const openModel = useMemo(() => (openSettings ? () => openSettings('settings-model') : undefined), [openSettings]);
  const course = data?.focus?.course ?? null, root = data?.root || '';
  const pageRef = useRef(null), tocRef = useRef(null), narrow = useNarrow(pageRef);
  // The view: the reading surface, or the editor / 翻看 that take its place until 「完成 · 回到阅读」. Never remembered, except the old 翻看 mode once (below).
  const [view, setView] = useState('read');
  const [dialog, setDialog] = useState(null), [todayOpen, setTodayOpen] = useState(false), [structure, setStructure] = useState(null);
  const [dirty, setDirty] = useState(false), [leaving, setLeaving] = useState(null);
  const place = useRef(null);
  const { book, error, setBook, reload } = useBookData({ call, course, paused: view === 'edit', onReplaced: () => place.current?.hold() });
  const rows = useMemo(() => (book?.status === 'ok' ? bookRows(book.nodes) : []), [book]);
  const toc = useMemo(() => tocEntries(book), [book]);
  // The 速查表 (#710 S5) is offered in 更多 and in the export only when the book has cards, templates, comparisons or formulas to put on it.
  const hasCheat = useMemo(() => !!cheatSheet(book), [book]);
  const chapters = useMemo(() => (book?.status === 'ok' ? [...book.nodes, ...(book.unplaced.text.trim() ? [{ hid: 'unplaced', title: book.unplaced.title, text: book.unplaced.text, file: book.unplaced.file, number: '' }] : [])] : []), [book]);
  const reading = useBookReading(root, course), steps = useMemo(() => bookSteps(book), [book]);
  const where = useBookPlace({ root, course, book, rows, toc, steps, chapters, reading, pageRef, active: view === 'read' });
  place.current = where;
  // The home's card can open the page in 翻看 or with 今天读哪几节 open, and says once that it switched the course (one-shots of ui/book/model.js); the old
  // remembered mode `study-book-mode` opens 翻看 once when it was 翻看, and is forgotten.
  const [switched] = useState(() => !!where.kept?.switched);
  useEffect(() => {
    const legacy = readText(`study-book-mode:${root}:${course}`, null);
    if (legacy !== null) removeKey(`study-book-mode:${root}:${course}`);
    if (where.kept?.view === 'flip' || (legacy === 'flip' && !where.kept?.target)) setView('flip');
    if (where.kept?.view === 'today') setTodayOpen(true);
    if (where.kept?.view === 'lookup') setDialog('lookup');
    keepBook(root, course, { view: null, switched: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = useBookCrunch({ call, course, book, notify });
  const period = useCoursePlan({ call, course, book, revision: data?.revision });
  const evidence = useCourseEvidence({ call, course, book, revision: data?.revision });
  const onRescueCompleted = useCallback(() => {
    evidence.refresh?.();
    Promise.resolve(app?.core?.refresh?.()).catch(() => {});
  }, [app?.core, evidence]);
  const rescue = useRescueExperiments({
    call,
    onCompleted: onRescueCompleted,
    failMessage: ui('这次没能生成交互实验，可以重试或先做本节的题。'),
  });
  // 备考计划's fold is kept in this browser per library and course (open at first: it is the page's plan).
  const [planOpen, setPlanOpen] = usePersistentState(`study-book-plan:${root}:${course}`, true, { parse: value => value !== 'closed', serialize: value => (value ? 'open' : 'closed') });
  const pages = useBookPages({ call, course, book }), pageLimit = resolveBookSettings(data?.settings?.book).pageLimit;
  const inlinePracticeOn = bookInlinePractice(data?.settings?.book);
  const confusableDrillOn = bookConfusableDrill(data?.settings?.book);
  const [tocWide, setTocWide] = usePersistentState(`study-book-toc:${root}:${course}`, true, { parse: value => value !== 'closed', serialize: value => (value ? 'open' : 'closed') });
  const [tocOver, setTocOver] = useState(false), closeToc = useCallback(() => setTocOver(false), []);
  const [tocLens, setTocLens] = useState('all');
  useEffect(() => { setTocOver(false); }, [narrow]);
  const tocOpen = narrow ? tocOver : tocWide;
  const aiFold = useAiFold(root, course);
  const ai = useBookAi({ call, course, notify, reload, book, setBook, rows, aiFold, goTo: where.goTo });
  const [inlineState, setInlineState] = useState(null);
  const inlineHidRef = useRef(null);
  inlineHidRef.current = inlineState?.hid ?? null;
  const clearInlineRun = useCallback(() => {
    if (!inlineHidRef.current) return;
    inlineHidRef.current = null;
    setInlineState(null);
    plan.refresh?.();
    period.refresh?.();
    evidence.refresh?.();
  }, [plan, period, evidence]);
  // The 问 AI panel belongs to the point it was opened on: in 逐节读 another point closes it, and so does another view or reading mode. In 整章连着读 the place
  // read (the top heading on screen) changes with every scroll, so scrolling keeps the panel (and what is typed in it); it closes there only when its point is folded or no longer drawn.
  useEffect(() => { ai.closeAsk(); clearInlineRun(); }, [reading.mode === 'step' ? where.current : -1, reading.mode, view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pageRef.current) return;
    if (reading.mode === 'scroll' && view === 'read' && ai.ask && !pageRef.current.querySelector(`[data-book-point="${CSS.escape(ai.ask.heading)}"]`)) ai.closeAsk();
    if (inlineState && !((view === 'read' || view === 'flip') && pageRef.current.querySelector(`[data-book-point="${CSS.escape(inlineState.hid)}"]`))) clearInlineRun();
  });
  const placeSection = useCallback(section => setStructure({ kind: 'place', section }), []);
  // The model's readiness as primitives, so a poll that rebuilds the snapshot does not rebuild every point's handlers.
  const readiness = modelReadiness(data), model = useMemo(() => readiness, [readiness.ready, readiness.reason, readiness.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const inlineShown = !tocOver && !dialog && !leaving && !structure;
  const inlineController = useMemo(() => {
    if (!inlinePracticeOn || !inlinePractice?.Run || !inlinePractice?.start) return null;
    return {
      Run: inlinePractice.Run,
      shown: inlineShown,
      isOpen: hid => inlineState?.hid === hid,
      runFor: hid => (inlineState?.hid === hid ? inlineState : null),
      open: (node, scope, fromPlace) => inlinePractice.start(scope, { resume: true, place: fromPlace }, (started, origin) => {
        setInlineState({ hid: node.hid, started, origin, label: uiFormat('{0} · {1} 道题', [node.title, started?.total || scope.length]) });
      }),
      close: clearInlineRun,
    };
  }, [inlinePracticeOn, inlinePractice, inlineShown, inlineState, clearInlineRun]);
  const courseName = course === '' ? ui('未分类课程') : course || '';
  const fillingJob = useMemo(() => (data?.jobs || []).find(job => (
    job && (!job.type || job.type === 'generation') && job.course === course && job.coverage && (job.status === 'running' || job.status === 'queued')
  )) ?? null, [data?.jobs, course]);
  const prevFillingId = useRef(null);
  useEffect(() => {
    const prev = prevFillingId.current;
    prevFillingId.current = fillingJob?.id ?? null;
    if (prev && !fillingJob && view !== 'edit') {
      place.current?.hold();
      reload();
      evidence.refresh?.();
    }
  }, [fillingJob, view, reload, evidence]);
  const onTopUpPoints = useCallback((pointIds, options = {}) => startCoursePointTopUp({ act, course, courseName, pointIds, notify, options }),
    [act, course, courseName, notify]);
  const handlers = useBookHandlers({ call, act, course, notify, book, setBook, rows, reload, remember: where.remember, onPractice, onCreate, onOpenSource,
    modelReady: model.ready, model, onBack, ai: ai.actions, foldAi: aiFold.fold, onPlace: placeSection, goTo: where.goTo, inlinePractice: inlineController,
    evidenceByHid: evidence.byHid, onEvidenceChanged: evidence.refresh, courses: data?.courses, decks: data?.decks, sources: data?.sources,
    openModal, openModel, canChat, rescueJobs: rescue.jobs, onStartRescue: rescue.start,
    onTopUpPoints, pointGapBusy: busy || !!fillingJob });
  // 在书里找 (the 目录's box, ui/book/book-search.js): what is typed stays while a narrow 目录 is closed; `found` is the point a row went to, its words marked while it is drawn.
  const initialSearchRef = useRef(
    (where.kept?.query || where.kept?.snippet || Number.isInteger(where.kept?.paragraphIndex))
      ? { target: where.kept?.target ?? null, paragraphIndex: where.kept?.paragraphIndex ?? null, query: where.kept?.query || '', snippet: where.kept?.snippet || '' }
      : null,
  );
  const [findQuery, setFindQuery] = useState(() => searchQuery || where.kept?.query || ''), [found, setFound] = useState(null);
  const dropFound = useCallback(() => setFound(null), []);
  const onFindQuery = useCallback(text => { setFindQuery(text); if (!text.trim()) setFound(null); }, []);
  const { goTo, stopHold, current: whereCurrent } = where;
  const onFound = useCallback((row, query) => { goTo(row.hid, { hold: false }); setFound({ hid: row.hid, query, count: row.count, nonce: Date.now() }); }, [goTo]);
  useEffect(() => {
    if (book?.status !== 'ok' || !book?.notes || !steps.length) return;
    const pending = initialSearchRef.current;
    const propHasTarget = Boolean(searchQuery || Number.isInteger(paragraphIndex));
    if (!pending && !propHasTarget) return;
    initialSearchRef.current = null;
    const wantedTarget = pending?.target ?? null;
    const resolvedRow = wantedTarget ? rowOf(rows, wantedTarget) : null;
    const hid = resolvedRow?.hid ?? steps[whereCurrent]?.hid ?? steps[0]?.hid ?? null;
    if (!hid) return;
    const nextQuery = searchQuery || pending?.query || '';
    const nextSnippet = pending?.snippet || '';
    const nextParagraphIndex = Number.isInteger(paragraphIndex) ? paragraphIndex : (Number.isInteger(pending?.paragraphIndex) ? pending.paragraphIndex : null);
    if (nextQuery) setFindQuery(nextQuery);
    if (resolvedRow && resolvedRow.hid !== steps[whereCurrent]?.hid) goTo(resolvedRow.hid, { hold: false });
    setFound({ hid, query: nextQuery, snippet: nextSnippet, paragraphIndex: nextParagraphIndex, count: 1, nonce: Date.now() });
  }, [book?.status, book?.notes, steps, rows, whereCurrent, goTo, paragraphIndex, searchQuery]);
  const tocSearchRef = useRef(null), pendingFindFocusRef = useRef(false);
  const [findFocusTick, setFindFocusTick] = useState(0);
  const openBookFind = useCallback(() => {
    const selected = selectedBookFindQuery();
    if (selected) onFindQuery(selected);
    pendingFindFocusRef.current = true;
    if (narrow) setTocOver(true);
    else setTocWide(true);
    setFindFocusTick(tick => tick + 1);
  }, [narrow, onFindQuery, setTocWide]);
  const handleFindShortcut = useCallback(event => handleBookFindShortcut(event, {
    view,
    ready: book?.status === 'ok' && !!book?.notes,
    inOverlay: Boolean(inlineState || event?.target?.closest?.('dialog, [role=dialog], .cm-editor, [data-inline-run]') || pageRef.current?.querySelector?.('dialog[open]')),
    onOpen: openBookFind,
  }), [view, inlineState, book?.status, book?.notes, openBookFind]);
  useEffect(() => {
    if (view !== 'read' || book?.status !== 'ok' || !book?.notes || typeof window === 'undefined') return undefined;
    window.addEventListener('keydown', handleFindShortcut);
    return () => window.removeEventListener('keydown', handleFindShortcut);
  }, [view, book?.status, book?.notes, handleFindShortcut]);
  useEffect(() => {
    if (!findFocusTick || !pendingFindFocusRef.current || view !== 'read' || !tocOpen) return undefined;
    const focusInput = () => {
      const input = tocSearchRef.current ?? pageRef.current?.querySelector?.('.book-toc__input');
      if (!input) return false;
      input.focus?.({ preventScroll: true });
      input.select?.();
      pendingFindFocusRef.current = false;
      return true;
    };
    focusInput();
    if (typeof requestAnimationFrame !== 'function') return undefined;
    const frame = requestAnimationFrame(() => {
      const input = tocSearchRef.current ?? pageRef.current?.querySelector?.('.book-toc__input');
      if (!input) return;
      input.focus?.({ preventScroll: true });
      input.select?.();
    });
    return () => cancelAnimationFrame?.(frame);
  }, [findFocusTick, view, tocOpen]);
  useFoundMarks({ found, drawn: `${view}:${reading.mode}:${where.stepAt}:${book?.revision}`, pageRef, aiFold, stopHold, onGone: dropFound });
  useStepKeys(view === 'read' && !tocOver && !inlineState && book?.status === 'ok' && !!book.notes, where.go);
  // Leaving the editor with unsaved text asks first: the 完成 button and another course here, every other way out of the page through the app's one leave gate
  // (holdLeave, ui/app/navigator.js createLeaveGate), closing or reloading the tab through the browser's own question.
  const unsaved = view === 'edit' && dirty;
  const guard = useCallback(then => (unsaved ? setLeaving(() => then) : then()), [unsaved]);
  useEffect(() => (unsaved ? holdLeave?.(go => setLeaving(() => go)) : undefined), [unsaved, holdLeave]);
  useUnsavedWarning(unsaved);
  // Saved (or given up) with the question still up: nothing is left to ask about. The learner stays; the click that raised the question is not carried out later.
  useEffect(() => { if (!unsaved) setLeaving(null); }, [unsaved]);
  const back = useCallback(() => { setLeaving(null); setDirty(false); setView('read'); }, []);
  // 完成 pressed while a save is still running waits for it: it leaves when the save worked, and asks (the text is still unsaved) when it did not.
  const saveRunning = useRef(false), leaveAfterSave = useRef(false);
  const onSaving = useCallback((running, saved) => {
    saveRunning.current = running;
    if (running || !leaveAfterSave.current) return;
    leaveAfterSave.current = false;
    if (saved) back(); else setLeaving(() => back);
  }, [back]);
  const finishEdit = useCallback(() => { if (saveRunning.current) leaveAfterSave.current = true; else guard(back); }, [guard, back]);
  // The editor and 翻看 take the page's place; 完成 · 回到阅读 comes back to the heading being read where it was on screen (held until it is drawn again).
  const openView = useCallback(next => { place.current?.hold(); setView(next); }, []);
  // A save that lands in a pending rebuild (#461): the editor is done, so a later read is not dropped as "an editor is open", and applying leads to reading.
  useEffect(() => { if (book?.status === 'rebuild-pending' && view === 'edit') back(); }, [book?.status, view, back]);
  const courseRecord = (data?.courses || []).find(item => item.name === course);
  // The parts the course's 定制方案 asks for (深度定制 S2, ./book-parts.js): a part left out is not offered (速查表, the 速查页's formula page and A–Z).
  const parts = bookParts(courseRecord), offerCheat = hasCheat && showsPart(parts, 'cheatSheet');
  const dateHint = book?.status === 'ok' && book.notes ? crunchDateHint(courseRecord?.exam, crunchWindow(data?.settings?.book)) : null;
  const writing = runningBuild(data?.jobs, course, BOOK_BUILD_KIND);
  const rebuild = useBookRebuild({ call, course, notify, setBook, reload }), building = !!(writing || runningBuild(data?.jobs, course));
  const cardPass = useCardPass({ call, course, book, building });
  const header = <BookHeader data={data} course={course} courseName={courseName} book={book} writing={writing} switched={switched} onOpenTask={onOpenTask} onUndoRebuild={building || unsaved ? undefined : rebuild.undo}
    onUpdate={book?.sample ? undefined : modelReadiness(data).ready ? () => startBookBuild({ act, course, notify }) : onBack}
    backLabel={backLabel} onBack={onReturnBack ? () => guard(onReturnBack) : onBack} onCourse={next => guard(() => act('focus.set', { course: next }))} />;
  const step = steps[where.current] ?? null;
  // 改名 / 移动到… / 删除这个知识点… act on the point being read; a delete goes to the point after it (or before it, at the end) once it is gone.
  const structureAt = where.current;
  const openStructure = useCallback(entry => {
    const next = steps[structureAt + 1]?.hid ?? steps[structureAt - 1]?.hid ?? null;
    setStructure({ ...entry, next });
  }, [steps, structureAt]);
  // 更多 › 整本书 offers 先建立检索索引… while a book of 150 pages or more in this course has none (the other pages carry ui/IndexHint.jsx; the menu keeps it for good).
  const courseDocs = useMemo(() => (onBuildIndex ? groupSourcesByDocument(data?.sources || []).filter(item => !item.archived && (item.courses || []).includes(course)).map(hintDocOf) : []), [data?.sources, course, onBuildIndex]);
  const [indexCoverage] = useIndexCoverage(call, { enabled: courseDocs.some(doc => doc.pages >= INDEX_HINT_PAGES) });
  const needsIndex = !!onBuildIndex && !!indexHintFor(courseDocs, indexCoverage, { once: false });
  const more = useMoreActions({ step, course, book, notify, aiFold, reading, where, openView, setDialog, setTodayOpen, onCreate, onCourseSettings, courseRecord, onStructure: openStructure, onOutline: onBack,
    onCards: () => startCardPass({ act, course, notify }), onBuildIndex });
  const stuckHids = useMemo(() => new Set((plan.crunch?.points || []).filter(point => point.stuck).map(point => point.id)), [plan.crunch]);
  const markStuck = useCallback((hid, on) => plan.mark(hid, 'stuck', on), [plan]);
  const compileConfusableLab = useCallback(async pair => {
    try {
      const hid = pair?.hids?.find(Boolean) || undefined;
      const res = await call('companion.compile', {
        confusables: [pair],
        course: course || undefined,
        ...(hid ? { hid } : {}),
        language: getUiLanguage(),
        mountMode: 'companion-only',
      });
      if (res?.companion?.id && openModal) {
        setDialog(null);
        openCompanionTarget(openModal, {
          companionId: res.companion.id,
          course: res.companion.course || course || '',
          companionTitle: res.companion.title || '',
          returnLabel: ui('返回复习全书'),
          from: 'book',
        });
      }
    } catch (failure) {
      notify({ text: errorMessage(failure), tone: 'error' });
    }
  }, [call, course, notify, openModal]);
  if (error && !book) return <section className="page book-page" ref={pageRef}>{header}<ErrorState error={error} title={ui('没能打开复习全书')} onRetry={reload} /></section>;
  if (!book) return <section className="page book-page" ref={pageRef}>{header}<LoadingState label={ui('正在打开复习全书…')} /></section>;
  // A rebuilt outline that would move the learner's own text: nothing moved yet, the list comes first (#461).
  if (book.status === 'rebuild-pending') return <section className="page book-page" ref={pageRef}>{header}<BookRebuildPreview moves={book.moves} onApply={rebuild.apply} onDiscard={rebuild.discard} building={building} /></section>;
  if (book.status !== 'ok') return <section className="page book-page" ref={pageRef}>{header}<EmptyState icon="book" title={ui('这门课还没有总纲')}
    description={ui('复习全书按总纲的知识点排，先在总纲页生成总纲。')} primary={{ label: ui('回到总纲'), icon: 'arrow-left', onClick: onBack }} /></section>;
  if (!book.notes) {
    const model = modelReadiness(data);
    const writeBook = () => startBookBuild({ act, course, notify });
    return (
      <section className="page book-page" ref={pageRef}>
        {header}
        {writing ? <p className="book-writing" role="status"><LoadingState inline label={writingText(writing)} />
          {onOpenTask && <Button iconEnd="arrow-right" variant="link" size="sm" onClick={() => onOpenTask(writing.jobId)}>{ui('看进度')}</Button>}</p>
          : <EmptyState icon="book" title={ui('还没有复习全书')} description={`${ui('「生成复习全书」给每个知识点写讲解；写好后在这里读，点题目链接就去练。')} ${bookCostTipText()}`}
            primary={{ label: ui('生成复习全书'), icon: 'book', onClick: writeBook, disabled: !model.ready }}
            secondary={onBack ? { label: ui('回到总纲'), icon: 'arrow-left', onClick: onBack } : undefined} />}
        <ModelSetupGate variant="compact" feature="reviewBook" model={model} />
      </section>
    );
  }
  // The selection toolbar and the 问 AI panel (a new selection or title is a new panel, its box empty).
  const askPanel = <BookAskLayer ai={ai} rows={rows} book={book} course={course} model={modelReadiness(data)} pageRef={pageRef} />;
  const over = pages !== null && pageLimit && pages > pageLimit;
  // Over the page limit: one quiet line under the bar (the estimate and how far over); its Tooltip says where the limit is changed.
  const notice = over ? { text: uiFormat('导出约 {0} 页，超过 {1} 页的上限', [pages, pageLimit]), tip: uiFormat('上限是 {0} 页：在「导出…」里改，留空就是不限。', [pageLimit]) } : null;
  const unplaced = step?.hid === 'unplaced', counted = steps.filter(item => item.hid !== 'unplaced').length;
  const hasHistory = Object.values(book.history || {}).some(count => count > 0);
  const menu = <BookMore onSelect={more.select} unplaced={unplaced} pointFold={more.pointFold} bookFold={more.bookFold} scroll={reading.mode === 'scroll'} pages={pages} pageLimit={pageLimit}
    history={hasHistory} today={!!plan.day} mockScope={plan.day ? plan.points.length : 0} dateHint={dateHint} settings={!!(courseRecord?.id && onCourseSettings)}
    kit={!!book.examKit?.types?.length} cheat={offerCheat} cardPass={cardPass} index={needsIndex} />;
  const dialogs = <>
    {dialog === 'export' && <BookExport course={course} pageLimit={pageLimit} book={offerCheat ? book : null} onClose={() => setDialog(null)} />}
    {dialog === 'lookup' && <LookupDialog book={book} parts={parts} confusableDrill={confusableDrillOn} onCompileLab={compileConfusableLab} onMarkStuck={markStuck} stuckHids={stuckHids} onGo={where.goTo} onCard={handlers.goCard} onClose={() => setDialog(null)} />}
    {dialog === 'kit' && book.examKit && <KitDialog book={book} drill={confusableDrillOn} onMarkStuck={markStuck} stuckHids={stuckHids} onGo={where.goTo} onClose={() => setDialog(null)} />}
    {dialog === 'history' && <HistoryDialog book={book} step={step} onChanged={setBook} onClose={() => setDialog(null)} />}
    {dialog === 'mock' && <MockDialog course={course} pointIds={plan.day ? plan.points.map(point => point.id) : undefined} onStarted={onExamRun} onClose={() => setDialog(null)} />}
  </>;
  if (view === 'edit') return <section className="page book-page" ref={pageRef}>{header}
    <EditView book={book} step={step} theme={theme} root={root} onChanged={setBook} onDirty={setDirty} onSaving={onSaving} leaving={!!leaving} onStay={() => setLeaving(null)}
      onLeave={() => { const then = leaving; back(); then?.(); }} onDone={finishEdit} /></section>;
  if (view === 'flip') return <section className="page book-page" ref={pageRef}>{header}
    <BookAiContext.Provider value={ai.lines}><FlipView book={book} crunch={plan.crunch} course={course} handlers={handlers} aiFold={aiFold} drill={confusableDrillOn}
      onMark={(hid, on) => plan.mark(hid, 'seen', on)} onMarkStuck={markStuck}
      onGo={hid => { setView('read'); where.goTo(hid); }} onMockStarted={onExamRun} onDone={() => setView('read')} /></BookAiContext.Provider>{askPanel}{dialogs}</section>;
  if (view === 'cheat') return <section className="page book-page" ref={pageRef}>{header}
    <CheatView book={book} onGo={hid => { setView('read'); where.goTo(hid); }} onDone={() => setView('read')} />{dialogs}</section>;
  return (
    <section className="page book-page" ref={pageRef} data-narrow={narrow ? '' : undefined} onKeyDown={handleFindShortcut}>
      {header}
      <BookBar ref={tocRef} at={step && !unplaced ? where.current + 1 : 0} total={counted} number={step?.node.number || ''} title={step?.node.title ?? ''}
        hid={step?.hid ?? null} tocOpen={tocOpen}
        onToc={() => (narrow ? setTocOver(value => !value) : setTocWide(!tocWide))} onPrev={where.current > 0 ? () => where.go(-1) : null}
        onNext={where.current < steps.length - 1 ? () => where.go(1) : null} more={menu} notice={notice} />
      {/* The sample waits for the learner (#710): its points lead to their headings; 生成其余 / 重做样例 start the build like the 总纲's buttons. */}
      {book.sample && !building && <BookSample sample={book.sample} coverage={bookCoverage(data?.settings?.book)} off={!modelReadiness(data).ready}
        onRest={() => startBookBuild({ act, course, notify, extra: { sample: 'confirm' } })} onRedo={() => startBookBuild({ act, course, notify })}
        onOpen={point => (point.hid ? where.goTo(point.hid) : undefined)} />}
      <PlanSection plan={period.answer} course={course} windowDays={crunchWindow(data?.settings?.book)} open={planOpen} onToggle={() => setPlanOpen(!planOpen)} onRefresh={period.refresh}
        onExamDate={courseRecord?.id && onCourseSettings ? () => onCourseSettings(courseRecord.id) : null} onToday={plan.day ? () => setTodayOpen(value => !value) : null} todayOpen={todayOpen}
        onRead={point => { if (period.answer?.schedule?.today?.mode === 'review') { openView('flip'); return; } where.goTo(point.id); }}
        onPractice={(point, element) => handlers.practice(point.id, 5, point.id, element)} onMarkRead={async (point, on) => { await plan.mark(point.id, 'read', on); period.refresh(); }}
        onFlip={() => openView('flip')} onMockStarted={onExamRun} />
      {plan.day && todayOpen && <TodayPanel course={course} crunch={plan.crunch} day={plan.day} points={plan.points}
        onRead={point => { if (plan.day.mode === 'flip') { openView('flip'); return; } where.goTo(point.id); }}
        onPractice={(point, element) => handlers.practice(point.id, 5, point.id, element)} onMarkRead={(point, on) => plan.mark(point.id, 'read', on)}
        onFlip={() => openView('flip')} onMockStarted={onExamRun} />}
      {/* Compact single-line disclosure by default so the reading canvas stays calm above the fold. */}
      {book.pointGaps && <BookPointGaps course={course} report={book.pointGaps} disabled={busy || !model.ready} modelReady={model.ready} fillingJob={fillingJob}
        onTopUp={onTopUpPoints} onGo={where.goTo} onOutline={onBack} onOpenTask={onOpenTask} />}
      <div className={tocOpen && !narrow ? 'book-layout book-layout--toc' : 'book-layout'}>
        {tocOpen && <BookToc entries={toc} here={where.here} onGo={where.goTo} narrow={narrow} onClose={closeToc} returnRef={tocRef} coverage={book.coverage ?? null} book={book} query={findQuery} onQuery={onFindQuery} onFound={onFound} searchRef={tocSearchRef} showWeakLens={inlinePracticeOn} weakPoints={inlinePracticeOn ? plan.crunch?.points ?? null : null} pointGaps={book.pointGaps ?? null} lens={tocLens} onLens={setTocLens} />}
        <ReadingBlock className="book-read" measure>
          <AiFoldContext.Provider value={aiFold}><BookAiContext.Provider value={ai.lines}><BookReadContext.Provider value={reading}>
            {reading.mode === 'step' ? <BookStep steps={steps} at={where.stepAt} onGo={index => where.go(index - where.stepAt)} course={course} handlers={handlers} />
              : chapters.map(chapter => <BookChapter key={chapter.hid} node={chapter} open={where.open.has(chapter.hid)} course={course} handlers={handlers}
                onToggle={value => where.toggleChapter(chapter.hid, value)} />)}
          </BookReadContext.Provider></BookAiContext.Provider></AiFoldContext.Provider>
        </ReadingBlock>
      </div>
      {askPanel}
      {dialogs}
      {structure && <BookStructureDialog kind={structure.kind} book={book} node={structure.node} section={structure.section} onRun={handlers.structure} onClose={() => setStructure(null)}
        onPlaced={(hid, next) => { if (!next?.unplaced?.sections?.length) where.goTo(hid); }}
        onDeleted={() => { const next = structure.next; setStructure(null); if (next) where.goTo(next); }} />}
    </section>
  );
}
