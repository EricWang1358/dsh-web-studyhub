import React, { memo, useCallback, useEffect, useRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { levelsText } from '../outline/words.js';
import { codeOf } from '../../lib/course-book-lookup.js';
import css from './book-toc.css';

/* The review book's live 目录 (docs/review-book.md "The contents"): every heading of the stitched book (lib/course-book-links.js bookIndex), indented by level.
   The heading being read is bold with a 2 px ink line on its left. The code the printed book carries (H7) is not beside the headings: it shows on hover and
   on keyboard focus of a row. A click opens its chapter and goes to the heading. At wide widths the 目录 is a frameless column beside the text that sticks
   and scrolls on its own; on a narrow page (ui/use-narrow.js) it slides over the text from the left with a scrim, and Esc, the scrim or a row closes it. */

/** entries: [{ id, level, title }] (the book's own title left out); here: the heading id being read; onGo(id). */
export const BookTocList = memo(function BookTocList({ entries, here, onGo }) {
  return (
    <ol className="book-toc__list">
      {entries.map(entry => (
        <li key={entry.id} className="book-toc__item" data-level={Math.min(4, entry.level)}>
          <Tooltip layer placement="right-start" group="book-toc" content={uiFormat('编号 {0}', [codeOf(entry.id)])} anchorClassName="book-toc__anchor">
            <Button variant="quiet" size="sm" wrap className="book-toc__go" aria-current={entry.id === here ? 'location' : undefined} onClick={() => onGo(entry.id)}>
              {entry.title}
            </Button>
          </Tooltip>
        </li>
      ))}
    </ol>
  );
});

/** The 目录 itself: the book's coverage line on top (quiet, explained on hover), then the list. narrow: it is the slide-over (onClose closes it, the focus goes
    back to `returnRef`); coverage: course.book.open's `coverage` or null. */
export default function BookToc({ entries, here, onGo, narrow, onClose, returnRef, coverage }) {
  useInjectCss(css, 'study-book-toc');
  const panel = useRef(null);
  // A row goes there, and closes the slide-over (one handler, so the memoised list is not drawn again for nothing).
  const go = useCallback(id => { onGo(id); if (narrow) onClose(); }, [onGo, narrow, onClose]);
  // The slide-over takes the focus (the panel itself, so no row's code pops up; Tab goes to the rows) and gives it back to the 目录 button when it closes; Esc
  // closes it. The row being read is scrolled into the panel's view.
  useEffect(() => {
    if (!narrow) return undefined;
    panel.current?.focus({ preventScroll: true });
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
      {coverage && <Tooltip layer content={ui('按清点出来的资料条目算：用了几份资料、读了几页，几个知识点讲全了，几个概念讲到了')} anchorClassName="book-toc__levels-tip">
        <p className="book-toc__levels" data-book-levels="" tabIndex={0}>{levelsText(coverage)}</p>
      </Tooltip>}
      <BookTocList entries={entries} here={here} onGo={go} />
    </nav>
  </>;
}
