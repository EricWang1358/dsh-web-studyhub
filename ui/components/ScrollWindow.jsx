import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import css from './scroll-window.css';
import { useComponentCss, cx } from './css.js';
import { ui, uiFormat } from '../i18n.js';
import { edgeTracker } from './scroll-edges.js';
import { REVEAL_ANCHORS_EVENT } from '../tour/anchor.js';

// The edge rules moved to ./scroll-edges.js (the horizontal strips share them); re-exported here because they were published from this module.
export { createEdgeTracker, edgeTracker, scrollEdges, scrollEdgesX } from './scroll-edges.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const textOf = item => typeof item === 'string' ? item : String(item?.name ?? item?.title ?? item?.label ?? '');

/** Items whose text contains every word of the query (case- and width-insensitive). */
export function filterItems(items = [], query = '', match = textOf) {
  const words = String(query || '').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter(item => {
    const text = String(match(item) ?? '').normalize('NFKC').toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** Rows a window draws at first. Longer lists draw more as the learner scrolls: a library of a thousand materials drew thousands of nodes at once. */
export const SCROLL_WINDOW_CHUNK = 120;

/** The rows to draw: the first `limit` of `items`, and always up to the active one. */
export const windowRows = (items, limit, activeIndex = -1) => items.slice(0, Math.max(limit, activeIndex + 1));

/** How far below the bottom of the viewport the last drawn row may still be before the next chunk is drawn: about a screen. */
const NEAR_END_PX = 320;

/** The one rule of "near the end": `remaining` is how many pixels lie between the bottom of the viewport and the last drawn row (negative: it is already inside). */
export const withinReach = remaining => remaining < NEAR_END_PX;

/** Is the viewport within a screen of its last drawn row? Then the next chunk is drawn. */
export const nearEnd = element => withinReach(element.scrollHeight - element.scrollTop - element.clientHeight);

/** The limit after one more chunk: it adds to what is drawn now, which a jump to a row far down may have made more than the limit. */
export const nextLimit = (drawn, chunk = SCROLL_WINDOW_CHUNK) => drawn + chunk;

/** `anchors` maps an anchor name to the row of this list that holds it (-1: none). The row of the first of `wanted` this list holds, or -1. */
export const anchorRow = (anchors, wanted) => {
  for (const name of wanted || []) if (anchors?.[name] >= 0) return anchors[name];
  return -1;
};

/** Is the marker after the last drawn row in sight or about to be: not above the top of the window (those rows are behind the learner), and within a screen of the bottom? */
const endReached = marker => {
  const box = marker.getBoundingClientRect();
  return box.bottom > 0 && withinReach(box.top - window.innerHeight);
};

/**
 * The rows of a list on a page that scrolls as a whole (the sources page, the wrong book, a long draft), drawn in growing chunks with the same helpers as
 * ScrollWindow: the first `chunk` rows, then one more chunk each time the end comes within a screen of the bottom (scrolling or tabbing there; no timer).
 * Rows are never removed and the rows already drawn never move. A row something jumps to is drawn first: `reveal` is its index (-1: none), and `anchors`
 * says which row holds a `data-tour` anchor, so 找功能 can draw it before it looks (ui/tour/anchor.js). `resetKey` starts again from the first chunk when
 * it changes (a new filter); folding the group away unmounts the list, which does the same. `render(item, index)` returns the row with its key;
 * `as` is the end marker's tag ('li' inside a <ul>).
 */
export function ChunkedRows({ items, render, chunk = SCROLL_WINDOW_CHUNK, reveal = -1, anchors, resetKey = '', as: Marker = 'div' }) {
  useComponentCss(css, 'study-scroll-window');
  const [grown, setGrown] = useState({ key: resetKey, rows: chunk });
  const rows = grown.key === resetKey ? grown.rows : chunk;
  const drawn = windowRows(items, rows, reveal);
  const more = drawn.length < items.length;
  const marker = useRef(null), latest = useRef(null), holdsAnchors = !!anchors;
  latest.current = { drawn: drawn.length, resetKey, anchors, chunk };
  // A row that was drawn for a jump stays drawn once the jump is over.
  const needed = Math.min(reveal + 1, items.length);
  useEffect(() => { if (needed > rows) setGrown({ key: resetKey, rows: needed }); }, [needed, rows, resetKey]);
  useEffect(() => {
    if (!more) return undefined;
    const check = () => {
      if (marker.current && endReached(marker.current)) setGrown({ key: latest.current.resetKey, rows: nextLimit(latest.current.drawn, latest.current.chunk) });
    };
    // Scrolling anywhere (the page or a pane around it) and focus moving into the rows; and once now, in case the chunk just drawn does not fill the screen.
    document.addEventListener('scroll', check, { capture: true, passive: true });
    document.addEventListener('focusin', check, true);
    check();
    return () => { document.removeEventListener('scroll', check, true); document.removeEventListener('focusin', check, true); };
  }, [more, drawn.length]);
  // 找功能 asks before it looks for an anchor: the row that holds it is drawn at once, so the look finds it.
  useEffect(() => {
    if (!holdsAnchors) return undefined;
    const reveals = event => {
      const at = anchorRow(latest.current.anchors, event.detail?.anchors);
      if (at >= latest.current.drawn) flushSync(() => setGrown({ key: latest.current.resetKey, rows: at + 1 }));
    };
    document.addEventListener(REVEAL_ANCHORS_EVENT, reveals);
    return () => document.removeEventListener(REVEAL_ANCHORS_EVENT, reveals);
  }, [holdsAnchors]);
  return <>
    {drawn.map((item, index) => render(item, index))}
    {more && <Marker ref={marker} className="sh-chunk-end" data-chunk-end="" aria-hidden="true" />}
  </>;
}

/** "共 N 项", or "共 N 项 / 显示 M 项" while a filter hides some. */
export const scrollWindowCount = (total, shown, filtering) => filtering
  ? uiFormat('共 {0} 项 / 显示 {1} 项', [total, shown]) : uiFormat('共 {0} 项', [total]);

/**
 * A bounded scroll region for long lists (courses, materials): the page stays
 * short, the region is focusable and named, soft fades show that more is
 * above or below, and the active item is kept in view. Optional filter input
 * with a live count. Props:
 *   label (accessible name), items, itemKey(item), renderItem(item, { query }),
 *   match(item) → searchable text, filterable, filterLabel, filterPlaceholder,
 *   query + onQueryChange (controlled) or defaultQuery, showCount (default = filterable),
 *   activeKey, maxHeight (px, default 380), as ('ul' | 'div'), listClassName,
 *   itemClassName, empty (node when the filter matches nothing), toolbar (node beside the filter),
 *   focusable (default true; false when another control drives it, e.g. a combobox),
 *   listProps (extra props for the list, e.g. role="listbox"), itemProps(item) (extra props per item).
 */
export default function ScrollWindow({ label, items = [], itemKey = (item, index) => index, renderItem = item => textOf(item), match = textOf,
  filterable = false, filterLabel, filterPlaceholder, query, onQueryChange, defaultQuery = '', showCount, activeKey, maxHeight = 380, renderLimit = SCROLL_WINDOW_CHUNK,
  as = 'ul', frameClassName, listClassName, itemClassName, empty, toolbar, focusable = true, listProps, itemProps, className, style, ...rest }) {
  useComponentCss(css, 'study-scroll-window');
  const [ownQuery, setOwnQuery] = useState(defaultQuery);
  const value = query ?? ownQuery;
  const setQuery = next => { if (query === undefined) setOwnQuery(next); onQueryChange?.(next); };
  const shown = filterItems(items, value, match);
  const filtering = !!String(value || '').trim();
  // Only the first rows are drawn; a new filter starts from the first chunk again.
  const [grown, setGrown] = useState({ query: value, rows: renderLimit });
  const rows = grown.query === value ? grown.rows : renderLimit;
  const activeIndex = activeKey === undefined || activeKey === null ? -1 : shown.findIndex((item, index) => itemKey(item, index) === activeKey);
  const drawn = renderLimit === Infinity ? shown : windowRows(shown, rows, activeIndex);
  const more = drawn.length < shown.length;
  const grow = () => setGrown(current => ({ query: value, rows: (current.query === value ? current.rows : renderLimit) + SCROLL_WINDOW_CHUNK }));
  const viewport = useRef(null), id = useId();
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const tracker = useRef(null);
  tracker.current ??= edgeTracker(setEdges);
  const measure = useCallback(() => { if (viewport.current) tracker.current(viewport.current); }, []);
  useIsoLayoutEffect(() => { measure(); });
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);
  // Keep the active item visible inside the window without scrolling the page.
  useEffect(() => {
    const element = viewport.current;
    if (!element || activeKey === undefined || activeKey === null) return;
    const target = element.querySelector('[data-active="true"]');
    if (!target) return;
    const box = element.getBoundingClientRect(), item = target.getBoundingClientRect();
    if (item.top < box.top) element.scrollTop -= box.top - item.top + 8;
    else if (item.bottom > box.bottom) element.scrollTop += item.bottom - box.bottom + 8;
  }, [activeKey]);
  const List = as === 'div' ? 'div' : 'ul', Item = as === 'div' ? 'div' : 'li';
  const counted = showCount ?? filterable;
  return (
    <div className={cx('sh-scroll', className)} style={{ '--sh-scroll-max': `${maxHeight}px`, ...style }} {...rest}>
      {(filterable || toolbar || counted) && <div className="sh-scroll__bar">
        {filterable && <input type="search" className="sh-scroll__filter" value={value} aria-label={filterLabel || filterPlaceholder || ui('筛选')}
          placeholder={filterPlaceholder || ui('筛选…')} aria-controls={id} autoComplete="off" spellCheck={false}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Escape' && value) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} />}
        {toolbar}
        {counted && <small className="sh-scroll__count" aria-live="polite">{scrollWindowCount(items.length, shown.length, filtering)}</small>}
      </div>}
      <div className={cx('sh-scroll__frame', frameClassName)} data-fade-top={edges.top || undefined} data-fade-bottom={edges.bottom || undefined}>
        <div ref={viewport} id={id} className="sh-scroll__viewport" role="region" aria-label={label} tabIndex={focusable ? 0 : undefined}
          onScroll={event => { measure(); if (more && nearEnd(event.currentTarget)) grow(); }}
          onFocus={event => {
            // Tabbing into the last drawn rows draws the next chunk, so keyboard users are never stopped at an invisible end.
            if (!more) return;
            const rowNodes = [...event.currentTarget.querySelectorAll('[data-scroll-key]')];
            if (rowNodes.findIndex(node => node.contains(event.target)) >= rowNodes.length - 3) grow();
          }}>
          {shown.length ? <List {...listProps} className={cx('sh-scroll__list', listClassName)}>
            {drawn.map((item, index) => {
              const key = itemKey(item, index);
              const extra = itemProps?.(item, index) || {};
              return <Item key={key} {...extra} className={cx('sh-scroll__item', itemClassName, extra.className)} data-scroll-key={key}
                data-active={activeKey !== undefined && activeKey !== null && key === activeKey ? 'true' : undefined}>
                {renderItem(item, { query: value })}
              </Item>;
            })}
          </List> : <p className="sh-scroll__empty">{empty || (filtering ? ui('没有匹配的项') : ui('还没有内容'))}</p>}
        </div>
      </div>
    </div>
  );
}
