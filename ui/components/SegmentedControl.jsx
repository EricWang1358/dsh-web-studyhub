import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import css from './components.css';
import variantsCss from './button-variants.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';
import { nextSegmentIndex, tabStopIndex } from './segmented.js';

const ITEMS = ':scope > .sh-seg__item';

/**
 * A small set of mutually exclusive choices (language, theme, view mode). The
 * active segment is announced with aria-pressed, so "which one is on" never
 * depends on colour alone. A thumb slides between segments: the server markup
 * (and any browser before mount) fills the active item itself, and once the
 * thumb is measured it takes over without a visible jump. Arrow keys move
 * focus along the row (roving tab stop); Enter and Space select.
 * options: [{ value, label, icon?, title?, disabled? }]
 * size: md | sm | xs. fill: full width, equal segments. wrap: long labels may
 * run over lines. stack: becomes a column when its container is narrow.
 */
export default function SegmentedControl({ label, value, options = [], onChange, size = 'md', fill = false, wrap = false, stack = false, disabled = false, className, onKeyDown, ...rest }) {
  useComponentCss(css);
  useComponentCss(variantsCss, 'study-button-variants');
  const root = useRef(null);
  const thumb = useRef(null);
  const placed = useRef(-2);
  const active = useRef(-1);
  const rect = useRef('');
  const activeIndex = options.findIndex(option => option.value === value);
  const tabStop = tabStopIndex(options, activeIndex, disabled);
  const signature = `${size}|${options.map(option => `${option.value}:${option.label}`).join('|')}`;

  /* Move the thumb to the active item. Re-measuring an unchanged layout writes
     nothing, so a parent re-render never cuts a slide short. */
  const place = useCallback(animate => {
    const group = root.current, mark = thumb.current;
    if (!group || !mark) return;
    const item = active.current >= 0 ? group.querySelectorAll(ITEMS)[active.current] : null;
    if (!item || !item.offsetWidth) { group.removeAttribute('data-thumb'); placed.current = -2; rect.current = ''; return; }
    // offset* is measured in the group's own padding box and ignores writing direction.
    const next = [item.offsetLeft, item.offsetTop, item.offsetWidth, item.offsetHeight].join(',');
    const on = group.getAttribute('data-thumb') === 'on';
    placed.current = active.current;
    if (on && next === rect.current) return;
    const [x0, y0, w0, h0] = rect.current ? rect.current.split(',').map(Number) : [];
    rect.current = next;
    const instant = !animate || !on;
    /* Only transform moves: the thumb takes the new size at once, is scaled back to the old one, then released (FLIP). */
    mark.style.transition = 'none';
    mark.style.width = `${item.offsetWidth}px`;
    mark.style.height = `${item.offsetHeight}px`;
    mark.style.transform = instant || !(w0 > 0 && h0 > 0) ? `translate(${item.offsetLeft}px, ${item.offsetTop}px)`
      : `translate(${x0}px, ${y0}px) scale(${w0 / item.offsetWidth}, ${h0 / item.offsetHeight})`;
    group.setAttribute('data-thumb', 'on');
    void mark.offsetWidth;
    mark.style.transition = '';
    mark.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
  }, []);

  useLayoutEffect(() => {
    const moved = placed.current !== -2 && placed.current !== activeIndex;
    active.current = activeIndex;
    place(moved);
  });

  useEffect(() => {
    const group = root.current;
    if (!group || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(group);
    group.querySelectorAll(ITEMS).forEach(item => observer.observe(item));
    document.fonts?.ready?.then(() => place(false));
    return () => observer.disconnect();
  }, [signature, place]);

  const handleKeyDown = event => {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll(ITEMS));
    const from = buttons.indexOf(event.target.closest('.sh-seg__item'));
    if (from < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const to = nextSegmentIndex(options, from, event.key, { rtl });
    if (to < 0) return;
    event.preventDefault();
    buttons[to]?.focus();
  };

  return (
    <div ref={root} role="group" aria-label={label} className={cx('sh-seg', size === 'sm' && 'sh-seg--sm', size === 'xs' && 'sh-seg--xs', fill && 'sh-seg--fill', wrap && 'sh-seg--wrap', stack && 'sh-seg--stack', className)} onKeyDown={handleKeyDown} {...rest}>
      <span ref={thumb} className="sh-seg__thumb" aria-hidden="true" data-index={activeIndex} data-count={options.length} />
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button type="button" key={option.value} className={active ? 'sh-seg__item is-active' : 'sh-seg__item'} aria-pressed={active}
            tabIndex={index === tabStop ? 0 : -1} title={option.title} disabled={disabled || option.disabled}
            onClick={() => { if (!active) onChange?.(option.value); }}>
            {option.icon ? <Icon name={option.icon} size={16} /> : null}{option.label}
          </button>
        );
      })}
    </div>
  );
}
