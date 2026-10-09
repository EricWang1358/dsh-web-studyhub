import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Combobox, EmptyState, ErrorState, LoadingState, PageHeader, Tooltip } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { MasteryLine } from '../document-preview/practice/MasteryMark.jsx';
import OutlineTree from './OutlineTree.jsx';
import { emptyPick, isPicked, keepView, keptView, outlineRows, pickArgs, pickCard, pickRow } from './model.js';
import { cappedText, courseLine, pickedText, startPickedText, whatText } from './words.js';
import css from './outline.css';

/* 总纲 (course outline), step 1: the current course's materials as a tree (资料 → 章节) with the questions placed where they point
   (course.outline, lib/course-outline.js). Pick rows or questions and practise them; a row practises its own questions. A practice round
   orders its questions due → weak → new (the run's own order), at most 200 at a time. Reached from the home's course area; 返回学习库 goes back. */

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
  useEffect(() => {
    if (!isPicked(pick)) { setPicked(null); return undefined; }
    let live = true;
    call('course.outline', { course, ...(deckId ? { deckId } : {}), pick: pickArgs(pick) }).then(result => { if (live) setPicked(result.practice); }, () => {});
    return () => { live = false; };
  }, [call, course, deckId, pick]);
  return picked;
}

/** data: the library snapshot; onBack(); onCreate() (创建题组); onPractice(scope, { resume }) starts the round and keeps the way back here. */
export default function CourseOutline({ data, onBack, onCreate, onPractice }) {
  const { call, notify } = useStudy();
  const course = data?.focus?.course ?? null, root = data?.root || '';
  const kept = keptView(root, course);
  const [open, setOpen] = useState(() => new Set(kept?.open || []));
  const [deckId, setDeckId] = useState(kept?.deckId || '');
  const [pick, setPick] = useState(emptyPick);
  const { outline, details, error, retry } = useOutline({ call, course, deckId, open, revision: data?.revision });
  const picked = usePicked({ call, course, deckId, pick });
  useEffect(() => { keepView(root, course, { open, deckId }); }, [root, course, open, deckId]);
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
    actions={{ onBack, onCreate, retry, toggle, onPick, onPickCard, onPracticeRow, clearPick: () => setPick(emptyPick()), practisePicked: () => practise(pickArgs(pick)),
      chooseDeck: value => { setDeckId(value); setPick(emptyPick()); } }} />;
}

/**
 * The page as drawn from what was read: `outline` / `details` (course.outline's answer and its opened rows), `open` (Set of keys), `deckId`,
 * `pick` (./model.js) and `picked` (its practice answer, null while counting). actions: onBack, onCreate, retry, toggle(key, open), onPick, onPickCard,
 * onPracticeRow(row), clearPick, practisePicked, chooseDeck(id).
 */
export function CourseOutlineView({ course, outline, details = {}, error = null, open, deckId = '', pick, picked = null, actions }) {
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
        <Tooltip layer content={whatText(outline.limit)}><span className="outline-what" tabIndex={0}>{ui('总纲是什么？')}</span></Tooltip>
      </p>}
    </PageHeader>
  );
  if (error && !outline) return <section className="page outline-page">{header}<ErrorState error={error} title={ui('总纲读取失败')} onRetry={actions.retry} /></section>;
  if (!outline) return <section className="page outline-page">{header}<LoadingState label={ui('正在读取总纲…')} /></section>;
  const nothing = outline.status === 'empty' || outline.total === 0;
  return (
    <section className="page outline-page">
      {header}
      {nothing && <EmptyState icon="book" title={outline.status === 'empty' ? ui('还没有课程') : ui('这门课还没有题')}
        description={ui('在「创建题组」里从资料出题，题目会按资料的章节排进总纲。')} primary={{ label: ui('创建题组'), icon: 'sparkle', onClick: actions.onCreate }} />}
      {rows.length > 0 && <OutlineTree rows={rows} details={details} pick={pick} onToggle={actions.toggle} onPick={actions.onPick} onPickCard={actions.onPickCard} onPractice={actions.onPracticeRow} label={ui('总纲')} />}
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
