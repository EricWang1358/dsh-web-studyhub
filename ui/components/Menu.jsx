import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import css from './components.css';
import overlayCss from './overlays.css';
import { useComponentCss, cx } from './css.js';
import { IconButton } from './Button.jsx';
import Icon from './Icon.jsx';
import { computePlacement, useDismiss } from './use-dismiss.js';

const glyph = (icon, size) => typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon || null;
const More = <svg className="sh-icon" viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden="true" focusable="false">
  <circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" /></svg>;

/**
 * A small action menu behind a button (⋯ by default). In the browser the list
 * is portalled into the study surface (absolute, in content coordinates) so
 * neither a column's overflow nor a horizontal scroller can clip it; it opens
 * downward and flips up when there is more room above. Keyboard: Arrow
 * keys/Home/End move, Enter/Space choose, Escape closes and returns focus, Tab
 * closes, ArrowDown on the button opens it.
 *
 * items: [{ id, label, icon?, hint?, danger?, disabled?, heading?, attrs? }] (`icon` is
 * an Icon name or a node; `heading` makes a non-interactive group title; `attrs`
 * are extra attributes of the item's button, such as a data-usage name).
 * onSelect(id). `icon`: the default trigger's glyph (Icon name or node).
 * trigger({ props, ref, open }): a text trigger instead ("整理与添加"); spread
 * `props` and attach `ref`.
 */
export default function Menu({ label, items, onSelect, defaultOpen = false, icon, trigger, buttonClassName, className, onOpenChange, ...rest }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  const [open, setOpenState] = useState(defaultOpen);
  const [host, setHost] = useState(null);
  const [place, setPlace] = useState(null);
  const button = useRef(null), list = useRef(null), menuId = useId();
  const inBrowser = typeof document !== 'undefined';
  const setOpen = value => { setOpenState(value); onOpenChange?.(value); };
  const enabled = () => [...(list.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || [])];

  useLayoutEffect(() => {
    if (!inBrowser) return;
    setHost(open && button.current ? (button.current.closest('.study-app, .study-seat') || document.body) : null);
    if (!open) setPlace(null);
  }, [open, inBrowser]);

  useLayoutEffect(() => {
    if (!host || !button.current || !list.current) return;
    const fixed = host === document.body;
    const box = fixed ? { left: 0, top: 0, bottom: window.innerHeight, right: window.innerWidth } : host.getBoundingClientRect();
    const size = list.current.getBoundingClientRect();
    const result = computePlacement({ anchor: button.current.getBoundingClientRect(), size, placement: 'bottom-end',
      bounds: { left: box.left, top: box.top, right: box.right, bottom: Math.min(box.bottom, window.innerHeight) } });
    const offsetX = fixed ? 0 : host.scrollLeft - box.left, offsetY = fixed ? 0 : host.scrollTop - box.top;
    setPlace({ fixed, left: result.left + offsetX, top: result.top + offsetY, maxHeight: size.height > result.maxHeight ? result.maxHeight : undefined });
  }, [host, items.length]);

  useDismiss({ open, onClose: () => setOpen(false), refs: [list, button], returnFocusRef: button });
  // The list is hidden until it is placed, and a hidden element cannot take focus.
  const placed = !!place;
  useEffect(() => { if (open && placed) enabled()[0]?.focus(); }, [open, placed]);
  useEffect(() => {
    if (!open) return undefined;
    if (inBrowser && !host) return undefined;
    const leave = event => { if (!list.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('scroll', leave, true);
    window.addEventListener('resize', leave);
    return () => { document.removeEventListener('scroll', leave, true); window.removeEventListener('resize', leave); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host]);

  const onKey = event => {
    const options = enabled(), at = options.indexOf(document.activeElement);
    if (event.key === 'Tab') setOpen(false);
    else if (event.key === 'ArrowDown') { event.preventDefault(); options[(at + 1) % options.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); options[(at - 1 + options.length) % options.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); options[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); options.at(-1)?.focus(); }
  };

  const style = !inBrowser ? undefined
    : place ? { left: place.left, top: place.top, maxHeight: place.maxHeight, overflowY: place.maxHeight ? 'auto' : undefined, position: place.fixed ? 'fixed' : 'absolute' }
      : { left: 0, top: 0, visibility: 'hidden' };
  const menu = (
    <div ref={list} id={menuId} role="menu" aria-label={label} className="sh-menu" onKeyDown={onKey} style={style}>
      {items.map((item, index) => item.heading
        ? <p key={`h${index}`} role="presentation" className="sh-menu__heading">{item.label}</p>
        : <button key={item.id} type="button" role="menuitem" disabled={item.disabled} title={item.hint} {...item.attrs}
          className={cx('sh-menu__item', item.danger && 'is-danger')}
          onClick={() => { setOpen(false); button.current?.focus(); onSelect(item.id); }}>
          {item.icon ? glyph(item.icon, 16) : <span className="sh-menu__gap" aria-hidden="true" />}
          <span className="sh-menu__label">{item.label}</span>
          {item.hint && <span className="sh-menu__hint">{item.hint}</span>}
        </button>)}
    </div>
  );
  const props = { 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? menuId : undefined,
    onClick: event => { event.stopPropagation(); setOpen(!open); },
    onKeyDown: event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } } };
  return (
    <span className={cx('sh-menu-anchor', className)} {...rest}>
      {trigger ? trigger({ props, ref: button, open })
        : <IconButton ref={button} icon={glyph(icon, 18) || More} label={label} size="sm" className={buttonClassName} {...props} />}
      {open && (inBrowser ? (host ? createPortal(menu, host) : null) : menu)}
    </span>
  );
}
