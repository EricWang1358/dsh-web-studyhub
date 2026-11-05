import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { dayKind } from './crunch-words.js';
import { shortDate } from './plan-model.js';

/* The next days of a 备考计划 under today's day (ui/book/PlanSection.jsx for a plan by the exam date, ui/book/WeeklyDays.jsx for a weekly one): the date, the kind of day and
   its size, one line each. `days`: the schedule's days after today (ui/book/plan-model.js upcomingDays). */

/** What one later day holds, in a few words. */
const summary = item => (item.mode === 'mock' ? ui('整套模拟卷') : item.mode === 'off' ? '' : !item.points.length ? ui('没有新的节') : uiFormat('{0} 节 · 约 {1} 分钟', [item.points.length, item.minutes]));

export default function NextDays({ days }) {
  if (!days.length) return null;
  return (
    <ul className="book-plan__next" aria-label={ui('接下来几天')}>
      {days.map(item => <li key={item.date} className="book-plan__day" data-mode={item.mode}>
        <span className="book-plan__date">{shortDate(item.date)}</span> <span className="book-plan__kind">{dayKind(item)}</span>
        {summary(item) && <span className="book-plan__summary">{summary(item)}</span>}
      </li>)}
    </ul>
  );
}
