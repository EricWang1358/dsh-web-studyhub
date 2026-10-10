import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import CrunchDay from './CrunchDay.jsx';
import { crunchWindow } from '../../lib/book-settings.js';
import { daysUntilExam } from '../../lib/courses.js';
import { localDate } from '../../lib/board-model.js';
import css from './book.css';

/* 期末一周 on the home (M7), under 今天先做什么: for each course whose exam date is within its window (settings.book.crunchWindowDays, default 21) and
   that has a review book, today's day of its plan (book.crunch { all: true }): why, the points with 去读 / 练 5 道 or 翻看, the mock paper. Nothing
   shows for a course without an exam date or a book. Read only; the plan is made by the program, no model call.
   data: the snapshot; onOpenBook(course, { target?, view? }) opens the course's book (at a point, in 翻看 or with 今天读哪几节 open);
   onPractice(course, point) practises the point's next 5; onExamRun(run) enters the mock exam. */
export default function CrunchCard({ data, onOpenBook, onPractice, onExamRun }) {
  useInjectCss(css, 'study-book');
  const { call } = useStudy();
  const windowDays = crunchWindow(data?.settings?.book), date = localDate();
  // Only asked when a course's exam is near: the snapshot carries the courses' exam dates.
  const near = (data?.courses || []).filter(course => { const left = daysUntilExam(course?.exam); return left !== null && left >= 0 && left <= windowDays; }).map(course => course.name);
  const key = near.join('\u0000');
  const [state, setState] = useState(null);
  useLiveEffect(isLive => {
    if (!key) { setState(null); return; }
    call('book.crunch', { all: true, date }).then(result => { if (isLive()) setState(result); }, () => { if (isLive()) setState(null); });
  }, [call, key, date, data?.revision]);
  const courses = (state?.courses || []).filter(entry => entry.today);
  if (!key || !courses.length) return null;
  return courses.map(entry => {
    const name = entry.course === '' ? ui('未分类课程') : entry.course;
    return (
      <section key={entry.course} className="crunch-card" aria-label={uiFormat('期末一周 · {0}', [name])} data-course={entry.course}>
        <p className="crunch-card__eyebrow">{uiFormat('期末一周 · {0}', [name])}</p>
        <CrunchDay course={entry.course} daysLeft={entry.daysLeft} day={entry.today} points={entry.points} max={5}
          onRead={point => onOpenBook(entry.course, { target: point.key, view: entry.today.mode === 'flip' ? 'flip' : null })}
          onPractice={point => onPractice(entry.course, point)} onFlip={() => onOpenBook(entry.course, { view: 'flip' })}
          onMore={() => onOpenBook(entry.course, { view: 'today' })} onMockStarted={onExamRun} />
        <Button variant="link" size="sm" className="crunch-card__open" data-usage="home.crunch" onClick={() => onOpenBook(entry.course, { view: 'today' })}>{ui('打开复习全书')}</Button>
      </section>
    );
  });
}
