import React, { cloneElement, useEffect, useId, useRef, useState } from 'react';
import css from './components.css';
import overlayCss from './overlays.css';
import { useComponentCss, cx } from './css.js';
import { useAnchoredPosition, useDismiss } from './use-dismiss.js';

const HOVER_DELAY = 250, PRESS_DELAY = 500, TOUCH_LINGER = 3000;
const chain = (own, extra) => event => { own?.(event); extra(event); };

/**
 * Words for a control, shown on hover, on keyboard focus and on a long press,
 * and tied to it with aria-describedby (the text stays in the DOM, hidden,
 * while closed, so the description always resolves). Use it where the text
 * carries something the label does not; a title attribute that only repeats
 * the label can stay. Escape hides it. `children` is one element.
 */
export default function Tooltip({ content, children, placement = 'bottom-start', flip = true, className }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  const [open, setOpen] = useState(false);
  const id = useId(), anchor = useRef(null), panel = useRef(null), timer = useRef(0);
  useAnchoredPosition({ anchorRef: anchor, panelRef: panel, placement, flip, open });
  useDismiss({ open, onClose: () => setOpen(false), refs: anchor });
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (delay, visible) => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(visible), delay); };
  const now = visible => { clearTimeout(timer.current); setOpen(visible); };
  const child = React.Children.only(children);
  const describedBy = [child.props['aria-describedby'], id].filter(Boolean).join(' ');
  const own = child.props;
  return (
    <span ref={anchor} className="sh-popover-anchor">
      {cloneElement(child, {
        'aria-describedby': describedBy,
        onPointerEnter: chain(own.onPointerEnter, event => { if (event.pointerType !== 'touch') later(HOVER_DELAY, true); }),
        onPointerLeave: chain(own.onPointerLeave, event => { if (event.pointerType !== 'touch') now(false); }),
        onFocus: chain(own.onFocus, () => now(true)),
        onBlur: chain(own.onBlur, () => now(false)),
        onPointerDown: chain(own.onPointerDown, event => {
          if (event.pointerType !== 'touch') return;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => { setOpen(true); timer.current = setTimeout(() => setOpen(false), TOUCH_LINGER); }, PRESS_DELAY);
        }),
        onPointerUp: chain(own.onPointerUp, event => { if (event.pointerType === 'touch' && !open) clearTimeout(timer.current); }),
        onPointerCancel: chain(own.onPointerCancel, () => { if (!open) clearTimeout(timer.current); }),
      })}
      <span id={id} role="tooltip" ref={panel} hidden={!open} data-placement={placement} className={cx('sh-popover', 'sh-tooltip', className)}>{content}</span>
    </span>
  );
}
