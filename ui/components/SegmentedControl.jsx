import React, { useCallback, useLayoutEffect, useRef } from 'react';
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
 * options: [{ value, label, icon?, title?, disabled?, attrs? }] (`attrs` is spread on that option's button, e.g. data-tour, as in Tabs).
 * size: md | sm | xs. fill: full width, equal segments. wrap: long labels may
 * run over lines. stack: becomes a column when its container is narrow.
 */
export default function SegmentedControl({ label, value, options = [], onChange, size = 'md', fill = false, wrap = false, stack = false, disabled = false, className, itemClassName, iconClassName, onKeyDown, ...rest }) {
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
     nothing, so a parent re-render never cuts a slide short. laidOut: called by the
     resize observer, when the browser has just laid the page out. */
  const place = useCallback((animate, laidOut = false) => {
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
    /* Only transform moves: the thumb takes the new size at once, is scaled back to the old one, then released (FLIP).
       Every measurement is taken before the first write: one taken after a write makes the browser lay the page out again, and a
       placement used to do that four times. */
    const width = `${item.offsetWidth}px`, height = `${item.offsetHeight}px`;
    const to = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
    const from = instant || !(w0 > 0 && h0 > 0) ? to : `translate(${x0}px, ${y0}px) scale(${w0 / item.offsetWidth}, ${h0 / item.offsetHeight})`;
    mark.style.transition = 'none';
    mark.style.width = width;
    mark.style.height = height;
    mark.style.transform = from;
    group.setAttribute('data-thumb', 'on');
    /* Nothing slides and the browser is between layout and paint: this frame is drawn without a transition anyway, so the transition
       comes back at the start of the next frame instead of through one more forced layout here. */
    if (instant && laidOut && typeof requestAnimationFrame === 'function') { requestAnimationFrame(() => { mark.style.transition = ''; }); return; }
    void mark.offsetWidth;
    mark.style.transition = '';
    mark.style.transform = to;
  }, []);

  /* With a resize observer, only a newly chosen item is placed here, where the slide has to start. The first placement and every change
     of size are the observer's: it reports once for each element it starts to watch and whenever one changes size, each time after the
     browser's own layout, so measuring costs nothing there. Measuring in every render made each control lay the page out again while
     the page was still being built. */
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const moved = placed.current !== -2 && placed.current !== activeIndex;
    const watched = typeof ResizeObserver !== 'undefined' && (!mounted.current || active.current === activeIndex);
    mounted.current = true;
    active.current = activeIndex;
    if (!watched) place(moved);
  });

  // A layout effect, so the first report comes before the first paint of the control.
  useLayoutEffect(() => {
    const group = root.current;
    if (!group || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => place(false, true));
    observer.observe(group);
    group.querySelectorAll(ITEMS).forEach(item => observer.observe(item));
    /* A font that arrives later can change the words without changing a box the observer watches. The event, not document.fonts.ready:
       reading `ready` makes the browser lay the whole page out on the spot, here in the middle of building it. */
    const fonts = document.fonts, refit = () => place(false);
    fonts?.addEventListener?.('loadingdone', refit);
    return () => { observer.disconnect(); fonts?.removeEventListener?.('loadingdone', refit); };
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
      {/* data-muted: the chosen item is disabled, so the thumb steps down with it. Stamped here, not asked of the page with :has(:disabled) (components.css).
          It follows the props only: inside a disabled <fieldset>, pass `disabled` too (board/CardEditor.jsx). */}
      <span ref={thumb} className="sh-seg__thumb" aria-hidden="true" data-index={activeIndex} data-count={options.length}
        data-muted={activeIndex >= 0 && (disabled || options[activeIndex]?.disabled) ? 'true' : undefined} />
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button type="button" key={option.value} className={cx('sh-seg__item', itemClassName, active && 'is-active')} aria-pressed={active}
            tabIndex={index === tabStop ? 0 : -1} title={option.title} disabled={disabled || option.disabled}
            onClick={() => { if (!active) onChange?.(option.value); }} {...option.attrs}>
            {option.icon ? <Icon name={option.icon} size={16} className={iconClassName} /> : null}{option.label}
          </button>
        );
      })}
    </div>
  );
}
