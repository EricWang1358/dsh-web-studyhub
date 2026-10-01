import React, { useEffect, useLayoutEffect, useRef } from 'react';
import css from './components.css';
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
 */
export default function SegmentedControl({ label, value, options = [], onChange, size = 'md', disabled = false, className, onKeyDown, ...rest }) {
  useComponentCss(css);
  const root = useRef(null);
  const thumb = useRef(null);
  const placed = useRef(-2);
  const activeIndex = options.findIndex(option => option.value === value);
  const tabStop = tabStopIndex(options, activeIndex, disabled);
  const signature = `${size}|${options.map(option => `${option.value}:${option.label}`).join('|')}`;

  const place = animate => {
    const group = root.current, mark = thumb.current;
    if (!group || !mark) return;
    const item = activeIndex >= 0 ? group.querySelectorAll(ITEMS)[activeIndex] : null;
    if (!item || !item.offsetWidth) { group.removeAttribute('data-thumb'); placed.current = -2; return; }
    const instant = !animate || group.getAttribute('data-thumb') !== 'on';
    if (instant) mark.style.transition = 'none';
    // offset* is measured in the group's own padding box and ignores writing direction.
    mark.style.width = `${item.offsetWidth}px`;
    mark.style.height = `${item.offsetHeight}px`;
    mark.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
    group.setAttribute('data-thumb', 'on');
    if (instant) { void mark.offsetWidth; mark.style.transition = ''; }
    placed.current = activeIndex;
  };

  useLayoutEffect(() => {
    place(placed.current !== -2 && placed.current !== activeIndex);
  });

  useEffect(() => {
    const group = root.current;
    if (!group || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(group);
    group.querySelectorAll(ITEMS).forEach(item => observer.observe(item));
    document.fonts?.ready?.then(() => place(false));
    return () => observer.disconnect();
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div ref={root} role="group" aria-label={label} className={cx('sh-seg', size === 'sm' && 'sh-seg--sm', className)} onKeyDown={handleKeyDown} {...rest}>
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
