import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, EmptyState, ErrorState, LoadingState, PageHeader, SegmentedControl } from '../components/index.js';
import { usePersistentState } from '../storage.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { modelReadiness } from '../generation-status.js';
import { BOOK_BUILD_KIND, runningBuild } from '../outline/model.js';
import { bookStartedText, writingText } from '../outline/words.js';
import BookChapter from './BookChapter.jsx';
import BookToc from './BookToc.jsx';
import BookEditor from './BookEditor.jsx';
import BookAiAsk from './BookAiAsk.jsx';
import BookLookup from './BookLookup.jsx';
import BookExport, { budgetText } from './BookExport.jsx';
import BookFlip from './BookFlip.jsx';
import { AiFoldContext, useAiFold } from './ai-fold.js';
import { showBlock, showWords } from './ai-anchors.js';
import CrunchDay from './CrunchDay.jsx';
import { localDate } from '../../lib/board-model.js';
import { bookLookup } from '../../lib/course-book-lookup.js';
import { crunchWindow, resolveBookSettings } from '../../lib/book-settings.js';
import { usePolling } from '../use-polling.js';
import { isActiveJob } from '../../lib/job-status.js';
import { bookRows, crunchDateHint, defaultFile, goneSet, keepBook, keptBook, rowOf, tocEntries } from './model.js';
import css from './book.css';

/* 复习全书 (docs/plans/review-book.md, M1: read only). The book of the current course (course.book.open, lib/course-book-files.js): the 目录 beside the
   rendered Markdown at wide widths, one column with a folded 目录 at narrow ones. Only the open chapters render (I8). A question link goes to the practice
   page with the way back (回到复习全书), and the page comes back at the same heading and scroll; 本节问答 opens the point's questions and answers in place.
   Reached from the sidebar's 复习全书 (when the book is written) and from the 总纲 page (打开书页). */

const wideNow = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(min-width: 900px)').matches;
const scrollerOf = element => {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
};

/** data: the snapshot; onBack() (the 总纲); onPractice(scope, { resume }) keeps the way back; onOpenSource(sourceId, quote) (the reader); onCreate() (出题); onOpenTask(jobId);
    onExamRun(run): enters a mock exam started here (M7); onCourseSettings(courseId): opens the course's settings (the exam date is its first field); theme: 'light' | 'dark' (the editor's). */
export default function BookPage({ data, onBack, onPractice, onOpenSource, onCreate, onOpenTask, onExamRun, onCourseSettings, theme }) {
  useInjectCss(css, 'study-book');
  const { call, act, notify } = useStudy();
  const course = data?.focus?.course ?? null, root = data?.root || '';
  const [state, setState] = useState({ book: null, error: null, ticket: 0 });
  useLiveEffect(isLive => {
    call('course.book.open', { course }).then(book => { if (isLive()) setState(current => ({ ...current, book, error: null })); },
      error => { if (isLive()) setState(current => ({ ...current, error })); });
  }, [call, course, state.ticket]);
  const book = state.book;
  const rows = useMemo(() => (book?.status === 'ok' ? bookRows(book.nodes) : []), [book]);
  const toc = useMemo(() => tocEntries(book), [book]);
  const chapters = useMemo(() => (book?.status === 'ok' ? [...book.nodes, ...(book.unplaced.text.trim() ? [{ hid: 'unplaced', title: book.unplaced.title, text: book.unplaced.text, file: book.unplaced.file, number: '' }] : [])] : []), [book]);
  // 预览, 原文 or 查找 (M6), remembered per library and course; 原文 shows one file, the learner's own file of the point being read at first.
  const [mode, setMode] = usePersistentState(`study-book-mode:${root}:${course}`, 'preview', { parse: value => (['source', 'lookup', 'flip'].includes(value) ? value : 'preview'), serialize: value => value });
  // 期末一周 (M7, book.crunch): the plan of the course's last days before its exam; 「今天读哪几节」 in the header and the 翻看 view read it. Asked again
  // when the book changes or a mark is set. The home's card can open the page in 翻看 or with 今天读哪几节 open (`view`, kept by keepBook).
  const [crunch, setCrunch] = useState(null);
  const view = useRef(keptBook(root, course)?.view ?? null);
  const [todayOpen, setTodayOpen] = useState(view.current === 'today');
  useEffect(() => {
    if (view.current === 'flip') setMode('flip');
    if (view.current) keepBook(root, course, { view: null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLiveEffect(isLive => {
    if (book?.status !== 'ok' || !book.notes) return;
    call('book.crunch', { course, date: localDate() }).then(next => { if (isLive()) setCrunch(next); }, () => { if (isLive()) setCrunch({ status: 'error' }); });
  }, [call, course, book?.revision, book?.status, book?.notes]);
  const crunchDay = crunch?.status === 'ok' ? crunch.plan.today : null;
  const crunchPoints = useMemo(() => { const byId = new Map((crunch?.points || []).map(point => [point.id, point])); return (crunchDay?.points || []).map(id => byId.get(id)).filter(Boolean); }, [crunch, crunchDay]);
  // 读完了 / 已看 (book.crunch.mark): kept per course in the book's record; the answer is the plan again.
  const mark = useCallback(async (hid, kind, on) => {
    try { setCrunch(await call('book.crunch.mark', { course, hid, kind, on, date: localDate() })); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, notify]);
  // 查找 is made from the book as it is now (lib/course-book-lookup.js); 导出 and the page limit (settings.book.pageLimit) compare the export's estimate.
  const lookup = useMemo(() => (mode === 'lookup' ? bookLookup(book, book ?? {}) : null), [book, mode]);
  const [exporting, setExporting] = useState(false);
  const pageLimit = resolveBookSettings(data?.settings?.book).pageLimit;
  const [pages, setPages] = useState(null);
  useLiveEffect(isLive => {
    if (!pageLimit || book?.status !== 'ok') { setPages(null); return; }
    call('course.book.export', { course, estimateOnly: true }).then(done => { if (isLive()) setPages(done?.estimate?.book ?? null); }, () => {});
  }, [call, course, pageLimit, book?.revision, book?.status]);
  const [file, setFile] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const setBook = useCallback(next => setState(current => ({ ...current, book: next })), []);
  // 弄懂 / 加一段: the panel over the selected words (or a heading), and the tasks started from this page (the book is read again when one ends).
  const [ask, setAsk] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  const startAi = useCallback(async args => {
    try {
      const started = await call('generation.courseBook.explain', { course, ...args });
      setPending(current => new Set([...current, started.jobId]));
      notify({ text: ui('已开始：写好后会出现在这一段下面；任务页可以看进度。'), tone: 'success' });
      setAsk(null);
      window.getSelection?.()?.removeAllRanges?.();
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, notify]);
  // A task started here is looked at now and then (job.status) until it ends; then the book is read again, its block in place.
  usePolling(async () => {
    for (const jobId of pending) {
      let job;
      try { job = await call('job.status', { jobId }); } catch { continue; }
      const status = job?.status ?? job?.contract?.status;
      if (!status || isActiveJob({ status })) continue;
      setPending(current => { const next = new Set(current); next.delete(jobId); return next; });
      if (status === 'failed') notify({ text: job?.error?.message || job?.contract?.error?.message || ui('没有写成，可以在任务页重试。'), tone: 'error' });
      setState(current => ({ ...current, ticket: current.ticket + 1 }));
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
  const [open, setOpen] = useState(() => new Set());
  const [here, setHere] = useState(null);
  const [qa, setQa] = useState(() => new Set());
  // The fold of the AI blocks (kept per library and course in this browser): read by the points through AiFoldContext, so a fold draws only the blocks.
  const aiFold = useAiFold(root, course), foldAi = aiFold.fold;
  const [tocOpen, setTocOpen] = useState(wideNow);
  const restore = useRef(null), pageRef = useRef(null), first = useRef(keptBook(root, course)), placed = useRef(false);

  // Where to open: the point the 总纲 asked for, else where the learner was (heading and scroll), else the first chapter.
  useEffect(() => {
    // Once: a book read again later (a save, a Q&A added) keeps the chapters the learner has open.
    if (book?.status !== 'ok' || placed.current) return;
    placed.current = true;
    const kept = first.current, wanted = kept?.target ?? kept?.heading, row = wanted ? rowOf(rows, wanted) : null;
    // A typed heading is not in the manifest: its chapter was kept with it.
    const chapter = row ? chapters[row.chapter]?.hid : kept?.chapter && wanted ? kept.chapter : chapters[0]?.hid;
    setOpen(new Set(chapter ? [chapter] : []));
    setHere(row?.hid ?? (kept?.chapter && wanted) ?? chapter ?? null);
    restore.current = row || (kept?.chapter && wanted) ? { hid: row?.hid ?? wanted, offset: kept?.target ? null : kept?.offset ?? null } : null;
    first.current = null;
    keepBook(root, course, { target: null });
  }, [book]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    // In 翻看 a point is its row of the view (`flip-<id>`), in 预览 its heading.
    const wanted = restore.current, element = wanted && (document.getElementById(`book-${wanted.hid}`) || document.getElementById(`flip-${wanted.hid}`));
    if (!element) return;
    restore.current = null;
    // One jump, not smooth: the heading where it was on screen (from the way back), else just under the top of the scroller (from the 目录).
    const scroller = scrollerOf(element), top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + element.getBoundingClientRect().top - (wanted.offset ?? top + 16), behavior: 'instant' });
  });
  // 你在这里: the highest heading on screen of the open chapters.
  useEffect(() => {
    const scope = pageRef.current;
    if (!scope || typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new Map();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) seen.set(entry.target.dataset.bookHeading, entry.isIntersecting ? entry.boundingClientRect.top : null);
      const top = [...seen].filter(([, at]) => at !== null).sort((a, b) => a[1] - b[1])[0];
      if (top) setHere(top[0]);
    });
    scope.querySelectorAll('[data-book-heading]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [open, book]);

  // The way back after practice: the heading just above the link (a typed heading too), where it was on screen, and the chapter that holds it.
  const remember = useCallback((hid, from) => {
    // From 翻看: its row of the point, where it was on screen (the view comes back in 翻看, kept per course).
    const flipPoint = from?.closest?.('[data-flip-point]');
    if (flipPoint) {
      const id = flipPoint.dataset.flipPoint, row = rowOf(rows, id);
      keepBook(root, course, { heading: id, offset: flipPoint.querySelector(`#flip-${id}`)?.getBoundingClientRect().top ?? 0, target: null, chapter: row ? chapters[row.chapter]?.hid ?? null : null });
      return;
    }
    const headings = from && pageRef.current ? [...pageRef.current.querySelectorAll('[data-book-heading]')].filter(item => item.compareDocumentPosition(from) & 4) : [];
    const element = headings.at(-1) || document.getElementById(`book-${hid}`), row = rowOf(rows, hid);
    keepBook(root, course, { heading: element?.dataset.bookHeading || hid, offset: element ? element.getBoundingClientRect().top : 0, target: null,
      chapter: row ? chapters[row.chapter]?.hid ?? null : null });
  }, [root, course, rows, chapters]);
  const goTo = useCallback(id => {
    const entry = toc.find(item => item.id === id);
    if (entry?.chapter) setOpen(current => new Set([...current, entry.chapter]));
    restore.current = { hid: id, offset: null };
    setHere(id);
    if (!wideNow()) setTocOpen(false);
  }, [toc]);
  const handlers = useMemo(() => ({
    gone: goneSet(book?.missing),
    qaOpen: heading => qa.has(heading),
    toggleQa: heading => setQa(current => { const next = new Set(current); if (next.has(heading)) next.delete(heading); else next.add(heading); return next; }),
    source: (sourceId, quote) => onOpenSource?.(sourceId, quote),
    card: (ref, from, element) => { remember(from, element); onPractice([ref], { resume: true }); },
    // 练 N 道: the next N of the point's questions in a practice round's order (due, weak, new); an open round of exactly those goes on.
    practice: async (heading, n, from, element) => {
      const row = rowOf(rows, heading);
      if (!row) { notify(ui('这一节已不在总纲里。')); return; }
      try {
        const { practice } = await call('course.outline', { course, pick: { keys: [row.key] } });
        const scope = practice?.scope.slice(0, n) || [];
        if (!scope.length) { notify(ui('这一节还没有题。')); return; }
        remember(from, element);
        onPractice(scope, { resume: true });
      } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    },
    create: onCreate,
    reload: () => setState(current => ({ ...current, ticket: current.ticket + 1 })),
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
  }), [book, qa, rows, call, course, notify, onCreate, onOpenSource, onPractice, remember, choosing, setBook, startAi, foldAi]);
  const writeBook = useCallback(async () => {
    try {
      await act('generation.courseBook.build', { course }, result => notify({ text: bookStartedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true });
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [act, course, notify]);

  const courseName = course === '' ? ui('未分类课程') : course || '';
  // 期末一周 needs an exam date: without one a quiet link to the course settings, and with one beyond the window a quiet line saying when the week starts.
  const courseRecord = (data?.courses || []).find(item => item.name === course);
  const dateHint = book?.status === 'ok' && book.notes ? crunchDateHint(courseRecord?.exam, crunchWindow(data?.settings?.book)) : null;
  const dateLine = dateHint?.kind === 'later' ? <p className="book-header__crunch">{uiFormat('期末一周在考前 {0} 天开始', [dateHint.window])}</p>
    : dateHint?.kind === 'none' && courseRecord?.id && onCourseSettings ? <p className="book-header__crunch">
      <Button variant="link" size="sm" onClick={() => onCourseSettings(courseRecord.id)}>{ui('设置考试日期，开启期末一周')}</Button></p> : null;
  const header = <PageHeader className="book-header" back={{ label: ui('返回总纲'), onClick: onBack }} title={uiFormat('复习全书 · {0}', [courseName])}
    titleProps={{ tabIndex: -1, 'data-context-heading': true }}>
    {book?.status === 'ok' && book.notes && <div className="book-header__tools">
      <SegmentedControl size="sm" label={ui('看书页的方式')} className="book-header__mode" value={mode} onChange={setMode}
        options={[{ value: 'preview', label: ui('预览') }, { value: 'source', label: ui('原文') }, { value: 'lookup', label: ui('查找') }, { value: 'flip', label: ui('翻看') }]} />
      {mode === 'preview' && <Button size="sm" variant="quiet" icon="list" className="book-header__toc" aria-expanded={tocOpen} onClick={() => setTocOpen(value => !value)}>{ui('目录')}</Button>}
      {crunchDay && mode !== 'source' && <Button size="sm" variant="quiet" icon="calendar" className="book-header__today" aria-expanded={todayOpen} onClick={() => setTodayOpen(value => !value)}>{ui('今天读哪几节')}</Button>}
      <Button size="sm" variant="secondary" icon="download" className="book-header__export" onClick={() => setExporting(true)}>{ui('导出')}</Button>
      {pages !== null && pageLimit && <span className="book-header__budget" data-over={pages > pageLimit || undefined}>
        {uiFormat('导出约 {0} 页 / 上限 {1} 页', [pages, pageLimit])}{pages > pageLimit ? ` · ${budgetText(pages, pageLimit).text}` : ''}</span>}
    </div>}
    {dateLine}
  </PageHeader>;
  if (state.error && !book) return <section className="page book-page">{header}<ErrorState error={state.error} title={ui('复习全书读取失败')} onRetry={() => setState(current => ({ ...current, ticket: current.ticket + 1 }))} /></section>;
  if (!book) return <section className="page book-page">{header}<LoadingState label={ui('正在打开复习全书…')} /></section>;
  if (book.status !== 'ok') return <section className="page book-page">{header}<EmptyState icon="book" title={ui('这门课还没有总纲')}
    description={ui('复习全书按总纲的知识点排，先在总纲页生成总纲。')} primary={{ label: ui('返回总纲'), onClick: onBack }} /></section>;
  if (!book.notes) {
    const writing = runningBuild(data?.jobs, course, BOOK_BUILD_KIND), model = modelReadiness(data);
    return (
      <section className="page book-page">
        {header}
        {writing ? <p className="book-writing" role="status"><LoadingState inline label={writingText(writing)} />
          {onOpenTask && <Button variant="link" size="sm" onClick={() => onOpenTask(writing.jobId)}>{ui('看进度')}</Button>}</p>
          : <EmptyState icon="book" title={ui('还没有复习全书')} description={ui('「生成复习全书」给每个知识点写讲解；写好后在这里读，点题目链接就去练。')}
            primary={{ label: ui('生成复习全书'), icon: 'book', onClick: writeBook, disabled: !model.ready }} />}
        <ModelSetupGate variant="compact" feature="reviewBook" model={model} />
      </section>
    );
  }
  const exportDialog = exporting && <BookExport course={course} pageLimit={pageLimit} onClose={() => setExporting(false)} />;
  // 今天读哪几节: today's day of the plan, under the header (the same day the home's 期末一周 card shows).
  const todayPanel = crunchDay && todayOpen && mode !== 'source' && <section className="book-today" aria-label={ui('今天读哪几节')}>
    <CrunchDay course={course} daysLeft={crunch.daysLeft} day={crunchDay} points={crunchPoints}
      onRead={point => { if (crunchDay.mode === 'flip') { setMode('flip'); return; } setMode('preview'); goTo(point.id); }}
      onPractice={(point, element) => handlers.practice(point.id, 5, point.id, element)} onMarkRead={(point, on) => mark(point.id, 'read', on)}
      onFlip={() => setMode('flip')} onMockStarted={onExamRun} />
  </section>;
  if (mode === 'source') return (
    <section className="page book-page">
      {header}
      <BookEditor key={book.course} book={book} file={file && book.files[file] ? file : defaultFile(book, here)} onPick={setFile} onChanged={setBook} theme={theme} />
      {exportDialog}
    </section>
  );
  // 翻看 (M7): the points in the plan's order, their 易错点 first; a point opens in 预览 at its heading.
  if (mode === 'flip') return (
    <section className="page book-page">
      {header}
      {todayPanel}
      {/* Drawn once the plan is read, so its order does not change under the learner (nor under the way back after practice). */}
      {crunch ? <AiFoldContext.Provider value={aiFold}><BookFlip book={book} crunch={crunch} course={course} handlers={handlers} onMark={(hid, on) => mark(hid, 'seen', on)}
        onGo={hid => { setMode('preview'); goTo(hid); }} onMockStarted={onExamRun} /></AiFoldContext.Provider> : <LoadingState label={ui('正在排期末一周…')} />}
      {ask && <BookAiAsk target={ask} model={modelReadiness(data)} onStart={args => startAi({ heading: ask.heading, ...args })} onClose={() => setAsk(null)} />}
      {exportDialog}
    </section>
  );
  // A code of 查找 opens the book (预览) at its heading.
  if (mode === 'lookup' && lookup) return (
    <section className="page book-page">
      {header}
      <BookLookup lookup={lookup} onGo={hid => { setMode('preview'); goTo(hid); }} />
      {exportDialog}
    </section>
  );
  return (
    <section className="page book-page" ref={pageRef}>
      {header}
      {todayPanel}
      <div className={tocOpen ? 'book-layout book-layout--toc' : 'book-layout'}>
        {tocOpen && <nav className="book-toc" aria-label={ui('目录')}><BookToc entries={toc} here={here} onGo={goTo} /></nav>}
        <div className="book-read" onMouseUp={onSelect}>
          <AiFoldContext.Provider value={aiFold}>
            {chapters.map(chapter => <BookChapter key={chapter.hid} node={chapter} open={open.has(chapter.hid)} course={course} handlers={handlers}
              onToggle={value => setOpen(current => { const next = new Set(current); if (value) next.add(chapter.hid); else next.delete(chapter.hid); return next; })} />)}
          </AiFoldContext.Provider>
        </div>
      </div>
      {ask && <BookAiAsk target={ask} model={modelReadiness(data)} onStart={args => startAi({ heading: ask.heading, ...args })} onClose={() => setAsk(null)} />}
      {exportDialog}
    </section>
  );
}
