import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import CrunchDay from './CrunchDay.jsx';
import { weekText } from './crunch-words.js';
import { weeklyPoints } from './WeeklyDays.jsx';
import { localDate } from '../../lib/board-model.js';
import css from './book.css';

/* 本周 on the home (深度定制 4.4 S3), beside 期末一周 under 今天先做什么: for each active course whose 备考计划 is by chapters per week (`plan.by: 'weekly'`, lib/plan-weekly.js),
   the line 「本周：第 3–4 章」, today's day of that plan and the way into the book. A plan by the exam date is not here (its days are 期末一周's when the exam is near and the
   book page's section before). Nothing shows for a course without a weekly plan or a review book. Read only; the schedule is made by the program (course.plan), no model call.
   data: the snapshot; onOpenBook(course, { target? }) opens the course's book (at a point); onPractice(course, point) practises the point's next 5; onExamRun(run) enters the mock exam. */
export default function WeeklyCard({ data, onOpenBook, onPractice, onExamRun }) {
  useInjectCss(css, 'study-book');
  const { call } = useStudy();
  const date = localDate();
  const names = (data?.courses || []).filter(course => course?.plan?.by === 'weekly' && (course.plan.status ?? 'active') === 'active' && course.active !== false).map(course => course.name);
  const key = names.join('\u0000');
  const [answers, setAnswers] = useState([]);
  useLiveEffect(isLive => {
    if (!key) { setAnswers([]); return; }
    Promise.all(names.map(course => call('course.plan', { course, date }).catch(() => null))).then(list => { if (isLive()) setAnswers(list.filter(Boolean)); });
  }, [call, key, date, data?.revision]);
  const shown = answers.filter(answer => answer.status === 'ok' && answer.schedule?.weekly);
  if (!key || !shown.length) return null;
  return shown.map(answer => {
    const { schedule, course } = answer, name = course === '' ? ui('未分类课程') : course, day = schedule.today, points = weeklyPoints(answer, day);
    return (
      <section key={course} className="crunch-card" aria-label={uiFormat('本周 · {0}', [name])} data-course={course} data-tour="home-weekly">
        <p className="crunch-card__eyebrow">{uiFormat('本周 · {0}', [name])}</p>
        <p className="crunch-card__week"><strong>{weekText(schedule.weekly)}</strong></p>
        {day && points.length > 0 && <CrunchDay course={course} day={day} points={points} max={5} onRead={point => onOpenBook(course, { target: point.key })}
          onPractice={point => onPractice(course, point)} onMore={() => onOpenBook(course, {})} onMockStarted={onExamRun} />}
        <Button variant="link" size="sm" className="crunch-card__open" data-usage="home.weekly" onClick={() => onOpenBook(course, {})}>{ui('打开复习全书')}</Button>
      </section>
    );
  });
}
