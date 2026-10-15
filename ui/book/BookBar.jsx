import React, { forwardRef, useEffect, useRef } from 'react';
import { ui } from '../i18n.js';
import { Button, IconButton, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { ReadingSettingsButton } from '../reading-settings/ReadingSettings.jsx';
import css from './book-bar.css';

/* The book bar (复习全书, docs/review-book.md "The book bar"): the page's one toolbar, sticky under the app's top bar while the book scrolls. 目录 · where the
   learner is (知识点 5/16 · the point's title) · ‹ › · Aa (the shared reading settings) · ⋯ 更多. No primary button. A thin cinnabar line under it says how far
   the point being read is read (transform only, at most once a frame, no transition with reduced motion). `notice`: one quiet line under the bar that never
   moves the page (it sits in the gap below it), for the page limit. The app's top bar sticks only as far as its own column reaches (ui/shell.css: on a long
   page it scrolls away), so the bar sticks where the top bar's lower edge is, and at the very top once it is gone (--book-bar-top on the page). */

/** How far the point is read: the part of it above the window's lower edge, 0 to 1. */
const readShare = (point, bottom) => {
  const box = point.getBoundingClientRect();
  return box.height > 0 ? Math.min(1, Math.max(0, (bottom - box.top) / box.height)) : 0;
};

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
    let frame = 0;
    const draw = () => {
      frame = 0;
      const point = hid && document.querySelector(`[data-book-point="${CSS.escape(hid)}"]`);
      if (line.current) line.current.style.transform = `scaleX(${point ? readShare(point, window.innerHeight) : 0})`;
      stickBar(barRef.current?.closest('.book-page'));
    };
    const later = () => { if (!frame) frame = requestAnimationFrame(draw); };
    draw();
    document.addEventListener('scroll', later, { capture: true, passive: true });
    window.addEventListener('resize', later);
    // The point grows or shrinks without a scroll (a block opened, a fold, a late answer): drawn again.
    const point = hid && document.querySelector(`[data-book-point="${CSS.escape(hid)}"]`);
    const sizes = point && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(later) : null;
    sizes?.observe(point);
    return () => { cancelAnimationFrame(frame); sizes?.disconnect(); document.removeEventListener('scroll', later, { capture: true }); window.removeEventListener('resize', later); };
  }, [hid, barRef]);
  return line;
}

/** where: '知识点 5/16' (or '' for 未归位); title: the point's number and title; hid: the point being read; tocOpen, onToc; onPrev / onNext (null at an end);
    more: the 更多 menu; notice: a line under the bar or null; tocRef: the 目录 button (the slide-over gives the focus back to it). */
const BookBar = forwardRef(function BookBar({ where, title, hid, tocOpen, onToc, onPrev, onNext, more, notice }, tocRef) {
  useInjectCss(css, 'study-book-bar');
  const bar = useRef(null), line = useReadLine(hid, bar);
  return (
    <div ref={bar} className="book-bar" role="toolbar" aria-label={ui('书栏')}>
      <div className="book-bar__row">
        <Button ref={tocRef} size="sm" variant="quiet" icon="list" className="book-bar__toc" aria-label={ui('目录')} aria-expanded={tocOpen} onClick={onToc}>
          <span className="book-bar__word" aria-hidden="true">{ui('目录')}</span></Button>
        <Tooltip layer content={ui('按全书的顺序数；‹ › 和 ← → 也按这个顺序走')} anchorClassName="book-bar__where-tip">
          <p className="book-bar__where" tabIndex={0}>
            {where && <span className="book-bar__count">{where}</span>}
            {where && <span className="book-bar__dot" aria-hidden="true"> · </span>}
            <span className="book-bar__title">{title}</span>
          </p>
        </Tooltip>
        <Tooltip layer content={ui('上一个知识点（也可以按 ←）')}>
          <IconButton icon="chevron" size="sm" className="book-bar__prev" label={ui('上一个知识点')} title={undefined} disabled={!onPrev} onClick={onPrev || undefined} />
        </Tooltip>
        <Tooltip layer content={ui('下一个知识点（也可以按 →）')}>
          <IconButton icon="chevron" size="sm" className="book-bar__next" label={ui('下一个知识点')} title={undefined} disabled={!onNext} onClick={onNext || undefined} />
        </Tooltip>
        <ReadingSettingsButton className="book-bar__aa" />
        {more}
      </div>
      <div className="book-bar__line" aria-hidden="true"><span ref={line} /></div>
      {notice}
    </div>
  );
});
export default BookBar;
