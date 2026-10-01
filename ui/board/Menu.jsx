import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '../components/index.js';
import BIcon from './icons.jsx';

/* A small action menu behind a ⋯ button. In the browser the list is portalled
   into the study surface (absolute, in content coordinates) so neither the
   column's overflow nor the horizontal scroller can clip it. Keyboard: Arrow
   keys/Home/End move, Enter/Space choose, Escape closes and returns focus,
   Tab closes. */
export default function Menu({ label, items, onSelect, defaultOpen = false, icon = 'more', buttonClassName, className, onOpenChange, ...rest }) {
  const [open, setOpenState] = useState(defaultOpen);
  const [host, setHost] = useState(null);
  const [place, setPlace] = useState(null);
  const button = useRef(null), list = useRef(null), menuId = useId();
  const inBrowser = typeof document !== 'undefined';
  const setOpen = (value) => { setOpenState(value); onOpenChange?.(value); };
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
    const anchor = button.current.getBoundingClientRect(), size = list.current.getBoundingClientRect();
    const offsetX = fixed ? 0 : host.scrollLeft - box.left, offsetY = fixed ? 0 : host.scrollTop - box.top;
    const left = Math.max(box.left + 8, Math.min(anchor.right - size.width, box.right - size.width - 8));
    let top = anchor.bottom + 4;
    if (top + size.height > Math.min(box.bottom, window.innerHeight) - 8 && anchor.top - size.height - 4 > box.top) top = anchor.top - size.height - 4;
    setPlace({ fixed, left: left + offsetX, top: top + offsetY });
  }, [host, items.length]);

  useEffect(() => {
    if (!open) return undefined;
    if (inBrowser && !host) return undefined;
    enabled()[0]?.focus();
    const away = (event) => { if (!list.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false); };
    const leave = (event) => { if (!list.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('scroll', leave, true);
    window.addEventListener('resize', leave);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('scroll', leave, true); window.removeEventListener('resize', leave); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host]);

  const onKey = (event) => {
    const options = enabled(), at = options.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
    else if (event.key === 'Tab') setOpen(false);
    else if (event.key === 'ArrowDown') { event.preventDefault(); options[(at + 1) % options.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); options[(at - 1 + options.length) % options.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); options[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); options.at(-1)?.focus(); }
  };

  const style = !inBrowser ? undefined
    : place ? { left: place.left, top: place.top, position: place.fixed ? 'fixed' : 'absolute' } : { left: 0, top: 0, visibility: 'hidden' };
  const menu = (
    <div ref={list} id={menuId} role="menu" aria-label={label} className="board-menu" onKeyDown={onKey} style={style}>
      {items.map((item, index) => item.heading
        ? <p key={`h${index}`} role="presentation" className="board-menu__heading">{item.label}</p>
        : <button key={item.id} type="button" role="menuitem" disabled={item.disabled} title={item.hint}
          className={`board-menu__item${item.danger ? ' is-danger' : ''}`}
          onClick={() => { setOpen(false); button.current?.focus(); onSelect(item.id); }}>
          {item.icon ? <BIcon name={item.icon} /> : <span className="board-menu__gap" aria-hidden="true" />}
          <span className="board-menu__label">{item.label}</span>
          {item.hint && <span className="board-menu__hint">{item.hint}</span>}
        </button>)}
    </div>
  );
  return (
    <span className={`board-menu-anchor${className ? ` ${className}` : ''}`} {...rest}>
      <IconButton ref={button} icon={<BIcon name={icon} size={18} />} label={label} size="sm" className={buttonClassName}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }} />
      {open && (inBrowser ? (host ? createPortal(menu, host) : null) : menu)}
    </span>
  );
}
