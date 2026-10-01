import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import css from './scroll-window.css';
import { useComponentCss, cx } from './css.js';
import { ui, uiFormat } from '../i18n.js';

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

/** Is there more content above / below the viewport's visible part? Drives the soft fades. */
export const scrollEdges = element => ({
  top: element.scrollTop > 1,
  bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
});

/**
 * A `measure(element)` that calls `publish(edges)` only when top or bottom really changed.
 * It runs after every commit, so it must not call setState with an unchanged value: React 18
 * does not bail out of those at once and the layout effect re-renders itself until it throws
 * "Maximum update depth exceeded" (React error #185) once the list overflows.
 */
export function edgeTracker(publish, initial = { top: false, bottom: false }) {
  let last = initial;
  return element => {
    const next = scrollEdges(element);
    if (next.top === last.top && next.bottom === last.bottom) return;
    last = next;
    publish(next);
  };
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
  filterable = false, filterLabel, filterPlaceholder, query, onQueryChange, defaultQuery = '', showCount, activeKey, maxHeight = 380,
  as = 'ul', listClassName, itemClassName, empty, toolbar, focusable = true, listProps, itemProps, className, style, ...rest }) {
  useComponentCss(css, 'study-scroll-window');
  const [ownQuery, setOwnQuery] = useState(defaultQuery);
  const value = query ?? ownQuery;
  const setQuery = next => { if (query === undefined) setOwnQuery(next); onQueryChange?.(next); };
  const shown = filterItems(items, value, match);
  const filtering = !!String(value || '').trim();
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
      <div className="sh-scroll__frame" data-fade-top={edges.top || undefined} data-fade-bottom={edges.bottom || undefined}>
        <div ref={viewport} id={id} className="sh-scroll__viewport" role="region" aria-label={label} tabIndex={focusable ? 0 : undefined} onScroll={measure}>
          {shown.length ? <List {...listProps} className={cx('sh-scroll__list', listClassName)}>
            {shown.map((item, index) => {
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
