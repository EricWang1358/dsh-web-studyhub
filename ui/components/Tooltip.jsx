import React, { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import css from './components.css';
import overlayCss from './overlays.css';
import layerCss from './tooltip-layer.css';
import { useComponentCss, cx } from './css.js';
import { computePlacement, useAnchoredPosition, useDismiss } from './use-dismiss.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const HOVER_DELAY = 250, PRESS_DELAY = 500, TOUCH_LINGER = 3000, LEAVE_DELAY = 150;
const chain = (own, extra) => event => { own?.(event); extra(event); };
// The open tooltip of each `group`: opening one closes the one before at once, so two cards are never on screen together.
const openInGroup = new Map();

/**
 * Words for a control, shown on hover, on keyboard focus and on a long press,
 * and tied to it with aria-describedby (the text stays in the DOM, hidden,
 * while closed, so the description always resolves). Use it where the text
 * carries something the label does not; a title attribute that only repeats
 * the label can stay. Escape hides it. `children` is one element.
 * layer: show it in the top layer (a manual popover placed from the anchor's
 * rectangle) so a scrolling or clipping ancestor cannot cut it off; it follows
 * its anchor on scroll and resize. anchorClassName: a class for the wrapping span.
 * interactive: the pointer may move onto the card (to scroll long text) without closing it; the card then takes pointer events.
 * placement may also be 'left-start' and friends (beside the anchor, layer only; see computePlacement).
 * group: tooltips of one group are mutually exclusive (entering another anchor of the group, or opening it, closes this one at once).
 * outside: a selector of an ancestor the card keeps clear of when it opens beside the anchor (layer only): it is placed outside that
 * ancestor's edge, level with the anchor, and below the anchor itself when there is no room beside.
 * An empty `content` draws no card (and closes an open one): a caller whose words come and go keeps one anchor in the page, so the control
 * it wraps is never remounted when the words appear.
 */
export default function Tooltip({ content, children, placement = 'bottom-start', flip = true, className, layer = false, anchorClassName, interactive = false, group, outside }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  useComponentCss(layerCss, 'study-tooltip-layer');
  const [open, setOpen] = useState(false);
  const id = useId(), anchor = useRef(null), panel = useRef(null), timer = useRef(0), self = useRef(null);
  if (!self.current) self.current = { close: () => {} };
  self.current.close = () => { clearTimeout(timer.current); setOpen(false); };
  const closeOthers = () => { const other = group && openInGroup.get(group); if (other && other !== self.current) other.close(); };
  useIsoLayoutEffect(() => {
    if (!group || !open) return undefined;
    closeOthers();
    openInGroup.set(group, self.current);
    return () => { if (openInGroup.get(group) === self.current) openInGroup.delete(group); };
  }, [group, open]);
  useAnchoredPosition({ anchorRef: anchor, panelRef: panel, placement, flip, open: open && !layer });
  useDismiss({ open, onClose: () => setOpen(false), refs: anchor });
  useIsoLayoutEffect(() => {
    const element = panel.current;
    if (!layer || !element?.showPopover) return undefined;
    if (!open) { if (element.matches(':popover-open')) element.hidePopover(); return undefined; }
    // Place from the anchor's rectangle: top-layer coordinates are the window's, through the interface zoom.
    const place = () => {
      const box = element.getBoundingClientRect(), scale = element.offsetWidth ? box.width / element.offsetWidth : 1;
      const rect = anchor.current.getBoundingClientRect(), wall = outside ? anchor.current.closest(outside)?.getBoundingClientRect() : null;
      const args = { size: { width: box.width, height: box.height }, bounds: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, placement, flip, gap: 4 * scale };
      let spot = computePlacement({ ...args, anchor: wall ? { left: wall.left, right: wall.right, top: rect.top, bottom: rect.bottom } : rect });
      // No room beside the container: open under (or over) the anchor itself.
      if (wall && !/^(left|right)-/.test(spot.placement)) spot = computePlacement({ ...args, anchor: rect });
      element.style.left = `${spot.left / scale}px`;
      element.style.top = `${spot.top / scale}px`;
    };
    element.style.visibility = 'hidden';
    element.showPopover();
    place();
    element.style.visibility = '';
    // The anchor moves when something scrolls (a focused tab scrolling into view): follow it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [layer, open, placement, flip, outside]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const worded = Boolean(content);
  useEffect(() => { if (!worded) { clearTimeout(timer.current); setOpen(false); } }, [worded]);
  const later = (delay, visible) => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(visible && worded), delay); };
  const now = visible => { clearTimeout(timer.current); setOpen(visible && worded); };
  const child = React.Children.only(children);
  const describedBy = [child.props['aria-describedby'], id].filter(Boolean).join(' ');
  const own = child.props;
  return (
    <span ref={anchor} className={cx('sh-popover-anchor', anchorClassName)}>
      {cloneElement(child, {
        'aria-describedby': describedBy,
        onPointerEnter: chain(own.onPointerEnter, event => { if (event.pointerType !== 'touch') { closeOthers(); later(HOVER_DELAY, true); } }),
        onPointerLeave: chain(own.onPointerLeave, event => { if (event.pointerType !== 'touch') { if (interactive) later(LEAVE_DELAY, false); else now(false); } }),
        onFocus: chain(own.onFocus, () => now(true)),
        onBlur: chain(own.onBlur, () => now(false)),
        onPointerDown: chain(own.onPointerDown, event => {
          if (event.pointerType !== 'touch') return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => { setOpen(worded); timer.current = setTimeout(() => setOpen(false), TOUCH_LINGER); }, PRESS_DELAY);
        }),
        onPointerUp: chain(own.onPointerUp, event => { if (event.pointerType === 'touch' && !open) clearTimeout(timer.current); }),
        onPointerCancel: chain(own.onPointerCancel, () => { if (!open) clearTimeout(timer.current); }),
      })}
      <span id={id} role="tooltip" ref={panel} hidden={layer ? undefined : !open} popover={layer ? 'manual' : undefined} data-placement={placement}
        onPointerEnter={interactive ? () => clearTimeout(timer.current) : undefined}
        onPointerLeave={interactive ? event => { if (event.pointerType !== 'touch') later(LEAVE_DELAY, false); } : undefined}
        className={cx('sh-popover', 'sh-tooltip', interactive && 'sh-tooltip--interactive', className)}>{content}</span>
    </span>
  );
}
