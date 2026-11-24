import React, { forwardRef, useEffect, useRef, useState } from 'react';
import css from './components.css';
import variantsCss from './button-variants.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';

const VARIANTS = new Set(['primary', 'secondary', 'quiet', 'link', 'danger']);
const ALIGNS = new Set(['start', 'center']);
const glyph = (icon, size, className) => typeof icon === 'string' ? <Icon name={icon} size={size} className={className} /> : icon || null;

/** A press remembers the button's width in --sh-held-width; while busy, CSS keeps the button at least that wide (the label may change, the row must not jump). */
export const holdWidth = element => element?.style?.setProperty('--sh-held-width', `${element.offsetWidth}px`);

/**
 * One button for the whole app. variant: primary (one per view) | secondary |
 * quiet | link | danger; size: sm | md. `icon` / `iconEnd` take an Icon name or
 * an element. `busy` disables the button, shows a spinner, announces
 * aria-busy and keeps the width the button had when it was pressed;
 * `busyLabel` replaces the label while busy. `wrap` lets a long label run over
 * several lines (start-aligned), `block` makes the button full width, `align`
 * (start | center) places the content. `shape="pill"` is for toggle buttons
 * only (it needs aria-pressed).
 *
 * `lock` takes the flag of a single-flight action (the app's `busy`, a page's
 * `saving`). While it is up the button is disabled; the spinner, aria-busy and
 * held width show only on the button that was pressed when the flag went up,
 * so a page of buttons does not all spin because one of them works. A button
 * that is locked without having been pressed (an action another button
 * started, or a handler that raised the flag after an await) stays disabled and
 * quiet. `busy` is for a button that always shows its own work.
 */
export const Button = forwardRef(function Button({ variant = 'secondary', size = 'md', type = 'button', icon, iconEnd, iconClassName, iconEndClassName,
  busy = false, lock, busyLabel, wrap = false, block = false, align, shape, disabled = false, className, children, onClick, ...rest }, ref) {
  useComponentCss(css);
  useComponentCss(variantsCss, 'study-button-variants');
  const kind = VARIANTS.has(variant) ? variant : 'secondary';
  const scale = size === 'sm' ? 'sm' : 'md';
  const iconSize = scale === 'sm' ? 16 : 18;
  const pill = shape === 'pill' && rest['aria-pressed'] !== undefined;
  const locks = lock !== undefined;
  const pressed = useRef(false);
  const [mine, setMine] = useState(false);
  // A press counts for the flag that goes up in the same event; the next task forgets it.
  useEffect(() => { setMine(!!lock && pressed.current); }, [lock]);
  const press = onClick || locks ? event => {
    holdWidth(event.currentTarget);
    if (locks) { pressed.current = true; setTimeout(() => { pressed.current = false; }, 0); }
    onClick?.(event);
  } : undefined;
  const working = busy || (!!lock && mine);
  const replaceEnd = working && busyLabel == null && !icon && !!iconEnd;
  const spinOver = working && busyLabel == null && !icon && !iconEnd;
  const label = working && busyLabel != null ? busyLabel : children;
  const endNode = replaceEnd ? <span className="sh-spinner" aria-hidden="true" /> : glyph(iconEnd, iconSize, iconEndClassName);
  // A wrapping link with a trailing arrow keeps the arrow glued to the last word so the icon never drops onto a line by itself (#1155).
  let body = label;
  let trailing = endNode;
  const hasInlineTrail = typeof iconEndClassName === 'string' && iconEndClassName.includes('sh-icon--trail');
  if (kind === 'link' && wrap && endNode && hasInlineTrail && typeof label === 'string' && label.length > 0) {
    const match = /^(.*\s)(\S+)$/s.exec(label);
    if (match) {
      body = <>{match[1]}<span className="sh-btn__tail">{match[2]}{endNode}</span></>;
      trailing = null;
    } else if ([...label].length <= 10) {
      body = <span className="sh-btn__tail">{label}{endNode}</span>;
      trailing = null;
    }
  }
  return (
    <button ref={ref} type={type} onClick={press}
      className={cx('sh-btn', `sh-btn--${kind}`, `sh-btn--${scale}`, wrap && 'sh-btn--wrap', block && 'sh-btn--block',
        ALIGNS.has(align) && `sh-btn--${align}`, pill && 'sh-btn--pill', spinOver && 'sh-btn--spin-over', className)}
      disabled={disabled || busy || !!lock} aria-busy={working || undefined} {...rest}>
      {working && !replaceEnd ? <span className="sh-spinner" aria-hidden="true" /> : glyph(icon, iconSize, iconClassName)}
      {body}
      {trailing}
    </button>
  );
});

/** A square button with only an icon; `label` becomes its accessible name and tooltip. */
export const IconButton = forwardRef(function IconButton({ icon, label, variant = 'quiet', size = 'md', className, ...rest }, ref) {
  return <Button ref={ref} variant={variant} size={size} icon={icon} aria-label={label} title={label}
    className={cx('sh-btn--icon', className)} {...rest} />;
});
