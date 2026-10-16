import React, { forwardRef, useEffect, useRef } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, IconButton, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { ReadingSettingsButton } from '../reading-settings/ReadingSettings.jsx';
import css from './book-bar.css';

/* The book bar (复习全书, docs/review-book.md "The book bar"): the page's one toolbar, sticky under the app's top bar while the book scrolls. 目录 · where the
   learner is (知识点 5/16 · the point's number and title; on a narrow page 5/16 · the title) · ‹ › · Aa (the shared reading settings) · ⋯ 更多. No primary
   button. A thin cinnabar line under it says how far the point being read is read (transform only, at most once a frame, no transition with reduced motion).
   `notice`: one quiet line under the bar (the page limit), only while it holds; it is not part of the sticky bar, so no button moves. The app's top bar sticks only as
   far as its own column reaches (ui/shell.css: on a long page it scrolls away), so the bar sticks where the top bar's lower edge is, and at the very top once
   it is gone (--book-bar-top on the page). */

/** How far the point is read, 0 to 1: nothing while its top is still below the bar; once its top has gone under the bar, the share of it above the window's
    foot (so 1 once its end is on screen). A point wholly between the bar and the foot is 1 once the reader has scrolled at all (`scrolled`), else 0. */
export const readShare = (box, barBottom, windowHeight, scrolled) => {
  if (!(box.height > 0)) return 0;
  if (box.top < barBottom) return Math.min(1, Math.max(0, (windowHeight - box.top) / box.height));
  return scrolled && box.bottom <= windowHeight ? 1 : 0;
};
/** The reader's own scrolling (not a jump by ‹ ›, ← → or the 目录, which scrolls the page as well): the wheel, a touch drag or a scroll key. */
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'End', 'Home', ' ']);

/** Where the bar sticks, in px from the top of the app's scroller: under the app's top bar while it is on screen, else 0. */
const stickAt = bar => {
  const app = bar.closest('.study-app, .study-seat'), topbar = app?.querySelector('.topbar');
  return topbar ? Math.max(0, Math.round(topbar.getBoundingClientRect().bottom - app.getBoundingClientRect().top - app.clientTop)) : 0;
};
/** Puts the bar of `page` (the .book-page) where it sticks now (--book-bar-top), at once: a jump measures the bar right after it scrolls. -> the bar or null. */
export function stickBar(page) {
  const bar = page?.querySelector('.book-bar');
  if (!bar) return null;
  const next = `${stickAt(bar)}px`;
  if (page.style.getPropertyValue('--book-bar-top') !== next) page.style.setProperty('--book-bar-top', next);
  return bar;
}

/** Draws the progress line of the point `hid` and keeps the bar under the app's top bar, on scroll and resize (at most once a frame): refs and one CSS
    variable, not state, so a scroll renders nothing. */
function useReadLine(hid, barRef) {
  const line = useRef(null);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    // A new point starts unread until the reader scrolls it themselves.
    let frame = 0, moved = false;
    const draw = () => {
      frame = 0;
      const bar = stickBar(barRef.current?.closest('.book-page')) || barRef.current;
      const point = hid && document.querySelector(`[data-book-point="${CSS.escape(hid)}"]`);
      const share = point && bar ? readShare(point.getBoundingClientRect(), bar.getBoundingClientRect().bottom, window.innerHeight, moved) : 0;
      if (line.current) line.current.style.transform = `scaleX(${share})`;
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const byHand = event => {
      if (event.type === 'keydown' && (!SCROLL_KEYS.has(event.key) || event.target?.closest?.('input, textarea, [contenteditable], .cm-editor'))) return;
      moved = true;
      later();
    };
    draw();
    document.addEventListener('scroll', later, { capture: true, passive: true });
    for (const type of ['wheel', 'touchmove', 'keydown']) window.addEventListener(type, byHand, { passive: true });
    window.addEventListener('resize', later);
    // The point grows or shrinks without a scroll (a block opened, a fold, a late answer): drawn again.
    const point = hid && document.querySelector(`[data-book-point="${CSS.escape(hid)}"]`);
    const sizes = point && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(later) : null;
    sizes?.observe(point);
    return () => { cancelAnimationFrame(frame); sizes?.disconnect(); document.removeEventListener('scroll', later, { capture: true }); window.removeEventListener('resize', later); for (const type of ['wheel', 'touchmove', 'keydown']) window.removeEventListener(type, byHand); };
  }, [hid, barRef]);
  return line;
}

/** at / total: the point's place in the order the page follows (ui/book/route.js; at 0 for 未归位: no count), `today`: that order is today's (今天 2/4), else
    the book's (知识点 5/16); number, title: the point's; hid: the point being read; tocOpen, onToc;
    onPrev / onNext (null at an end); more: the 更多 menu; notice: { text, tip } or null (the page limit); tocRef: the 目录 button (the slide-over gives the
    focus back to it). */
const BookBar = forwardRef(function BookBar({ at, total, today = false, number, title, hid, tocOpen, onToc, onPrev, onNext, more, notice }, tocRef) {
  useInjectCss(css, 'study-book-bar');
  const bar = useRef(null), line = useReadLine(hid, bar);
  return <>
    <div ref={bar} className="book-bar" role="group" aria-label={ui('书栏')}>
      <div className="book-bar__row">
        <Button ref={tocRef} size="sm" variant="quiet" icon="list" className="book-bar__btn book-bar__toc" aria-label={ui('目录')} aria-expanded={tocOpen} onClick={onToc}>
          <span className="book-bar__word" aria-hidden="true">{ui('目录')}</span></Button>
        <Tooltip layer content={ui('在今天的知识点上按今天的顺序数，‹ › 和 ← → 也这样走，今天最后一个之后接着全书的顺序；其余时候按全书的顺序')}
          anchorClassName="book-bar__where-tip">
          <p className="book-bar__where" tabIndex={0}>
            {/* On a narrow page the count alone and the title without its number (the bar has no room; the heading and the 目录 carry the number). */}
            {at > 0 && <span className="book-bar__count book-bar__count--wide" data-order={today ? 'today' : 'book'}>
              {today ? uiFormat('今天 {0}/{1}', [at, total]) : uiFormat('知识点 {0}/{1}', [at, total])}</span>}
            {at > 0 && <span className="book-bar__count book-bar__count--narrow">{today ? uiFormat('今天 {0}/{1}', [at, total]) : `${at}/${total}`}</span>}
            {at > 0 && <span className="book-bar__dot" aria-hidden="true"> · </span>}
            <span className="book-bar__title">{number && <span className="book-bar__number">{number} </span>}{title}</span>
          </p>
        </Tooltip>
        <Tooltip layer content={ui('上一个知识点（也可以按 ←）')}>
          <IconButton icon="chevron" size="sm" className="book-bar__btn book-bar__prev" label={ui('上一个知识点')} title={undefined} disabled={!onPrev} onClick={onPrev || undefined} />
        </Tooltip>
        <Tooltip layer content={ui('下一个知识点（也可以按 →）')}>
          <IconButton icon="chevron" size="sm" className="book-bar__btn book-bar__next" label={ui('下一个知识点')} title={undefined} disabled={!onNext} onClick={onNext || undefined} />
        </Tooltip>
        <ReadingSettingsButton className="book-bar__aa" size="sm" buttonClassName="book-bar__btn" />
        {more}
      </div>
      <div className="book-bar__line" aria-hidden="true"><span ref={line} /></div>
    </div>
    {notice && <p className="book-bar-limit">
      <Tooltip layer content={notice.tip}><span className="book-bar-limit__text" tabIndex={0}>{notice.text}</span></Tooltip></p>}
  </>;
});
export default BookBar;
