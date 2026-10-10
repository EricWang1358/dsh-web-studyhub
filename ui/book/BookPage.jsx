import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, EmptyState, ErrorState, LoadingState, PageHeader } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { modelReadiness } from '../generation-status.js';
import { BOOK_BUILD_KIND, runningBuild } from '../outline/model.js';
import { bookStartedText, writingText } from '../outline/words.js';
import BookChapter from './BookChapter.jsx';
import BookToc from './BookToc.jsx';
import { bookRows, goneSet, keepBook, keptBook, rowOf, tocEntries } from './model.js';
import css from './book.css';

/* 复习全书 (docs/plans/review-book.md, M1: read only). The book of the current course (course.book.open, lib/course-book-files.js): the 目录 beside the
   rendered Markdown at wide widths, one column with a folded 目录 at narrow ones. Only the open chapters render (I8). A question link goes to the practice
   page with the way back (回到复习全书), and the page comes back at the same heading and scroll; 本节问答 opens the point's questions and answers in place.
   Reached from the 总纲 page (打开书页). */

const wideNow = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(min-width: 900px)').matches;
const scrollerOf = element => {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
};

/** data: the snapshot; onBack() (the 总纲); onPractice(scope, { resume }) keeps the way back; onOpenSource(sourceId, quote) (the reader); onCreate() (出题); onOpenTask(jobId). */
export default function BookPage({ data, onBack, onPractice, onOpenSource, onCreate, onOpenTask }) {
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
  const chapters = useMemo(() => (book?.status === 'ok' ? [...book.nodes, ...(book.unplaced.text.trim() ? [{ hid: 'unplaced', title: book.unplaced.title, text: book.unplaced.text, number: '' }] : [])] : []), [book]);
  const [open, setOpen] = useState(() => new Set());
  const [here, setHere] = useState(null);
  const [qa, setQa] = useState(() => new Set());
  const [tocOpen, setTocOpen] = useState(wideNow);
  const restore = useRef(null), pageRef = useRef(null), first = useRef(keptBook(root, course));

  // Where to open: the point the 总纲 asked for, else where the learner was (heading and scroll), else the first chapter.
  useEffect(() => {
    if (book?.status !== 'ok') return;
    const kept = first.current, wanted = kept?.target ?? kept?.heading, row = wanted ? rowOf(rows, wanted) : null;
    const chapter = row ? chapters[row.chapter]?.hid : chapters[0]?.hid;
    setOpen(new Set(chapter ? [chapter] : []));
    setHere(row?.hid ?? chapter ?? null);
    restore.current = row ? { hid: row.hid, offset: kept?.target ? null : kept?.offset ?? null } : null;
    first.current = null;
    keepBook(root, course, { target: null });
  }, [book]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const wanted = restore.current, element = wanted && document.getElementById(`book-${wanted.hid}`);
    if (!element) return;
    restore.current = null;
    element.scrollIntoView({ block: 'start' });
    if (wanted.offset !== null) scrollerOf(element)?.scrollBy(0, element.getBoundingClientRect().top - wanted.offset);
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

  const remember = useCallback(hid => {
    const element = document.getElementById(`book-${hid}`);
    keepBook(root, course, { heading: hid, offset: element ? element.getBoundingClientRect().top : 0, target: null });
  }, [root, course]);
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
    card: (ref, from) => { remember(from); onPractice([ref], { resume: true }); },
    // 练 N 道: the next N of the point's questions in a practice round's order (due, weak, new); an open round of exactly those goes on.
    practice: async (heading, n, from) => {
      const row = rowOf(rows, heading);
      if (!row) { notify(ui('这一节已不在总纲里。')); return; }
      try {
        const { practice } = await call('course.outline', { course, pick: { keys: [row.key] } });
        const scope = practice?.scope.slice(0, n) || [];
        if (!scope.length) { notify(ui('这一节还没有题。')); return; }
        remember(from);
        onPractice(scope, { resume: true });
      } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    },
    create: onCreate,
  }), [book, qa, rows, call, course, notify, onCreate, onOpenSource, onPractice, remember]);
  const writeBook = useCallback(async () => {
    try {
      await act('generation.courseBook.build', { course }, result => notify({ text: bookStartedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true });
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [act, course, notify]);

  const courseName = course === '' ? ui('未分类课程') : course || '';
  const header = <PageHeader className="book-header" back={{ label: ui('返回总纲'), onClick: onBack }} title={uiFormat('复习全书 · {0}', [courseName])}
    titleProps={{ tabIndex: -1, 'data-context-heading': true }}>
    {book?.status === 'ok' && book.notes && <Button size="sm" variant="quiet" icon="list" className="book-header__toc" aria-expanded={tocOpen} onClick={() => setTocOpen(value => !value)}>{ui('目录')}</Button>}
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
  return (
    <section className="page book-page" ref={pageRef}>
      {header}
      <div className={tocOpen ? 'book-layout book-layout--toc' : 'book-layout'}>
        {tocOpen && <nav className="book-toc" aria-label={ui('目录')}><BookToc entries={toc} here={here} onGo={goTo} /></nav>}
        <div className="book-read">
          {chapters.map(chapter => <BookChapter key={chapter.hid} node={chapter} open={open.has(chapter.hid)} course={course} handlers={handlers}
            onToggle={value => setOpen(current => { const next = new Set(current); if (value) next.add(chapter.hid); else next.delete(chapter.hid); return next; })} />)}
        </div>
      </div>
    </section>
  );
}
