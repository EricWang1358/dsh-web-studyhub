import React, { useEffect, useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Dialog, InlineConfirm, LoadingState } from '../components/index.js';
import BookEditor from './BookEditor.jsx';
import BookFlip from './BookFlip.jsx';
import BookLookup from './BookLookup.jsx';
import CrunchDay from './CrunchDay.jsx';
import MockPaper from './MockPaper.jsx';
import { AiFoldContext } from './ai-fold.js';
import { bookLookup } from '../../lib/course-book-lookup.js';

/* The review book's views that are not the reading surface (docs/review-book.md "More"), each reached from 「⋯ 更多」: the editor of one point and 翻看 take
   the page's place with 「完成 · 回到阅读」 (back at the same point); 速查页 and the mock paper open in a dialog over the book (整本书 › 发给主会话 opens nothing: ui/book/more-actions.js). Each wraps
   today's component unchanged (S4 replaces the editor, S5 翻看 and the mock paper). */

/** The row on top of a view that took the page's place: what it is, and the way back to reading. */
function ModeBar({ title, onDone }) {
  return (
    <div className="book-mode__bar">
      <p className="book-mode__title">{title}</p>
      <Button size="sm" variant="secondary" icon="arrow-left" className="book-mode__done" onClick={onDone}>{ui('完成 · 回到阅读')}</Button>
    </div>
  );
}

/** While `on` (unsaved edits in the editor), closing or reloading the tab asks first (the browser's own question). */
export function useUnsavedWarning(on) {
  useEffect(() => {
    if (!on || typeof window === 'undefined') return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [on]);
}

/** The point's files in the editor, the explanation first (the file picker still lists every file of the book). */
export const editFile = (book, step) => (step?.hid === 'unplaced' ? book.unplaced.file : step?.node.files?.gen ?? null);

/** 编辑这个知识点: the editor on the point's files. Leaving with unsaved text asks first (`leaving`: what to do once the learner agrees; onStay keeps editing). */
export function EditView({ book, step, theme, onChanged, onDirty, leaving, onLeave, onStay, onDone }) {
  const [file, setFile] = useState(() => editFile(book, step) ?? Object.keys(book.files)[0]);
  const title = step ? uiFormat('编辑 · {0}', [[step.node.number, step.node.title].filter(Boolean).join(' ')]) : ui('编辑');
  return (
    <section className="book-mode" aria-label={ui('编辑这个知识点')}>
      <ModeBar title={title} onDone={onDone} />
      {leaving && <InlineConfirm title={ui('还有没保存的改动')} confirmLabel={ui('丢掉改动，离开')} cancelLabel={ui('继续编辑')} onConfirm={onLeave} onCancel={onStay}>
        {ui('离开编辑会丢掉这些改动；先按「保存」就不会丢。')}</InlineConfirm>}
      <BookEditor key={book.course} book={book} file={file && book.files[file] ? file : Object.keys(book.files)[0]} onPick={setFile} onChanged={onChanged} onDirty={onDirty} theme={theme} />
    </section>
  );
}

/** 翻看: the points in the plan's order, their 易错点 first; a point's 「在书里看这个知识点」 goes back to reading at it. */
export function FlipView({ book, crunch, course, handlers, aiFold, onMark, onGo, onMockStarted, onDone }) {
  return (
    <section className="book-mode" aria-label={ui('翻看')}>
      <ModeBar title={ui('翻看 · 易错点多的在前')} onDone={onDone} />
      {/* Drawn once the plan is read, so its order does not change under the learner (nor under the way back after practice). */}
      {crunch ? <AiFoldContext.Provider value={aiFold}><BookFlip book={book} crunch={crunch} course={course} handlers={handlers} onMark={onMark} onGo={onGo}
        onMockStarted={onMockStarted} /></AiFoldContext.Provider> : <LoadingState label={ui('正在排期末一周…')} />}
    </section>
  );
}

/** 今天读哪几节: today's day of the plan, under the bar (the same day the home's 期末一周 card shows). */
export function TodayPanel({ course, crunch, day, points, onRead, onPractice, onMarkRead, onFlip, onMockStarted }) {
  return (
    <section className="book-today" aria-label={ui('今天读哪几节')}>
      <CrunchDay course={course} daysLeft={crunch.daysLeft} day={day} points={points} onRead={onRead} onPractice={onPractice} onMarkRead={onMarkRead}
        onFlip={onFlip} onMockStarted={onMockStarted} />
    </section>
  );
}

/** 速查页 in a dialog (without its 目录, which the page has): a code opens the reading surface at that point and closes the dialog. */
export function LookupDialog({ book, onGo, onClose }) {
  const lookup = useMemo(() => bookLookup(book, book), [book]);
  return (
    <Dialog title={ui('速查页')} size="lg" className="book-lookup-dialog" onClose={onClose}>
      {lookup && <BookLookup lookup={lookup} toc={false} onGo={hid => { onClose(); onGo(hid); }} />}
    </Dialog>
  );
}

/** 出一套模拟卷: today's points when the plan has a day, else the whole book; it asks what the paper would take at once. */
export function MockDialog({ course, pointIds, onStarted, onClose }) {
  return (
    <Dialog title={ui('出一套模拟卷')} size="sm" className="book-mock-dialog" onClose={onClose}>
      <MockPaper course={course} pointIds={pointIds} autoAsk onCancel={onClose} onStarted={run => { onClose(); onStarted?.(run); }} />
    </Dialog>
  );
}
