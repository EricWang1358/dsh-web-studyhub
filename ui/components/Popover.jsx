import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import css from './components.css';
import overlayCss from './overlays.css';
import { useComponentCss, cx } from './css.js';
import { IconButton } from './Button.jsx';
import { useAnchoredPosition, useDismiss } from './use-dismiss.js';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A non-modal panel next to its trigger (display settings, a layout choice, a
 * note). The trigger carries aria-haspopup="dialog", aria-expanded and
 * aria-controls (never aria-pressed); the panel is a labelled role="dialog".
 * Focus moves to its first control on open and back to the trigger when it
 * closes by Escape, by its own controls or by the trigger; an outside press
 * closes it without taking focus from where the learner went. It stays inside
 * `boundsRef` (default: the window), flips when there is no room below and is
 * limited to the room that is left.
 *
 * label: the panel's accessible name (and the default trigger's). icon: the
 * default IconButton trigger. trigger({ props, ref, open }): render your own
 * (a text button); spread `props` and attach `ref`. For a whole-surface
 * chooser use Dialog instead.
 */
export default function Popover({ label, icon, trigger, children, open: controlled, defaultOpen = false, onOpenChange, placement = 'bottom-end',
  flip = true, boundsRef, boundsSelector, className, panelClassName, triggerClassName, triggerProps, ...rest }) {
  useComponentCss(css);
  useComponentCss(overlayCss, 'study-overlays');
  const [inner, setInner] = useState(defaultOpen);
  const isOpen = controlled ?? inner;
  const setOpen = value => { if (controlled === undefined) setInner(value); onOpenChange?.(value); };
  const anchor = useRef(null), triggerRef = useRef(null), panel = useRef(null), was = useRef(false), bounds = useRef(null);
  const panelId = useId(), labelId = useId();
  // `boundsSelector` finds the bounds from the trigger's own ancestors (the reader keeps its panels inside the viewer).
  useIsoLayoutEffect(() => { bounds.current = boundsRef?.current ?? (boundsSelector ? anchor.current?.closest(boundsSelector) : null) ?? null; });
  useAnchoredPosition({ anchorRef: anchor, panelRef: panel, boundsRef: bounds, placement, flip, open: isOpen });
  useDismiss({ open: isOpen, onClose: () => setOpen(false), refs: anchor, returnFocusRef: triggerRef });
  useEffect(() => {
    if (isOpen) {
      was.current = true;
      const element = panel.current;
      (element?.querySelector(FOCUSABLE) || element)?.focus({ preventScroll: true });
    } else if (was.current) {
      was.current = false;
      const active = document.activeElement;
      if (!active || active === document.body) triggerRef.current?.focus({ preventScroll: true });
    }
  }, [isOpen]);
  const props = { 'aria-haspopup': 'dialog', 'aria-expanded': isOpen, 'aria-controls': isOpen ? panelId : undefined,
    onClick: () => setOpen(!isOpen), ...triggerProps };
  return (
    <div className={cx(className, 'sh-popover-anchor')} ref={anchor} {...rest}>
      {trigger ? trigger({ props, ref: triggerRef, open: isOpen })
        : <IconButton ref={triggerRef} icon={icon} label={label} className={triggerClassName} {...props} />}
      {isOpen && <div ref={panel} id={panelId} role="dialog" aria-labelledby={labelId} tabIndex={-1} data-placement={placement}
        className={cx('sh-popover', panelClassName)}>
        <span id={labelId} className="sh-visually-hidden">{label}</span>
        {children}
      </div>}
    </div>
  );
}
