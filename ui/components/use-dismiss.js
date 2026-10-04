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
 * `capture` (default on) hears the press before the page can stop it.
 */
export function useDismiss({ open: isOpen, onClose, refs, escape = true, returnFocusRef, capture = true }) {
  const latest = useRef({});
  latest.current = { onClose, refs, returnFocusRef };
  useEffect(() => {
    if (!isOpen) return undefined;
    const token = {};
    open.push(token);
    const inside = target => elementsOf(latest.current.refs).some(element => element.contains(target));
    const away = event => { if (!inside(event.target)) latest.current.onClose?.('outside'); };
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
 * it may be. placement: 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'.
 */
export function computePlacement({ anchor, size, bounds, placement = 'bottom-end', flip = true, gap = 4, margin = 8 }) {
  const [wanted, align] = placement.split('-');
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

const viewport = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
const within = (box, outer) => ({ left: Math.max(box.left, outer.left), top: Math.max(box.top, outer.top),
  right: Math.min(box.right, outer.right), bottom: Math.min(box.bottom, outer.bottom) });

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
      const shift = Math.round((result.left - moved.left) / (scale || 1));
      panel.style.transform = shift ? `translateX(${shift}px)` : '';
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
