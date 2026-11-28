import React, { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import css from './components.css';
import overlayCss from './overlays.css';
import layerCss from './tooltip-layer.css';
import { useComponentCss, cx } from './css.js';
import { computePlacement, useAnchoredPosition, useDismiss } from './use-dismiss.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const HOVER_DELAY = 250, PRESS_DELAY = 500, TOUCH_LINGER = 3000, LEAVE_DELAY = 150, PRESS_FOCUS = 1000;
const chain = (own, extra) => event => { own?.(event); extra(event); };
// The open tooltip of each `group`: opening one closes the one before at once, so two cards are never on screen together.
const openInGroup = new Map();
// A card opens on focus only when the focus is the user's: keyboard focus (:focus-visible), or focus that follows a press on the anchor itself (a tap
// on a 「?」 that focuses it). A script that moves focus after a press elsewhere (a dialog handing it back, a suggested answer taking it) opens nothing;
// focusQuietly is for a script that moves focus while the user is on the keyboard, where :focus-visible still holds.
let quiet = false;
const userFocus = event => { if (quiet) return false; try { return event.target.matches(':focus-visible'); } catch { return true; } };
/** element.focus() that opens no tooltip card: focus the program chose (the control the answer suggests), not one the user moved there. */
export function focusQuietly(element, options) {
  if (typeof element?.focus !== 'function') return;
  quiet = true;
  try { element.focus(options); } finally { quiet = false; }
}

/**
 * Words for a control, shown on hover, on keyboard focus or a tap that focuses it (not on a script's focus, see userFocus) and on a long press,
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
 * forceOpen: show the card while true (e.g. the 资料 title button has keyboard focus and its cut facts line sits inside it), as long as there are words.
 * onOpenChange(open): told after the card opens or closes (the sidebar says its reorder line in the first card only, ui/nav-reorder-hint.js).
 * id: the card's own id, for a control outside the anchor that the card describes (its aria-describedby); one is made when it is not given.
 */
export default function Tooltip({ content, children, placement = 'bottom-start', flip = true, className, layer = false, anchorClassName, interactive = false, group, outside, onOpenChange, forceOpen = false, id: givenId }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  useComponentCss(layerCss, 'study-tooltip-layer');
  const [open, setOpen] = useState(false);
  // forceOpen: the caller opens the card while something the card's own handlers cannot see holds (keyboard focus on a control that contains the anchor),
  // and closes it when that ends. It opens like any other way, so another card of its `group` still closes it. Esc, a click outside or another card of
  // the group waives the hold: the card stays shut until the caller lets go and holds again (the next keyboard focus).
  const forced = forceOpen && Boolean(content);
  const [waived, setWaived] = useState(false);
  const held = useRef(false);
  held.current = forced && !waived;
  useIsoLayoutEffect(() => { if (!forced) setWaived(false); setOpen(forced); }, [forced]);
  const ownId = useId(), id = givenId || ownId, anchor = useRef(null), panel = useRef(null), timer = useRef(0), self = useRef(null), pressedAt = useRef(0);
  if (!self.current) self.current = { close: () => {} };
  self.current.close = () => { clearTimeout(timer.current); if (held.current) setWaived(true); setOpen(false); };
  const closeOthers = () => { const other = group && openInGroup.get(group); if (other && other !== self.current) other.close(); };
  useIsoLayoutEffect(() => {
    if (!group || !open) return undefined;
    closeOthers();
    openInGroup.set(group, self.current);
    return () => { if (openInGroup.get(group) === self.current) openInGroup.delete(group); };
  }, [group, open]);
  useAnchoredPosition({ anchorRef: anchor, panelRef: panel, placement, flip, open: open && !layer });
  // WCAG 1.4.13 (#1174): an open tooltip closes on Escape wherever focus or the pointer sits, through the shared dismiss stack so stacked cards close top-down.
  useDismiss({ open, onClose: () => { clearTimeout(timer.current); if (held.current) setWaived(true); setOpen(false); }, refs: anchor, escapeAnywhere: true });
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
  const openChange = useRef(onOpenChange), wasOpen = useRef(false);
  openChange.current = onOpenChange;
  useIsoLayoutEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    openChange.current?.(open);
  }, [open]);
  useEffect(() => () => { if (wasOpen.current) openChange.current?.(false); }, []); // an open card that goes away has closed
  const worded = Boolean(content);
  useEffect(() => { if (!worded) { clearTimeout(timer.current); setOpen(false); } }, [worded]);
  // Hover and focus on the anchor itself only add to a forced card: leaving the anchor returns to it (still open while the caller holds it).
  const later = (delay, visible) => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen((visible || held.current) && worded), delay); };
  const now = visible => { clearTimeout(timer.current); setOpen((visible || held.current) && worded); };
  const child = React.Children.only(children);
  const describedBy = [child.props['aria-describedby'], id].filter(Boolean).join(' ');
  const own = child.props;
  return (
    <span ref={anchor} className={cx('sh-popover-anchor', anchorClassName)}>
      {cloneElement(child, {
        'aria-describedby': describedBy,
        onPointerEnter: chain(own.onPointerEnter, event => { if (event.pointerType !== 'touch') { closeOthers(); later(HOVER_DELAY, true); } }),
        onPointerLeave: chain(own.onPointerLeave, event => { if (event.pointerType !== 'touch') { if (interactive) later(LEAVE_DELAY, false); else now(false); } }),
        onFocus: chain(own.onFocus, event => { if (userFocus(event) || (!quiet && Date.now() - pressedAt.current < PRESS_FOCUS)) now(true); }),
        onBlur: chain(own.onBlur, () => { pressedAt.current = 0; now(false); }),
        onPointerDown: chain(own.onPointerDown, event => {
          pressedAt.current = Date.now();
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
