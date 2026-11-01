import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, PageHeader, Tooltip } from '../components/index.js';
import { CourseSwitch } from '../study-map/CourseHeading.jsx';
import BookMoves from './BookMoves.jsx';

/* The review book's header (docs/review-book.md "Open it"): it scrolls away with the page. A quiet ink 「回到总纲」, the title 「复习全书」 with the course switcher
   (the home's: it makes another course current in the whole app; plain text when there is one course), a status line only while a book task runs, the
   one-off 「已切换到课程 X」 of the home's card and the 「笔记换了位置」 notice (one line once read; the list stays one click away). */

/** data: the snapshot; course, courseName; book: course.book.open's answer or null; writing: the running book task or null; switched; onBack, onCourse(course), onOpenTask(jobId), onUndoRebuild(outlineId). */
export default function BookHeader({ data, course, courseName, book, writing, switched, onBack, onCourse, onOpenTask, onUndoRebuild, onUpdate }) {
  const courses = data?.focus?.courses || [];
  const name = courses.length > 1 ? <Tooltip layer content={ui('会切换整个应用的当前课程')} anchorClassName="book-header__course">
    <CourseSwitch data={data} onFocus={next => onCourse(next.course)}>{courseName}</CourseSwitch></Tooltip> : courseName;
  return (
    <PageHeader compact className="book-header" back={{ label: ui('回到总纲'), onClick: onBack }} title={<>{ui('复习全书')}<span className="book-header__dot" aria-hidden="true"> · </span>{name}</>}
      titleProps={{ tabIndex: -1, 'data-context-heading': true }}>
      {writing && book?.status === 'ok' && book.notes && <p className="book-header__status" role="status">{ui('正在更新复习全书…')}
        {onOpenTask && <Button variant="link" size="sm" onClick={() => onOpenTask(writing.jobId)}>{ui('看进度')}</Button>}</p>}
      {/* The materials changed since the outline: the same 更新全书 as the 总纲 page's, said here because this is where it is read. */}
      {book?.status === 'ok' && book.outdated && book.notes && !writing && onUpdate && <p className="book-header__status" data-book-outdated="">{ui('资料有变化，这本书可能跟不上了。')}
        <Button variant="link" size="sm" onClick={onUpdate}>{ui('更新全书')}</Button></p>}
      {switched && <p className="book-header__status" role="status">{uiFormat('已切换到课程 {0}', [courseName])}</p>}
      {book?.status === 'ok' && book.moves && <BookMoves course={course} moves={book.moves} onUndo={onUndoRebuild} />}
    </PageHeader>
  );
}
