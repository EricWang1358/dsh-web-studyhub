import React, { forwardRef } from 'react';
import css from './components.css';
import { useComponentCss, cx } from './css.js';
import Icon from './Icon.jsx';

const VARIANTS = new Set(['primary', 'secondary', 'quiet', 'link', 'danger']);
const glyph = (icon, size) => typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon || null;

/**
 * One button for the whole app. variant: primary (one per view) | secondary |
 * quiet | link | danger; size: sm | md. `icon` / `iconEnd` take an Icon name or
 * an element. `busy` disables the button and shows a spinner.
 */
export const Button = forwardRef(function Button({ variant = 'secondary', size = 'md', type = 'button', icon, iconEnd,
  busy = false, disabled = false, className, children, ...rest }, ref) {
  useComponentCss(css);
  const kind = VARIANTS.has(variant) ? variant : 'secondary';
  const scale = size === 'sm' ? 'sm' : 'md';
  const iconSize = scale === 'sm' ? 16 : 18;
  return (
    <button ref={ref} type={type} className={cx('sh-btn', `sh-btn--${kind}`, `sh-btn--${scale}`, className)}
      disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="sh-spinner" aria-hidden="true" /> : glyph(icon, iconSize)}
      {children}
      {glyph(iconEnd, iconSize)}
    </button>
  );
});

/** A square button with only an icon; `label` becomes its accessible name and tooltip. */
export const IconButton = forwardRef(function IconButton({ icon, label, variant = 'quiet', size = 'md', className, ...rest }, ref) {
  return <Button ref={ref} variant={variant} size={size} icon={icon} aria-label={label} title={label}
    className={cx('sh-btn--icon', className)} {...rest} />;
});
