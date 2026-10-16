import React, { useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Checkbox, Disclosure, ProgressBar } from '../components/index.js';
import PointBody from './PointBody.jsx';
import MockPaper from './MockPaper.jsx';
import { bookRows } from './model.js';
import { mistakeText, pointMeta, reasonText } from './crunch-words.js';
import { pointMistakes } from '../../lib/book-flip.js';
import { codeOf } from '../../lib/course-book-lookup.js';

/* 翻看 (M7): the book for the last days before the exam. Every point in the plan's 翻看 order (the most 易错点 first, then the weakest; book.crunch's
   `plan.order.flip`, the book's order without a plan), each with its 易错点 open (what the learner once asked, an answer card's pitfalls, what was
   explained: lib/book-flip.js) and its 讲解 folded (drawn only when opened). 已看 is kept per course (book.crunch.mark), so the progress survives;
   「用这些知识点出一套模拟卷」 takes the points picked here, else today's, else the whole book. Nothing here changes the book's files or its export. */
export default function BookFlip({ book, crunch, course, handlers, onMark, onGo, onMockStarted }) {
  const rows = useMemo(() => bookRows(book.nodes).filter(row => row.leaf), [book]);
  const mistakes = useMemo(() => pointMistakes(book), [book]);
  const [picked, setPicked] = useState(() => new Set());
  const [opened, setOpened] = useState(() => new Set());
  const byHid = new Map(rows.map(row => [row.hid, row])), points = new Map((crunch?.points || []).map(point => [point.id, point]));
  const order = (crunch?.plan?.order?.flip || []).filter(hid => byHid.has(hid));
  const list = [...order, ...rows.map(row => row.hid).filter(hid => !order.includes(hid))];
  const day = crunch?.status === 'ok' && crunch.plan.today?.mode === 'flip' ? crunch.plan.today : null, today = new Set(day?.points || []);
  const seen = list.filter(hid => points.get(hid)?.seen).length;
  const mockIds = picked.size ? list.filter(hid => picked.has(hid)) : today.size ? list.filter(hid => today.has(hid)) : list;
  const scopeText = picked.size ? uiFormat('出卷范围：已选的 {0} 个知识点', [picked.size]) : today.size ? uiFormat('出卷范围：今天的 {0} 个知识点', [today.size]) : uiFormat('出卷范围：全书 {0} 个知识点', [list.length]);
  const flip = (set, hid, on) => set(current => { const next = new Set(current); if (on) next.add(hid); else next.delete(hid); return next; });
  return (
    <div className="book-flip">
      <div className="book-flip__bar">
        <p className="book-flip__progress">{uiFormat('已看 {0} / {1} 个', [seen, list.length])}</p>
        <ProgressBar size="sm" value={seen} max={Math.max(1, list.length)} label={ui('翻看进度')} />
        {day && <p className="book-flip__reason">{reasonText(day.reason)}</p>}
        <p className="book-flip__muted">{ui('易错点多的在前，再按薄弱程度排；每个知识点先看你记下的易错点，讲解收起，要看再展开。')}</p>
        <div className="book-flip__mock">
          <span className="book-flip__muted">{scopeText}</span>
          <MockPaper key={mockIds.join(',')} course={course} pointIds={mockIds} onStarted={onMockStarted} />
        </div>
      </div>
      {list.map(hid => {
        const row = byHid.get(hid), point = points.get(hid), items = mistakes.get(hid) || [], open = opened.has(hid);
        return (
          <article key={hid} className="book-flip__point" data-flip-point={hid} data-seen={point?.seen ? 'true' : undefined}>
            <header className="book-flip__head">
              <h3 className="book-flip__title" id={`flip-${hid}`}>
                <span className="book-node__number">{row.number}</span> {row.title} <span className="book-node__code">{codeOf(hid)}</span>
                {today.has(hid) && <Badge tone="info">{ui('今天')}</Badge>}
              </h3>
              <div className="book-flip__checks">
                <Checkbox label={ui('已看')} checked={!!point?.seen} disabled={!point} onChange={on => onMark(hid, on)} />
                <Checkbox label={ui('选进模拟卷')} checked={picked.has(hid)} onChange={on => flip(setPicked, hid, on)} />
              </div>
            </header>
            {point && <p className="book-flip__muted">{pointMeta(point)}</p>}
            {items.length ? <ul className="book-flip__mistakes" aria-label={ui('易错点')}>
              {items.map((item, at) => <li key={`${item.kind}-${at}`} data-kind={item.kind}>{mistakeText(item)}</li>)}
            </ul> : <p className="book-flip__muted">{ui('这个知识点还没有记下的易错点。')}</p>}
            <Disclosure className="book-flip__explain" summary={ui('讲解')} open={open} onToggle={value => flip(setOpened, hid, value)}>
              {open && <PointBody node={row.node} course={course} handlers={handlers} level={4} />}
            </Disclosure>
            <Button variant="link" size="sm" className="book-flip__go" onClick={() => onGo(hid)}>{ui('在书里看这个知识点')}</Button>
          </article>
        );
      })}
    </div>
  );
}
