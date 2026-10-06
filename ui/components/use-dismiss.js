import { useEffect, useLayoutEffect, useRef } from 'react';

/* Popover plumbing shared by Popover, Menu, Tooltip and the reader's toolbar
   panels: close on an outside press or Escape (and hand focus back), and keep
   a panel inside its bounds at any interface zoom. */

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const elementsOf = refs => (Array.isArray(refs) ? refs : [refs]).map(entry => entry?.current ?? entry).filter(Boolean);

// Open dismissables, oldest first: Escape belongs to the newest one only.
const open = [];

/**
 * Close a floating panel from outside. `refs`: a ref, an element or an array
 * of them that count as "inside" (the panel and its trigger). onClose(reason)
 * gets 'outside' or 'escape'. Escape works while focus is inside or nowhere
 * (a closed menu item took it), stops there so an enclosing dialog stays open,
 * and returns focus to `returnFocusRef`. An outside press does not move focus.
 * `capture` (default on) hears the press before the page can stop it. A press inside a Select / Combobox popup (.sh-pop) counts as inside.
 */
export function useDismiss({ open: isOpen, onClose, refs, escape = true, returnFocusRef, capture = true }) {
  const latest = useRef({});
  latest.current = { onClose, refs, returnFocusRef };
  useEffect(() => {
    if (!isOpen) return undefined;
    const token = {};
    open.push(token);
    const inside = target => elementsOf(latest.current.refs).some(element => element.contains(target));
    // A Select or Combobox popup opened from inside this panel is drawn outside it (in the study surface): pressing it is not pressing away.
    const away = event => { if (!inside(event.target) && !event.target?.closest?.('.sh-pop')) latest.current.onClose?.('outside'); };
    const key = event => {
      if (event.key !== 'Escape' || open.at(-1) !== token) return;
      const target = event.target;
      if (!inside(target) && target !== document.body && target !== document.documentElement) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.onClose?.('escape');
      latest.current.returnFocusRef?.current?.focus?.({ preventScroll: true });
    };
    document.addEventListener('pointerdown', away, capture);
    if (escape) document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, capture);
      document.removeEventListener('keydown', key, true);
      const at = open.indexOf(token);
      if (at >= 0) open.splice(at, 1);
    };
  }, [isOpen, escape, capture]);
}

/**
 * Where a panel of `size` goes next to `anchor` inside `bounds` (all in
 * viewport pixels). It opens on the requested side, switches to the other when
 * that side has more room, is pulled back inside the bounds and told how tall
 * it may be. placement: 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start', or beside the anchor with 'left-start' | 'left-end' |
 * 'right-start' | 'right-end' (the panel's top, or bottom, lines up with the anchor's; it switches to the roomier side and, when neither
 * side fits its width, opens below or above instead).
 */
export function computePlacement({ anchor, size, bounds, placement = 'bottom-end', flip = true, gap = 4, margin = 8 }) {
  const [wanted, align] = placement.split('-');
  if (wanted === 'left' || wanted === 'right') {
    const roomLeft = anchor.left - gap - (bounds.left + margin), roomRight = bounds.right - margin - (anchor.right + gap);
    let side = wanted;
    if (flip) {
      if (side === 'left' && size.width > roomLeft && roomRight > roomLeft) side = 'right';
      else if (side === 'right' && size.width > roomRight && roomLeft > roomRight) side = 'left';
    }
    if (size.width <= (side === 'left' ? roomLeft : roomRight)) {
      const natural = align === 'end' ? anchor.bottom - size.height : anchor.top;
      const top = Math.max(bounds.top + margin, Math.min(natural, bounds.bottom - margin - size.height));
      return { placement: `${side}-${align === 'end' ? 'end' : 'start'}`, left: side === 'left' ? anchor.left - gap - size.width : anchor.right + gap, top, maxHeight: Math.max(0, Math.floor(bounds.bottom - margin - top)) };
    }
    return computePlacement({ anchor, size, bounds, placement: `bottom-${align === 'end' ? 'end' : 'start'}`, flip, gap, margin });
  }
  const below = bounds.bottom - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - (bounds.top + margin);
  let side = wanted === 'top' ? 'top' : 'bottom';
  if (flip) {
    if (side === 'bottom' && size.height > below && above > below) side = 'top';
    else if (side === 'top' && size.height > above && below > above) side = 'bottom';
  }
  const top = side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - size.height;
  const natural = align === 'start' ? anchor.left : anchor.right - size.width;
  const left = Math.max(bounds.left + margin, Math.min(natural, bounds.right - margin - size.width));
  return { placement: `${side}-${align === 'start' ? 'start' : 'end'}`, left, top, maxHeight: Math.max(0, Math.floor(side === 'bottom' ? below : above)) };
}

/**
 * Where an absolutely positioned (or, in the window itself, fixed) `element` that lives inside `host` goes next to `rect`, in the host's own
 * CSS pixels. Rectangles are screen pixels, the host may be zoomed (the interface size) and scrolled, so the element is measured from the
 * host's content origin (left/top 0) and the offset is the difference between where it is and where it should be, divided by the zoom. This is
 * the one measuring the Menu, the reader's 译 chip and its 原文 card share. `host`: the positioned ancestor, or document.body for a fixed element.
 * `bounds` (screen pixels, default the host's box) is where the element may sit. gap/margin are CSS pixels.
 * Returns { fixed, left, top, maxHeight, placement, scale }; maxHeight is set only when the element is taller than the room.
 */
export function placeInHost({ element, host, rect, placement = 'bottom-end', flip = true, gap, margin, bounds }) {
  const fixed = host === document.body;
  const box = bounds || (fixed ? { left: 0, top: 0, bottom: window.innerHeight, right: window.innerWidth } : host.getBoundingClientRect());
  element.style.left = '0px';
  element.style.top = '0px';
  const size = element.getBoundingClientRect();
  const scale = element.offsetWidth ? size.width / element.offsetWidth : 1;
  const result = computePlacement({ anchor: rect, size, placement, flip, ...(gap === undefined ? {} : { gap: gap * scale }), ...(margin === undefined ? {} : { margin: margin * scale }),
    bounds: { left: box.left, top: box.top, right: box.right, bottom: Math.min(box.bottom, window.innerHeight) } });
  const origin = fixed ? { left: 0, top: 0 } : size;
  return { fixed, placement: result.placement, scale, left: (result.left - origin.left) / scale, top: (result.top - origin.top) / scale,
    maxHeight: size.height > result.maxHeight ? result.maxHeight / scale : undefined };
}

const viewport = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
const within = (box, outer) => ({ left: Math.max(box.left ?? outer.left, outer.left), top: Math.max(box.top ?? outer.top, outer.top),
  right: Math.min(box.right ?? outer.right, outer.right), bottom: Math.min(box.bottom ?? outer.bottom, outer.bottom) });

/**
 * Keep a panel that CSS places under (or over) its anchor inside `boundsRef`
 * (default: the window). The panel is placed with data-placement (see
 * overlays.css); this only flips it, slides it sideways and limits its height,
 * with style writes and no state. Measures through the interface zoom: bounds
 * are screen pixels, the panel's own transform is CSS pixels.
 */
export function useAnchoredPosition({ anchorRef, panelRef, boundsRef, placement = 'bottom-end', flip = true, open: isOpen = true, margin = 8, gap = 4 }) {
  useIsoLayoutEffect(() => {
    const panel = panelRef?.current, anchor = anchorRef?.current;
    if (!isOpen || !panel || !anchor) return undefined;
    const place = () => {
      panel.style.transform = '';
      panel.style.maxHeight = '';
      panel.setAttribute('data-placement', placement);
      const box = panel.getBoundingClientRect();
      const scale = panel.offsetWidth ? box.width / panel.offsetWidth : 1;
      const bounds = within(boundsRef?.current ? boundsRef.current.getBoundingClientRect() : viewport(), viewport());
      const result = computePlacement({ anchor: anchor.getBoundingClientRect(), size: { width: box.width, height: box.height }, bounds,
        placement, flip, margin, gap: gap * scale });
      panel.setAttribute('data-placement', result.placement);
      const moved = panel.getBoundingClientRect();
      // Sideways: pull the box CSS placed back inside the bounds.
      let shift = Math.min(0, bounds.right - margin - moved.right);
      shift = Math.max(shift, bounds.left + margin - moved.left);
      panel.style.transform = shift ? `translateX(${Math.round(shift / (scale || 1))}px)` : '';
      // Height from where the panel really sits, not from the assumed gap.
      const room = result.placement.startsWith('bottom') ? bounds.bottom - margin - moved.top : moved.bottom - bounds.top - margin;
      panel.style.maxHeight = `${Math.max(0, Math.floor(room / (scale || 1)))}px`;
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (boundsRef?.current) observer?.observe(boundsRef.current);
    observer?.observe(anchor);
    observer?.observe(panel);
    return () => { window.removeEventListener('resize', place); observer?.disconnect(); };
  }, [isOpen, placement, flip, margin, gap, anchorRef, panelRef, boundsRef]);
}
