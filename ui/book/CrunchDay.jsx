import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Checkbox } from '../components/index.js';
import MockPaper from './MockPaper.jsx';
import { countdownText, dayKind, pointMeta, reasonText } from './crunch-words.js';

/* One day of the 期末一周 plan (M7, lib/crunch-plan.js): what kind of day it is, why it holds what it holds (one line), its points with 去读 / 练 5 道
   (a learn day) or 翻看 (a 翻看 day), 读完了 for a point without questions, 翻看全书 on a 翻看 day and the mock paper of the day's points. The same
   component on the home's 期末一周 card and under the book's 「今天读哪几节」.
   day: the plan's day; points: its points ({ id, key, code, title, questions, tested, weak, pitfalls }); max: how many are listed before 还有 N 节 (onMore). */
export default function CrunchDay({ course, daysLeft, day, points, max = Infinity, onRead, onPractice, onMarkRead, onFlip, onMore, onMockStarted }) {
  if (!day) return null;
  const done = new Set(day.done || []), shown = points.slice(0, max), rest = points.length - shown.length;
  return (
    <div className="crunch-day" data-mode={day.mode}>
      <p className="crunch-day__head"><strong>{dayKind(day)}</strong> <span className="crunch-day__muted">{countdownText(daysLeft)}</span></p>
      <p className="crunch-day__reason">{reasonText(day.reason)}</p>
      {shown.length > 0 && <ul className="crunch-day__points">
        {shown.map(point => <li key={point.id} className="crunch-day__point" data-point={point.id}>
          <div className="crunch-day__copy">
            <span className="crunch-day__title"><span className="book-node__code">{point.code}</span> {point.title}
              {done.has(point.id) && <Badge tone="success">{ui('已完成')}</Badge>}</span>
            <span className="crunch-day__muted">{pointMeta(point)}</span>
          </div>
          <div className="crunch-day__actions">
            <Button variant="quiet" size="sm" onClick={() => onRead?.(point)}>{day.mode === 'flip' ? ui('翻看') : ui('去读')}</Button>
            {day.mode === 'learn' && point.questions > 0 && onPractice && <Button variant="quiet" size="sm" onClick={event => onPractice(point, event.currentTarget)}>{ui('练 5 道')}</Button>}
            {day.mode === 'learn' && !point.questions && onMarkRead && <Checkbox label={ui('读完了')} checked={done.has(point.id)} onChange={on => onMarkRead(point, on)} />}
          </div>
        </li>)}
      </ul>}
      {rest > 0 && onMore && <Button variant="link" size="sm" className="crunch-day__more" onClick={onMore}>{uiFormat('还有 {0} 节', [rest])}</Button>}
      {(day.mode === 'flip' || points.length > 0) && <div className="crunch-day__bar">
        {day.mode === 'flip' && onFlip && <Button size="sm" variant="secondary" icon="book" onClick={onFlip}>{ui('翻看全书')}</Button>}
        {points.length > 0 && <MockPaper course={course} pointIds={points.map(point => point.id)} onStarted={onMockStarted} />}
      </div>}
    </div>
  );
}
