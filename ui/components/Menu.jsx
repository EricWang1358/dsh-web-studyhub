import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import css from './components.css';
import overlayCss from './overlays.css';
import { useComponentCss, cx } from './css.js';
import { IconButton } from './Button.jsx';
import Icon from './Icon.jsx';
import Tooltip from './Tooltip.jsx';
import { placeInHost, useDismiss } from './use-dismiss.js';

const glyph = (icon, size) => typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon || null;
const More = <Icon name="more" size={18} />;
/** An item with `tip`: its button in a Tooltip, beside the menu (in the top layer, so the menu's own scrolling cannot cut it off). */
const tipped = (item, button) => (item.tip ? <Tooltip key={item.id} layer placement="left-start" content={item.tip}>{button}</Tooltip> : button);

/** Arrow keys / Home / End move between the enabled items of `list`; Tab closes. Shared by Menu and ContextMenu. */
const menuKeys = (list, close) => event => {
  const options = [...(list.current?.querySelectorAll('[role^="menuitem"]:not(:disabled)') || [])], at = options.indexOf(document.activeElement);
  if (event.key === 'Tab') close();
  else if (event.key === 'ArrowDown') { event.preventDefault(); options[(at + 1) % options.length]?.focus(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); options[(at - 1 + options.length) % options.length]?.focus(); }
  else if (event.key === 'Home') { event.preventDefault(); options[0]?.focus(); }
  else if (event.key === 'End') { event.preventDefault(); options.at(-1)?.focus(); }
};

/** The items as both menus draw them; `pick(item)` runs on a choice. */
function menuItems(items, pick) {
  // The icon column exists only when some item has an icon; the items without one then keep their text in line.
  const iconColumn = items.some(item => !item.heading && (item.icon || item.checked !== undefined));
  return items.map((item, index) => item.heading
    ? <p key={`h${index}`} role="presentation" className="sh-menu__heading">{item.label}</p>
    : tipped(item, <button key={item.id} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked === undefined ? undefined : !!item.checked}
      disabled={item.disabled} {...item.attrs}
      className={cx('sh-menu__item', item.danger && 'is-danger')}
      onClick={() => pick(item)}>
      {item.icon ? glyph(item.icon, 16) : item.checked ? glyph('check', 16) : iconColumn && <span className="sh-menu__gap" aria-hidden="true" />}
      <span className="sh-menu__label">{item.label}</span>
      {item.hint && <span className="sh-menu__hint">{item.hint}</span>}
    </button>));
}

/**
 * A small action menu behind a button (⋯ by default). In the browser the list
 * is portalled into the study surface, or into the open dialog it sits in (the
 * dialog is in the top layer; the surface is not), absolute in content
 * coordinates, so neither a column's overflow nor a horizontal scroller can clip it; it opens
 * downward and flips up when there is more room above. Keyboard: Arrow
 * keys/Home/End move, Enter/Space choose, Escape closes and returns focus, Tab
 * closes, ArrowDown on the button opens it.
 *
 * items: [{ id, label, icon?, hint?, tip?, danger?, disabled?, heading?, checked?, attrs?, run? }] (`icon` is
 * an Icon name or a node; `heading` makes a non-interactive group title; `checked`
 * (true or false) makes the item a menuitemcheckbox with a check mark while on; `attrs`
 * are extra attributes of the item's button, such as a data-usage name; `tip` is words shown in a Tooltip on hover and focus, for what the label and
 * a hint cannot say, such as what an item costs).
 * onSelect(id): an item that carries `run` (useHandOff().item) is run instead and does not reach onSelect.
 * `icon`: the default trigger's glyph (Icon name or node).
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
  const enabled = () => [...(list.current?.querySelectorAll('[role^="menuitem"]:not(:disabled)') || [])];

  useLayoutEffect(() => {
    if (!inBrowser) return;
    setHost(open && button.current ? (button.current.closest('dialog[open], .study-app, .study-seat') || document.body) : null);
    if (!open) setPlace(null);
  }, [open, inBrowser]);

  useLayoutEffect(() => {
    if (!host || !button.current || !list.current) return;
    // Measured from the host's content origin through the interface zoom (placeInHost): the measuring the reader's chip shares.
    const result = placeInHost({ element: list.current, host, rect: button.current.getBoundingClientRect(), placement: 'bottom-end' });
    setPlace({ fixed: result.fixed, left: result.left, top: result.top, maxHeight: result.maxHeight });
  }, [host, items.length]);

  useDismiss({ open, onClose: () => setOpen(false), refs: [list, button], returnFocusRef: button });
  // The list is hidden until it is placed, and a hidden element cannot take focus.
  const placed = !!place;
  // preventScroll: focusing the first item must not scroll the page, since any scroll closes the menu (below); on a narrow page it shut the menu as it opened.
  useEffect(() => { if (open && placed) enabled()[0]?.focus({ preventScroll: true }); }, [open, placed]);
  useEffect(() => {
    if (!open) return undefined;
    if (inBrowser && !host) return undefined;
    // A scroll closes the menu because its place would go stale; a scroll that leaves the trigger where it was (the page's own settling, scroll
    // anchoring as the list is placed) does not, or a narrow page shut the menu as it opened. A resize always closes it.
    const at = button.current?.getBoundingClientRect();
    const moved = () => { const now = button.current?.getBoundingClientRect(); return !at || !now || Math.abs(now.top - at.top) > 1 || Math.abs(now.left - at.left) > 1; };
    const leave = event => { if (!list.current?.contains(event.target) && (event.type === 'resize' || moved())) setOpen(false); };
    document.addEventListener('scroll', leave, true);
    window.addEventListener('resize', leave);
    return () => { document.removeEventListener('scroll', leave, true); window.removeEventListener('resize', leave); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host]);

  const onKey = menuKeys(list, () => setOpen(false));

  const style = !inBrowser ? undefined
    : place ? { left: place.left, top: place.top, maxHeight: place.maxHeight, overflowY: place.maxHeight ? 'auto' : undefined, position: place.fixed ? 'fixed' : 'absolute' }
      : { left: 0, top: 0, visibility: 'hidden' };
  const menu = (
    <div ref={list} id={menuId} role="menu" aria-label={label} className="sh-menu" onKeyDown={onKey} style={style}>
      {menuItems(items, item => { setOpen(false); button.current?.focus(); if (item.run) item.run(); else onSelect?.(item.id); })}
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

/**
 * The same menu opened at a point instead of under a button: a right-click on the reader's text. `point` is { x, y } in client pixels (a
 * right-click's pointer, or the selection's corner for the context-menu key); `within` is an element inside the surface or dialog the
 * menu belongs to (it is portalled there, as Menu is). Same items, keys and dismissal as Menu: Escape, a click outside, a scroll or a
 * resize closes it and focus goes back to where it was. Focus starts on the first enabled item.
 * onSelect(id) for an item without `run`; onClose() whenever it closes, chosen or not.
 */
export function ContextMenu({ label, items, point, within, onSelect, onClose }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  const list = useRef(null), back = useRef(null), [place, setPlace] = useState(null);
  const host = within?.closest?.('dialog[open], .study-app, .study-seat') || document.body;
  useLayoutEffect(() => { back.current = document.activeElement; }, []);
  useLayoutEffect(() => {
    if (!list.current) return;
    const result = placeInHost({ element: list.current, host, rect: { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 }, placement: 'bottom-start', gap: 2 });
    setPlace({ fixed: result.fixed, left: result.left, top: result.top, maxHeight: result.maxHeight });
  }, [host, point.x, point.y, items.length]);
  useDismiss({ open: true, onClose, refs: [list], returnFocusRef: back });
  const placed = !!place;
  useEffect(() => { if (placed) list.current?.querySelector('[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true }); }, [placed]);
  useEffect(() => {
    // As Menu's: a scroll closes it only when what it was opened over moved (a scroll event that lands just after the right-click, from a scroll made
    // before it, left it shut at once); a resize always does.
    const at = within?.getBoundingClientRect?.();
    const moved = () => { const now = within?.getBoundingClientRect?.(); return !at || !now || Math.abs(now.top - at.top) > 1 || Math.abs(now.left - at.left) > 1; };
    const leave = event => { if (!list.current?.contains(event.target) && (event.type === 'resize' || moved())) onClose?.(); };
    document.addEventListener('scroll', leave, true);
    window.addEventListener('resize', leave);
    return () => { document.removeEventListener('scroll', leave, true); window.removeEventListener('resize', leave); };
  }, [onClose, within]);
  const style = place ? { left: place.left, top: place.top, maxHeight: place.maxHeight, overflowY: place.maxHeight ? 'auto' : undefined, position: place.fixed ? 'fixed' : 'absolute' }
    : { left: 0, top: 0, visibility: 'hidden' };
  return createPortal(<div ref={list} role="menu" aria-label={label} className="sh-menu sh-menu--context" onKeyDown={menuKeys(list, () => onClose?.())} style={style}
    onContextMenu={event => event.preventDefault()}>
    {menuItems(items, item => { onClose?.(); if (item.run) item.run(); else onSelect?.(item.id); })}
  </div>, host);
}
