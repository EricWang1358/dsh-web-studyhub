import React, { forwardRef } from 'react';
import css from './components.css';
import variantsCss from './button-variants.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';

const VARIANTS = new Set(['primary', 'secondary', 'quiet', 'link', 'danger']);
const ALIGNS = new Set(['start', 'center']);
const glyph = (icon, size) => typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon || null;

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
 */
export const Button = forwardRef(function Button({ variant = 'secondary', size = 'md', type = 'button', icon, iconEnd,
  busy = false, busyLabel, wrap = false, block = false, align, shape, disabled = false, className, children, onClick, ...rest }, ref) {
  useComponentCss(css);
  useComponentCss(variantsCss, 'study-button-variants');
  const kind = VARIANTS.has(variant) ? variant : 'secondary';
  const scale = size === 'sm' ? 'sm' : 'md';
  const iconSize = scale === 'sm' ? 16 : 18;
  const pill = shape === 'pill' && rest['aria-pressed'] !== undefined;
  const press = onClick && (event => { holdWidth(event.currentTarget); onClick(event); });
  return (
    <button ref={ref} type={type} onClick={press}
      className={cx('sh-btn', `sh-btn--${kind}`, `sh-btn--${scale}`, wrap && 'sh-btn--wrap', block && 'sh-btn--block',
        ALIGNS.has(align) && `sh-btn--${align}`, pill && 'sh-btn--pill', className)}
      disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="sh-spinner" aria-hidden="true" /> : glyph(icon, iconSize)}
      {busy && busyLabel != null ? busyLabel : children}
      {glyph(iconEnd, iconSize)}
    </button>
  );
});

/** A square button with only an icon; `label` becomes its accessible name and tooltip. */
export const IconButton = forwardRef(function IconButton({ icon, label, variant = 'quiet', size = 'md', className, ...rest }, ref) {
  return <Button ref={ref} variant={variant} size={size} icon={icon} aria-label={label} title={label}
    className={cx('sh-btn--icon', className)} {...rest} />;
});
