import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button } from '../components/index.js';
import MockPaper from './MockPaper.jsx';
import { countdownText, dayKind, pointMeta, reasonText } from './crunch-words.js';

/* One day of the 期末一周 plan (M7, lib/crunch-plan.js) on the home's 期末一周 card: what kind of day it is, why it holds what it holds (one line), its points
   with 去读 / 练 5 道 (a learn day) or 翻看 (a 翻看 day), each marked 读完 (or 已看 on a 翻看 day) once it is, 翻看全书 on a 翻看 day and the mock paper of the
   day's points. In the book itself today's points are the 目录's 今天 group (ui/book/BookToc.jsx).
   day: the plan's day; points: its points ({ id, key, code, title, questions, tested, weak, pitfalls }); max: how many are listed before 还有 N 个 (onMore). */
export default function CrunchDay({ course, daysLeft, day, points, max = Infinity, onRead, onPractice, onFlip, onMore, onMockStarted }) {
  if (!day) return null;
  const done = new Set(day.done || []), shown = points.slice(0, max), rest = points.length - shown.length, flip = day.mode === 'flip';
  return (
    <div className="crunch-day" data-mode={day.mode}>
      <p className="crunch-day__head"><strong>{dayKind(day)}</strong> <span className="crunch-day__muted">{countdownText(daysLeft)}</span></p>
      <p className="crunch-day__reason">{reasonText(day.reason)}</p>
      {shown.length > 0 && <ul className="crunch-day__points">
        {shown.map(point => <li key={point.id} className="crunch-day__point" data-point={point.id}>
          <div className="crunch-day__copy">
            <span className="crunch-day__title"><span className="book-node__code">{point.code}</span> {point.title}
              {done.has(point.id) && <Badge tone="success">{flip ? ui('已看') : ui('读完')}</Badge>}</span>
            <span className="crunch-day__muted">{pointMeta(point)}</span>
          </div>
          <div className="crunch-day__actions">
            <Button variant="quiet" size="sm" onClick={() => onRead?.(point)}>{flip ? ui('翻看') : ui('去读')}</Button>
            {day.mode === 'learn' && point.questions > 0 && onPractice && <Button variant="quiet" size="sm" onClick={event => onPractice(point, event.currentTarget)}>{ui('练 5 道')}</Button>}
          </div>
        </li>)}
      </ul>}
      {rest > 0 && onMore && <Button variant="link" size="sm" className="crunch-day__more" onClick={onMore}>{uiFormat('还有 {0} 个', [rest])}</Button>}
      {(flip || points.length > 0) && <div className="crunch-day__bar">
        {flip && onFlip && <Button size="sm" variant="secondary" icon="book" onClick={onFlip}>{ui('翻看全书')}</Button>}
        {points.length > 0 && <MockPaper course={course} pointIds={points.map(point => point.id)} onStarted={onMockStarted} />}
      </div>}
    </div>
  );
}
