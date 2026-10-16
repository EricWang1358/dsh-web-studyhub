import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './book-end.css';

/* The ONE end button of a knowledge point (复习全书, docs/review-book.md "The end of a point"), the last thing in it: 读完了，下一个 (marks it 读完 and goes on), 练 5 道
   first on a point with questions not read yet (读完了 beside it, quiet), 已看，下一个 on a 翻看 day, 下一个 on a point already read, and 今天的读完了 with a quiet
   出一套模拟卷… on today's last point (ui/book/point-end.js says which). The next point follows the page's one rule (ui/book/route.js). Under it one quiet line:
   the point's leading-on sentence when the notes have one, else 「接下来：<the next point>」.
   Until the 期末一周 plan has answered, the default shows disabled in the block's final height (the quiet slot is kept on a narrow page); once enabled its
   labels stay until the learner presses one, so a late answer never swaps the button under the pointer (ui/DESIGN.md "Late content"). */

const LABEL = { read: () => ui('读完了，下一个'), seen: () => ui('已看，下一个'), next: () => ui('下一个'), practice: () => ui('练 5 道'), today: () => ui('今天的读完了'),
  mock: () => ui('出一套模拟卷…') };
const LAST = { read: () => ui('读完了'), seen: () => ui('已看'), next: () => ui('这是最后一个知识点') };
// What each button records, on hover and focus (下一个 and the mock paper hide no rule).
const TIP = {
  read: () => ui('记下「读完了」：目录里它打 ✓，期末一周的进度也按它算'),
  seen: () => ui('记下「已看」：翻看的进度按它算'),
  practice: () => ui('练这个知识点接下来的 5 道，练完能回到这里；期末一周里某一天答够 5 道也算读完'),
  today: () => ui('记下「读完了」：今天的知识点就都过了一遍，再往下按全书的顺序'),
};
const labelOf = (id, hasNext) => (!hasNext && LAST[id] ? LAST[id]() : LABEL[id]());
const arrow = (id, hasNext) => (hasNext && ['read', 'seen', 'next'].includes(id) ? 'arrow-right' : undefined);

/** state: ui/book/point-end.js endState; next: the next point's number and title ('' at the end); bridge: the point's leading-on sentence or ''; onAct(id) does
    what a button says (read / seen / practice / today / next / mock), resolves when done; element: the button pressed (the way back from practice). */
export default function PointEnd({ state, next, bridge, onAct }) {
  useInjectCss(css, 'study-book-end');
  const kept = useRef(null), live = useRef(true);
  const [pending, setPending] = useState(false);
  useEffect(() => () => { live.current = false; }, []);
  if (!state.waiting && !kept.current) kept.current = state;
  const view = kept.current ?? state;
  const run = async (id, element) => {
    if (pending) return;
    setPending(true);
    try { await onAct(id, element); } finally {
      // The learner's own press may change what the block says (the last point, read now): the next answer is taken.
      if (live.current) { kept.current = null; setPending(false); }
    }
  };
  const line = bridge || (next ? uiFormat('接下来：{0}', [next]) : '');
  const button = (id, primary) => (
    <Tooltip layer content={TIP[id]?.() ?? ''} anchorClassName={primary ? 'book-end__tip book-end__tip--primary' : 'book-end__tip'}>
      <Button variant={primary ? 'primary' : 'quiet'} className={primary ? 'book-end__primary' : 'book-end__second'} data-book-end-action={id}
        iconEnd={arrow(id, view.hasNext)} disabled={view.waiting || pending || (id === 'next' && !view.hasNext)} onClick={event => run(id, event.currentTarget)}>
        {labelOf(id, view.hasNext)}</Button>
    </Tooltip>
  );
  return (
    <div className="book-end" data-book-end={view.primary} data-waiting={view.waiting ? '' : undefined}>
      <div className="book-end__actions">
        {button(view.primary, true)}
        {/* On a narrow page the quiet button has a line of its own: kept (an invisible stand-in) when there is none, so the block's height never changes. */}
        <div className="book-end__quiet">{view.quiet ? button(view.quiet, false)
          : <Button variant="quiet" className="book-end__ghost" tabIndex={-1} aria-hidden="true">{LABEL.read()}</Button>}</div>
      </div>
      {line && <p className="book-end__line">{line}</p>}
    </div>
  );
}
