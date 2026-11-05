import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import CrunchDay from './CrunchDay.jsx';
import NextDays from './NextDays.jsx';
import { weekText } from './crunch-words.js';
import { upcomingDays } from './plan-model.js';

/* The daily part of a WEEKLY 备考计划 (深度定制, lib/plan-weekly.js; `schedule.weekly`): the line 「本周：第 3–4 章」, what is owed from earlier weeks, today's day (the same day
   component as everywhere) and the next days. There is no exam to hand over to: a plan by chapters per week runs to its last week. The same block is under the book's plan
   section and on the home (ui/book/WeeklyCard.jsx).
   answer: the course.plan answer; schedule: its schedule; course; `handlers` are CrunchDay's (onRead, onPractice, onMarkRead, onFlip, onMockStarted). */

export const weeklyPoints = (answer, day) => { const byId = new Map((answer.points || []).map(point => [point.id, point])); return (day?.points || []).map(id => byId.get(id)).filter(Boolean); };

export default function WeeklyDays({ answer, schedule, course, onMore, ...handlers }) {
  const { weekly, today } = schedule, points = weeklyPoints(answer, today), next = upcomingDays(schedule, '9999-12-31', 7);
  return (
    <div className="book-plan__week" data-tour="book-weekly" aria-label={ui('今天读哪几节')}>
      <p className="book-plan__weekline"><strong>{weekText(weekly)}</strong>
        {weekly.behind > 0 && <span className="book-plan__note">{uiFormat('前几周还有 {0} 节没学完，已排进本周。', [weekly.behind])}</span>}</p>
      {today && <CrunchDay course={course} day={today} points={points} max={onMore ? 5 : Infinity} onMore={onMore} onRead={handlers.onRead} onPractice={handlers.onPractice}
        onMarkRead={handlers.onMarkRead} onFlip={handlers.onFlip} onMockStarted={handlers.onMockStarted} />}
      <NextDays days={next} />
    </div>
  );
}
