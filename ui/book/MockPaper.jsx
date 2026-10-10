import React, { useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Field, InlineMessage, NumberInput } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { EXAM_LIMIT_MS } from '../../lib/exam-timing.js';
import { QUESTION_COUNT } from '../../lib/limits.js';
import { leftOutText } from './crunch-words.js';

/* 「用这几节出一套模拟卷」 (M7): the same control on the book page and on the home's 期末一周 card. A click asks what the paper would take (book.mock.plan:
   how many questions the points have, how many single or multiple choice can go in, what the exam mode leaves out) and says it before anything starts;
   开始模拟卷 starts the ordinary exam (book.mock → the exam page, unchanged). pointIds: the heading ids (none: today's points of the plan, else the
   whole book); onStarted(run) enters the exam run. */
export default function MockPaper({ course, pointIds, onStarted, className }) {
  const { call, notify } = useStudy();
  const [plan, setPlan] = useState(null), [count, setCount] = useState(''), [busy, setBusy] = useState(false);
  const scope = { course, ...(pointIds ? { pointIds } : {}) };
  const ask = async () => {
    setBusy(true);
    try { const next = await call('book.mock.plan', scope); setPlan(next); setCount(String(next.count || '')); } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    finally { setBusy(false); }
  };
  const most = plan ? Math.min(QUESTION_COUNT.max, plan.eligible) : 0, wanted = Number(count), valid = Number.isInteger(wanted) && wanted >= 1 && wanted <= most;
  const start = async event => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    try { const run = await call('book.mock', { course, pointIds: plan.points, count: wanted }); setPlan(null); onStarted?.(run); }
    catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
    finally { setBusy(false); }
  };
  if (!plan) return <Button size="sm" variant="secondary" icon="clock" className={className} busy={busy} disabled={busy} data-usage="book.mock" onClick={ask}>{ui('用这几节出一套模拟卷')}</Button>;
  const minutes = plan.limitMinutes ?? EXAM_LIMIT_MS / 60000, left = leftOutText(plan.leftOut);
  return (
    <div className={className ? `book-mock ${className}` : 'book-mock'} role="group" aria-label={ui('模拟卷')}>
      <p className="book-mock__line">{uiFormat('这 {0} 节共 {1} 道题，其中 {2} 道单选或多选可以进模拟卷。', [plan.points.length, plan.questions, plan.eligible])}</p>
      {left && <p className="book-mock__muted">{uiFormat('不进卷：{0}（模拟考试只考单选和多选）。', [left])}</p>}
      {plan.unknown?.length > 0 && <p className="book-mock__muted">{uiFormat('{0} 节已不在书里，没有算进去。', [plan.unknown.length])}</p>}
      {plan.eligible > 0 ? (
        <form className="book-mock__start" onSubmit={start}>
          <Field inline width="sm" label={ui('题数')}>
            <NumberInput suffix={ui('道')} min="1" max={String(most)} step="1" required value={count} disabled={busy} onChange={event => setCount(event.target.value)} />
          </Field>
          <span className="book-mock__muted">{plan.limitMinutes ? uiFormat('限时 {0} 分钟（课程的作答时间）', [minutes]) : uiFormat('限时 {0} 分钟', [minutes])}</span>
          <Button type="submit" size="sm" variant="secondary" busy={busy} disabled={busy || !valid}>{ui('开始模拟卷')}</Button>
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => setPlan(null)}>{ui('取消')}</Button>
        </form>
      ) : (
        <InlineMessage tone="warning" action={{ label: ui('知道了'), onClick: () => setPlan(null) }}>{ui('这几节没有单选或多选题，出不了模拟卷。')}</InlineMessage>
      )}
    </div>
  );
}
