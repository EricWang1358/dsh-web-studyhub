import React, { forwardRef, useId } from 'react';
import css from './disclosure.css';
import { useComponentCss, cx } from './css.js';
import { nextSegmentIndex, tabStopIndex } from './segmented.js';

/** The element ids a tab and its panel share, so aria-controls and aria-labelledby always resolve. */
export const tabIds = (id, value) => ({ tab: `${id}-tab-${value}`, panel: `${id}-panel-${value}` });

/**
 * Which tab takes focus after `key` on tab `from`, or -1. Arrow keys, Home and
 * End skip disabled tabs (the same roving rules as SegmentedControl); with
 * `wrap: false` the ends stay put instead of wrapping around.
 */
export function nextTabIndex(items, from, key, { wrap = true, rtl = false } = {}) {
  const to = nextSegmentIndex(items, from, key, { rtl });
  if (to < 0 || wrap) return to;
  const forward = key === 'ArrowDown' || key === (rtl ? 'ArrowLeft' : 'ArrowRight');
  const backward = key === 'ArrowUp' || key === (rtl ? 'ArrowRight' : 'ArrowLeft');
  if ((forward && to < from) || (backward && to > from)) return -1;
  return to;
}

/**
 * The one tab list. Selection follows focus: Arrow keys, Home and End move to
 * the next enabled tab and select it; only the selected tab is in the tab
 * order and only it names its panel with aria-controls (render the matching
 * <TabPanel id value selected>, so the reference always resolves).
 * items: [{ value, label, note?, disabled?, ariaLabel?, title?, content?, attrs? }]
 * (`content` replaces the label and note; `attrs` is spread on the button, e.g.
 * data-tour). id: shared with the panels (defaults to a generated one).
 * itemClassName / className: skin the buttons / the list. wrap={false}: the
 * ends stay put.
 */
export const Tabs = forwardRef(function Tabs({ id, value, onChange, items = [], label, className, itemClassName, wrap = true, onKeyDown, ...rest }, ref) {
  useComponentCss(css, 'study-disclosure');
  const generated = useId();
  const base = id || generated;
  const activeIndex = items.findIndex(item => item.value === value);
  const stop = tabStopIndex(items, activeIndex);
  const handleKeyDown = event => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
    const from = buttons.indexOf(event.target.closest('[role="tab"]'));
    if (from < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const to = nextTabIndex(items, from, event.key, { wrap, rtl });
    if (to < 0) return;
    event.preventDefault();
    onChange?.(items[to].value);
    buttons[to]?.focus();
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} className={cx('sh-tabs', className)} onKeyDown={handleKeyDown} {...rest}>
      {items.map((item, index) => {
        const active = index === activeIndex;
        const ids = tabIds(base, item.value);
        return (
          <button key={item.value} type="button" role="tab" id={ids.tab} aria-selected={active} aria-controls={active ? ids.panel : undefined}
            aria-label={item.ariaLabel} title={item.title} tabIndex={index === stop ? 0 : -1} disabled={item.disabled}
            className={cx('sh-tab', itemClassName, active && 'is-active')} onClick={() => { if (!active) onChange?.(item.value); }} {...item.attrs}>
            {item.content ?? <>
              <span className="sh-tab__label">{item.label}</span>
              {item.note && <small className="sh-tab__note">{item.note}</small>}
            </>}
          </button>
        );
      })}
    </div>
  );
});

/**
 * The panel of tab `value` (share `id` with the Tabs). Only the selected
 * panel is rendered; `keepMounted` keeps the others in the document, hidden.
 * `as` swaps the element or component; the panel takes the tab stop unless it
 * has focusable content of its own (pass tabIndex={undefined}).
 */
export function TabPanel({ as: Tag = 'div', id, value, selected, keepMounted = false, className, children, ...rest }) {
  const active = value === selected;
  if (!active && !keepMounted) return null;
  const ids = tabIds(id, value);
  return (
    <Tag role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} hidden={!active || undefined} tabIndex={0} className={cx('sh-tabpanel', className)} {...rest}>
      {children}
    </Tag>
  );
}

export default Tabs;
