import React, { useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Checkbox, Disclosure, ProgressBar } from '../components/index.js';
import PointBody from './PointBody.jsx';
import MockPaper from './MockPaper.jsx';
import { bookRows } from './model.js';
import { splitPoint, takeawayOf } from './point-parts.js';
import { mistakeText, pointMeta, reasonText } from './crunch-words.js';
import { pointMistakes } from '../../lib/book-flip.js';
import { codeOf } from '../../lib/course-book-lookup.js';

/* 翻看 (M7 + 5.0.0 Evolution 2 #1): the book for the last days before the exam. Every point in the plan's 翻看 order (the most 易错点 first, then the weakest;
   book.crunch's `plan.order.flip`, the book's order without a plan), each with its 易错点 open (what the learner once asked, an answer card's pitfalls, what was
   explained: lib/book-flip.js) and its 讲解 folded (drawn only when opened). When `drill` (`settings.book.confusableDrill`) is enabled, each point also folds its
   one-sentence takeaway and K001 term-card definitions behind an active-recall veil until revealed, and offers a 「卡住了」 mark writing back to `book.crunch.mark`. */
export default function BookFlip({ book, crunch, course, handlers, drill = false, onMark, onMarkStuck, onGo, onMockStarted }) {
  const rows = useMemo(() => bookRows(book.nodes).filter(row => row.leaf), [book]);
  const mistakes = useMemo(() => pointMistakes(book), [book]);
  const [picked, setPicked] = useState(() => new Set());
  const [opened, setOpened] = useState(() => new Set());
  const [revealed, setRevealed] = useState(() => new Set());
  const byHid = new Map(rows.map(row => [row.hid, row])), points = new Map((crunch?.points || []).map(point => [point.id, point]));
  const order = (crunch?.plan?.order?.flip || []).filter(hid => byHid.has(hid));
  const list = [...order, ...rows.map(row => row.hid).filter(hid => !order.includes(hid))];
  const day = crunch?.status === 'ok' && crunch.plan.today?.mode === 'flip' ? crunch.plan.today : null, today = new Set(day?.points || []);
  const seen = list.filter(hid => points.get(hid)?.seen).length;
  const mockIds = picked.size ? list.filter(hid => picked.has(hid)) : today.size ? list.filter(hid => today.has(hid)) : list;
  const scopeText = picked.size ? uiFormat('出卷范围：已选的 {0} 个知识点', [picked.size]) : today.size ? uiFormat('出卷范围：今天的 {0} 个知识点', [today.size]) : uiFormat('出卷范围：全书 {0} 个知识点', [list.length]);
  const toggleSet = (set, hid, on) => set(current => { const next = new Set(current); if (on) next.add(hid); else next.delete(hid); return next; });
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
        const takeaway = drill ? takeawayOf(splitPoint(row.node.gen))?.text ?? '' : '';
        const termCards = drill && Array.isArray(row.node.cards) ? row.node.cards : [];
        const hasRecall = drill && (Boolean(takeaway) || termCards.length > 0);
        const isRecallOpen = revealed.has(hid);
        const isStuck = Boolean(point?.stuck);
        return (
          <article key={hid} className="book-flip__point" data-flip-point={hid} data-seen={point?.seen ? 'true' : undefined}
            data-flip-masked={hasRecall && !isRecallOpen ? '' : undefined}>
            <header className="book-flip__head">
              <h3 className="book-flip__title" id={`flip-${hid}`}>
                <span className="book-node__number">{row.number}</span> {row.title} <span className="book-node__code">{codeOf(hid)}</span>
                {today.has(hid) && <Badge tone="info">{ui('今天')}</Badge>}
              </h3>
              <div className="book-flip__checks">
                <Checkbox label={ui('已看')} checked={!!point?.seen} disabled={!point} onChange={on => onMark(hid, on)} />
                <Checkbox label={ui('选进模拟卷')} checked={picked.has(hid)} onChange={on => toggleSet(setPicked, hid, on)} />
              </div>
            </header>
            {point && <p className="book-flip__muted">{pointMeta(point)}</p>}
            {items.length ? <ul className="book-flip__mistakes" aria-label={ui('易错点')}>
              {items.map((item, at) => <li key={`${item.kind}-${at}`} data-kind={item.kind}>{mistakeText(item)}</li>)}
            </ul> : <p className="book-flip__muted">{ui('这个知识点还没有记下的易错点。')}</p>}
            {hasRecall && (
              <div className="book-flip__recall" data-flip-recall={hid}>
                {isRecallOpen ? (
                  <div className="book-flip__recall-body">
                    {takeaway && <p className="book-flip__takeaway">{takeaway}</p>}
                    {termCards.length > 0 && (
                      <ul className="book-flip__terms" aria-label={ui('术语卡定义')}>
                        {termCards.map(card => (
                          <li key={card.code} className="book-flip__term">
                            <strong>{card.code} {card.name}</strong>{card.plain ? `：${card.plain}` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className="book-flip__muted">
                    {termCards.length > 0
                      ? uiFormat('先合书回忆一句话要点与术语定义（{0}），再点揭晓。', [termCards.map(card => card.name).join(' · ')])
                      : ui('先合书回忆这个知识点的一句话要点，再点揭晓。')}
                  </p>
                )}
                <div className="book-flip__recall-actions">
                  <Button size="sm" variant="quiet" wrap onClick={() => toggleSet(setRevealed, hid, !isRecallOpen)}>
                    {isRecallOpen ? ui('重新遮住') : ui('揭晓要点')}
                  </Button>
                  {point && onMarkStuck && (
                    <Button size="sm" variant="quiet" wrap aria-pressed={isStuck} data-flip-stuck={hid} onClick={() => onMarkStuck(hid, !isStuck)}>
                      {isStuck ? ui('已记卡住') : ui('卡住了')}
                    </Button>
                  )}
                </div>
              </div>
            )}
            <Disclosure className="book-flip__explain" summary={ui('讲解')} open={open} onToggle={value => toggleSet(setOpened, hid, value)}>
              {open && <PointBody node={row.node} course={course} handlers={handlers} level={4} />}
            </Disclosure>
            <Button iconEnd="arrow-right" variant="link" size="sm" className="book-flip__go" onClick={() => onGo(hid)}>{ui('在书里看这个知识点')}</Button>
          </article>
        );
      })}
    </div>
  );
}
