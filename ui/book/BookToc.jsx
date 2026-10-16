import React, { memo, useCallback, useEffect, useRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Icon, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { levelsText } from '../outline/words.js';
import { codeOf } from '../../lib/course-book-lookup.js';
import css from './book-toc.css';

/* The review book's live 目录 (docs/review-book.md "The contents"): on top 在书里找 (ui/book/BookFind.jsx; while something is typed its matches take the groups'
   place), then 「今天」 inside the 期末一周 (today's points in the plan's order), then 「全书」 with every heading of the stitched book (lib/course-book-links.js
   bookIndex), indented by level. Every row ends in one fixed-width mark slot, kept even when empty so a mark that comes late moves no text: 易错 N, else the dot
   of a pending update suggestion, else ✓ (读完) (ui/book/toc-marks.js), each explained on hover and focus. The heading being read is bold with a 2 px ink line on
   its left. The code the printed book carries (H7) shows on hover and on keyboard focus of a row. A click opens its chapter and goes to the heading. At wide
   widths the 目录 is a frameless column beside the text that sticks and scrolls on its own; on a narrow page (ui/use-narrow.js) it slides over the text from
   the left with a scrim, and Esc, the scrim or a row closes it. */

/** The mark at the end of a row (mark: ui/book/toc-marks.js markOf, or null: the slot stays, empty). */
function TocMark({ mark }) {
  if (!mark) return <span className="book-toc__mark" aria-hidden="true" />;
  const [tip, body, label] = mark.kind === 'mistakes'
    ? [ui('来自你问过的、答题卡的易错检查和你弄懂过的地方'), uiFormat('易错 {0}', [mark.count]), uiFormat('易错 {0}', [mark.count])]
    : mark.kind === 'suggestion' ? [ui('这个知识点有待处理的更新建议'), <span className="book-toc__dot" />, ui('有更新建议')]
      : [ui('你点过读完了；期末一周里某一天答够这个知识点 5 道也算'), <Icon name="check" size={14} />, ui('读完')];
  return (
    <Tooltip layer group="book-toc" placement="right-start" content={tip} anchorClassName="book-toc__mark-tip">
      <span className="book-toc__mark" data-mark={mark.kind} tabIndex={0} aria-label={label}>{body}</span>
    </Tooltip>
  );
}

/** entries: [{ id, level, title }] (the book's own title left out); here: the heading id being read; onGo(id); marks: Map<id, mark>. */
export const BookTocList = memo(function BookTocList({ entries, here, onGo, marks, label }) {
  return (
    <ol className="book-toc__list" aria-label={label}>
      {entries.map(entry => (
        <li key={entry.id} className="book-toc__item" data-level={Math.min(4, entry.level)}>
          <Tooltip layer placement="right-start" group="book-toc" content={uiFormat('编号 {0}', [codeOf(entry.id)])} anchorClassName="book-toc__anchor">
            <Button variant="quiet" size="sm" wrap className="book-toc__go" aria-current={entry.id === here ? 'location' : undefined} onClick={() => onGo(entry.id)}>
              {entry.title}
            </Button>
          </Tooltip>
          <TocMark mark={marks?.get(entry.id) ?? null} />
        </li>
      ))}
    </ol>
  );
});

/** The 目录 itself. narrow: it is the slide-over (onClose closes it, the focus goes back to `returnRef`, or to the search field when `findFirst`); coverage:
    course.book.open's `coverage` or null; find: the 在书里找 element and whether it is searching; today: { entries, count, done, flip } or null; read: how many
    points are 读完, of `points`; marks: Map<id, mark>. */
export default function BookToc({ entries, here, onGo, narrow, onClose, returnRef, coverage, find = null, searching = false, findFirst = false, today = null, read = 0,
  points = 0, marks = null }) {
  useInjectCss(css, 'study-book-toc');
  const panel = useRef(null);
  // A row goes there, and closes the slide-over (one handler, so the memoised list is not drawn again for nothing).
  const go = useCallback(id => { onGo(id); if (narrow) onClose(); }, [onGo, narrow, onClose]);
  // The slide-over takes the focus (the panel itself, so no row's code pops up; Tab goes to the rows) and gives it back to the 目录 button when it closes; Esc
  // closes it. The row being read is scrolled into the panel's view.
  useEffect(() => {
    if (!narrow) return undefined;
    if (!findFirst) panel.current?.focus({ preventScroll: true });
    const row = panel.current?.querySelector('[aria-current="location"]');
    if (row) panel.current.scrollTop = row.offsetTop - panel.current.clientHeight / 2;
    // A tooltip of a row also hears this Esc (it hides itself); a dialog over the page keeps its own.
    const press = event => { if (event.key === 'Escape' && !event.target?.closest?.('dialog')) { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', press);
    const back = returnRef?.current;
    return () => { document.removeEventListener('keydown', press); if (back?.isConnected) back.focus({ preventScroll: true }); };
  }, [narrow]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    {/* The scrim closes it on a press; the keyboard closes it with Esc (the focus is in the panel). */}
    {narrow && <div className="book-toc-scrim" aria-hidden="true" onClick={onClose} />}
    <nav ref={panel} className="book-toc" aria-label={ui('目录')} data-overlay={narrow ? '' : undefined} tabIndex={narrow ? -1 : undefined}>
      {find}
      {!searching && <>
        {today && <section className="book-toc__group" data-book-today="">
          <Tooltip layer content={ui('期末一周按考试日期和每天的分钟数排：先读考得多又薄弱的，读完再练；每天几分钟在设置里改。')} anchorClassName="book-toc__head-tip">
            <p className="book-toc__head" tabIndex={0}>{today.flip ? uiFormat('今天 {0} 个 · 已看 {1}', [today.count, today.done])
              : uiFormat('今天 {0} 个 · 已读完 {1}', [today.count, today.done])}</p>
          </Tooltip>
          <BookTocList entries={today.entries} here={here} onGo={go} marks={marks} label={ui('今天的知识点')} />
        </section>}
        <section className="book-toc__group">
          <p className="book-toc__head">{uiFormat('全书 · 已读完 {0}/{1}', [read, points])}</p>
          {coverage && <Tooltip layer content={ui('按清点出来的资料条目算：用了几份资料、读了几页，几个知识点讲全了，几个概念讲到了')} anchorClassName="book-toc__levels-tip">
            <p className="book-toc__levels" data-book-levels="" tabIndex={0}>{levelsText(coverage)}</p>
          </Tooltip>}
          <BookTocList entries={entries} here={here} onGo={go} marks={marks} label={ui('全书')} />
        </section>
      </>}
    </nav>
  </>;
}
