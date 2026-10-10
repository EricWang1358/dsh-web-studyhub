import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Checkbox, Combobox, Disclosure, EmptyState, ErrorState, LoadingState, PageHeader, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { MasteryLine } from '../document-preview/practice/MasteryMark.jsx';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { modelReadiness } from '../generation-status.js';
import { displayTitle } from '../../lib/document-title.js';
import OutlineTree from './OutlineTree.jsx';
import { BOOK_BUILD_KIND, bookDefaultOpen, emptyPick, isPicked, keepView, keptView, mainAction, outlineRows, paperChoices, pickArgs, pickCard, pickRow, runningBuild } from './model.js';
import { basisText, bookStartedText, bookWhatText, cappedText, courseLine, offerText, pickedText, runningText, startPickedText, startedText, whatText, writingText } from './words.js';
import css from './outline.css';

/* 总纲 (course outline): the current course's materials as a tree (资料 → 章节) with the questions placed where they point (course.outline,
   lib/course-outline.js); once the model has organised them (step 2, the task 整理总纲), the AI outline instead: 章 › 节 › 知识点 in learning order, each
   point holding the materials' rows its questions come from. Pick rows or questions and practise them; a row practises its own questions. A practice
   round orders its questions due → weak → new (the run's own order), at most 200 at a time. Reached from the home's course area; 返回学习库 goes back. */

/** The outline of `course` and the questions of the rows in `open`; reads again when the library changes. */
function useOutline({ call, course, deckId, open, revision }) {
  const [state, setState] = useState({ outline: null, details: {}, error: null });
  const ticket = useRef(0);
  const load = useCallback(async (expand, merge) => {
    const mine = ++ticket.current;
    try {
      const outline = await call('course.outline', { course, ...(deckId ? { deckId } : {}), expand });
      if (mine !== ticket.current) return;
      // A key asked for and not answered (a row that is gone) is kept as null, so it is not asked for again.
      const answered = { ...Object.fromEntries(expand.map(key => [key, null])), ...outline.open };
      setState(current => ({ outline, details: merge ? { ...current.details, ...answered } : answered, error: null }));
    } catch (error) { if (mine === ticket.current) setState(current => ({ ...current, error })); }
  }, [call, course, deckId]);
  // A new course, deck filter or library revision reads everything open again; opening a row reads only what is missing.
  useEffect(() => { load([...open], false); }, [load, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = state.outline ? [...open].filter(key => !(key in state.details)) : [];
  useEffect(() => { if (missing.length) load(missing, true); }, [missing.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, retry: () => load([...open], false) };
}

/** How many questions the pick is (once each), read from the backend, which knows every row's questions. */
function usePicked({ call, course, deckId, pick }) {
  const [picked, setPicked] = useState(null);
  useLiveEffect(isLive => {
    if (!isPicked(pick)) { setPicked(null); return; }
    call('course.outline', { course, ...(deckId ? { deckId } : {}), pick: pickArgs(pick) }).then(result => { if (isLive()) setPicked(result.practice); }, () => {});
  }, [call, course, deckId, pick]);
  return picked;
}

/** data: the library snapshot; onBack(); onCreate() (创建题组); onOpenSources() (the 资料 page, where a material is filed under a course); onPractice(scope, { resume }) starts the round and keeps the way back here;
    onOpenTask(jobId) shows a task in the 任务 console; onOpenSource(sourceId, quote) opens the original at a quote (a 角标 of the 复习全书). */
export default function CourseOutline({ data, onBack, onCreate, onOpenSources, onPractice, onOpenTask, onOpenSource }) {
  const { call, act, notify } = useStudy();
  const course = data?.focus?.course ?? null, root = data?.root || '';
  const kept = keptView(root, course);
  const [open, setOpen] = useState(() => new Set(kept?.open || []));
  const [deckId, setDeckId] = useState(kept?.deckId || '');
  const [pick, setPick] = useState(emptyPick);
  const { outline, details, error, retry } = useOutline({ call, course, deckId, open, revision: data?.revision });
  const picked = usePicked({ call, course, deckId, pick });
  // An outline seen for the first time opens its chapters (章 open, 节 closed); the view the learner left is kept otherwise.
  const bookId = outline?.book?.id ?? null, seen = useRef(kept?.bookId ?? null);
  useEffect(() => {
    if (!bookId || seen.current === bookId) return;
    seen.current = bookId;
    setOpen(current => new Set([...current, ...bookDefaultOpen(outline.book)]));
  }, [bookId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { keepView(root, course, { open, deckId, bookId: seen.current }); }, [root, course, open, deckId, bookId]);
  const organise = useCallback(async papers => {
    try {
      // The interface language goes with every request (uiLanguage), so the task speaks it without being told here.
      await act('generation.courseOutline.build', { course, ...(papers.length ? { papers } : {}) },
        result => notify({ text: startedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true });
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [act, course, notify]);
  // 生成复习全书 / 更新全书: one task; it organises the outline first when there is none or it is out of date, and with papers other than the outline's only marks it again.
  const writeBook = useCallback(async papers => {
    try {
      await act('generation.courseBook.build', { course, ...(papers.length ? { papers } : {}) },
        result => notify({ text: bookStartedText(result?.alreadyRunning), tone: 'success' }), { rethrow: true });
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [act, course, notify]);
  const toggle = useCallback((key, value) => setOpen(current => { const next = new Set(current); if (value) next.add(key); else next.delete(key); return next; }), []);
  const onPick = useCallback((key, on) => setPick(current => pickRow(current, key, on)), []);
  const onPickCard = useCallback((ref, on) => setPick(current => pickCard(current, ref, on)), []);

  // The scope is read at the click (the levels may have moved since the page was drawn), then the ordinary practice round starts on it.
  const practise = useCallback(async (args, { resume = false } = {}) => {
    try {
      const { practice } = await call('course.outline', { course, ...(deckId ? { deckId } : {}), pick: args });
      if (!practice?.scope.length) { notify(ui('这里现在没有可练习的题。')); return; }
      if (practice.capped) notify({ text: cappedText(practice.total, practice.limit), tone: 'info' });
      onPractice(practice.scope, { resume });
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  }, [call, course, deckId, notify, onPractice]);
  const onPracticeRow = useCallback(row => practise({ keys: [row.key] }, { resume: !!row.node.resume }), [practise]);

  return <CourseOutlineView course={course} outline={outline} details={details} error={error} open={open} deckId={deckId} pick={pick} picked={picked}
    running={runningBuild(data?.jobs, course)} writing={runningBuild(data?.jobs, course, BOOK_BUILD_KIND)} model={modelReadiness(data)}
    actions={{ onBack, onCreate, onOpenSources, onOpenTask, onOpenSource, organise, writeBook, retry, toggle, onPick, onPickCard, onPracticeRow, clearPick: () => setPick(emptyPick()), practisePicked: () => practise(pickArgs(pick)),
      chooseDeck: value => { setDeckId(value); setPick(emptyPick()); } }} />;
}

/**
 * 生成总纲 / 生成复习全书 (更新全书) / 重新整理: one click starts the task (no estimate, no confirmation; the task page shows what it used). Without an outline
 * 生成总纲 is the main button (the book may start at once too: it organises the outline first); with one, the book is (更新全书 when its notes are out of date,
 * quiet when they are current) and 重新整理 is quiet. Under them, folded, the course's materials can be picked as sample papers (the likely ones first, none
 * picked): the outline is marked by them, and the book's 考情 follows. While a build of the course runs, the line says so and leads to the task.
 * `quiet`: something else on the page is the main action (the bar of picked questions).
 */
function Organise({ book, documents, running, writing, model, quiet, actions }) {
  const { busy } = useStudy();
  const [papers, setPapers] = useState(() => new Set());
  const choices = useMemo(() => paperChoices(documents), [documents]);
  const run = writing || running;
  if (run) return (
    <p className="outline-organise__running" role="status">
      <LoadingState inline label={writing ? writingText(writing) : runningText(running)} />
      {actions.onOpenTask && <Button variant="link" size="sm" onClick={() => actions.onOpenTask(run.jobId)}>{ui('看进度')}</Button>}
    </p>
  );
  const flip = (key, on) => setPapers(current => { const next = new Set(current); if (on) next.add(key); else next.delete(key); return next; });
  const main = quiet ? null : mainAction(book), off = busy || !model.ready;
  const bookMain = main === 'book' || main === 'update';
  return (
    <div className="outline-organise__actions">
      {!book && <Button variant={main === 'outline' ? 'primary' : 'quiet'} size={main === 'outline' ? undefined : 'sm'} icon="sparkle" disabled={off}
        onClick={() => actions.organise([...papers])}>{ui('生成总纲')}</Button>}
      <Button variant={bookMain ? 'primary' : book ? 'quiet' : 'secondary'} size={bookMain || !book ? undefined : 'sm'} icon="book" disabled={off}
        onClick={() => actions.writeBook([...papers])}>{book?.notes ? ui('更新全书') : ui('生成复习全书')}</Button>
      {book && <Button variant="quiet" size="sm" icon="refresh" disabled={off} onClick={() => actions.organise([...papers])}>{ui('重新整理')}</Button>}
      {choices.length > 0 && <Disclosure className="outline-papers" summary={ui('提供了试卷？')} meta={papers.size ? uiFormat('已选 {0} 份', [papers.size]) : null}>
        <p className="outline-papers__note">{ui('勾选的资料当作样卷：总纲会标出样卷考过的知识点。不勾选也能生成，只是没有这个标记。')}</p>
        {book && <p className="outline-papers__note">{ui('已有复习全书时点「更新全书」：只重新对照样卷、改写考情，讲解不变。')}</p>}
        <ul className="outline-papers__list">
          {choices.map(choice => <li key={choice.key}><Checkbox label={displayTitle(choice.title)} hint={choice.likely ? ui('像样卷') : undefined} checked={papers.has(choice.key)}
            onChange={on => flip(choice.key, on)} /></li>)}
        </ul>
      </Disclosure>}
      <ModelSetupGate variant="compact" feature={book ? 'courseBook' : 'courseOutline'} model={model} />
    </div>
  );
}

/**
 * The page as drawn from what was read: `outline` / `details` (course.outline's answer and its opened rows), `open` (Set of keys), `deckId`,
 * `pick` (./model.js) and `picked` (its practice answer, null while counting), `running` (the course's 总纲 build in progress, ./model.js runningBuild) and `model`
 * (modelReadiness), `writing` (the course's 复习全书 build in progress, the same shape). actions: onBack, onCreate, onOpenSources, onOpenTask(jobId),
 * onOpenSource(sourceId, quote), organise(papers), writeBook(papers), retry, toggle(key, open), onPick, onPickCard, onPracticeRow(row), clearPick, practisePicked,
 * chooseDeck(id).
 */
export function CourseOutlineView({ course, outline, details = {}, error = null, open, deckId = '', pick, picked = null, running = null, writing = null, model = { ready: true },
  actions }) {
  useInjectCss(css, 'study-outline');
  const { busy } = useStudy();
  const rows = useMemo(() => outlineRows(outline, details, open), [outline, details, open]);
  const courseName = course === '' ? ui('未分类课程') : course;
  const header = (
    <PageHeader className="outline-header" back={{ label: ui('返回学习库'), onClick: actions.onBack }} title={course === null ? ui('总纲') : uiFormat('总纲 · {0}', [courseName])}
      titleProps={{ tabIndex: -1, 'data-context-heading': true }}
      scope={outline?.decks?.length > 1 ? <Combobox className="outline-deck" label={ui('按题组筛选')} aria-label={ui('按题组筛选')} value={deckId} onChange={actions.chooseDeck}
        options={[{ value: '', label: ui('全部题组') }, ...outline.decks.map(deck => ({ value: deck.id, label: deck.title, hint: uiFormat('{0} 题', [deck.total]) }))]}
        searchPlaceholder={ui('搜索题组')} emptyText={query => uiFormat('没有叫「{0}」的题组', [query])} /> : null}>
      {outline && <p className="outline-summary">
        <MasteryLine summary={outline.summary} title={courseName || ui('总纲')} />
        <span className="outline-summary__line">{courseLine(outline)}</span>
        <Tooltip layer content={outline.book ? bookWhatText(outline.limit) : whatText(outline.limit)}><span className="outline-what" tabIndex={0}>{ui('总纲是什么？')}</span></Tooltip>
      </p>}
    </PageHeader>
  );
  if (error && !outline) return <section className="page outline-page">{header}<ErrorState error={error} title={ui('总纲读取失败')} onRetry={actions.retry} /></section>;
  if (!outline) return <section className="page outline-page">{header}<LoadingState label={ui('正在读取总纲…')} /></section>;
  const nothing = outline.status === 'empty' || outline.total === 0, book = outline.book;
  // The one main button: none while questions are picked (the bar's is), and without an outline none while the course has no question (创建题组 is).
  const organise = <Organise book={book} documents={outline.documents} running={running} writing={writing} model={model} quiet={isPicked(pick) || (nothing && !book)}
    actions={actions} />;
  // 资料有更新: with a 复习全书, its own line (更新全书 organises the outline again too); else the outline's.
  const stale = book?.notes ? (book.notes.stale ? ui('资料有更新，建议更新全书') : null) : book?.stale ? ui('资料有更新，建议重新整理') : null;
  // With an outline the book is the main action, so 创建题组 of a course without questions is the quiet one.
  const create = { label: ui('创建题组'), icon: 'sparkle', onClick: actions.onCreate };
  return (
    <section className="page outline-page">
      {header}
      {book && <div className="outline-book-line">
        <p className="outline-book-line__basis">{basisText(book.orderBasis)}</p>
        {stale && <p className="outline-book-line__stale" role="status">{stale}</p>}
        {organise}
      </div>}
      {!book && outline.status === 'ok' && outline.documents.length > 0 && <section className="outline-organise" aria-label={ui('生成总纲')}>
        <p className="outline-organise__text">{offerText(outline.documents.length)}</p>
        {organise}
      </section>}
      {nothing && <EmptyState icon="book" title={outline.status === 'empty' ? ui('还没有课程') : ui('这门课还没有题')}
        description={ui('在「创建题组」里从资料出题，题目会按资料的章节排进总纲。')} primary={book ? undefined : create} secondary={book ? create : undefined} />}
      {rows.length > 0 && <OutlineTree rows={rows} details={details} pick={pick} papers={book?.papers || 0} onToggle={actions.toggle} onPick={actions.onPick} onPickCard={actions.onPickCard}
        onPractice={actions.onPracticeRow} onOpenSources={actions.onOpenSources} onOpenSource={actions.onOpenSource} label={ui('总纲')} />}
      {isPicked(pick) && <div className="outline-bar" role="region" aria-label={ui('已选的题')}>
        {picked ? <span className="outline-bar__count" aria-live="polite">{pickedText(picked.total)}</span> : <LoadingState inline className="outline-bar__count" label={ui('正在计算…')} />}
        {picked?.capped && <small className="outline-bar__note">{cappedText(picked.total, picked.limit)}</small>}
        <Button size="sm" variant="quiet" onClick={actions.clearPick}>{ui('清除')}</Button>
        <Button size="sm" variant="primary" icon="play" disabled={busy || !picked?.total} onClick={actions.practisePicked}>
          {startPickedText(picked ? Math.min(picked.total, picked.limit) : 0)}</Button>
      </div>}
    </section>
  );
}
