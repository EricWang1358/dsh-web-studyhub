import React from 'react';
import { ui } from '../i18n.js';
import css from './feedback.css';
import { useComponentCss, cx } from './css.js';
import { IconButton } from './Button.jsx';
import Icon from './Icon.jsx';
import { toneOf, TONE_ICONS } from './tones.js';

const glyph = (icon, tone, size) => {
  if (icon === true) return TONE_ICONS[tone] ? <Icon name={TONE_ICONS[tone]} size={size} /> : null;
  return typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon || null;
};

/**
 * A small status label. tone: neutral | info | success | warning | error |
 * accent (accent is for the one thing that needs attention, never a default);
 * size: sm | md. `icon` takes an Icon name, an element, or `true` for the
 * tone's own icon; `dot` adds a coloured dot. Both keep meaning off colour.
 */
export function Badge({ tone = 'neutral', size = 'md', icon, dot = false, className, children, ...rest }) {
  useComponentCss(css, 'study-feedback');
  const kind = toneOf(tone);
  const scale = size === 'sm' ? 'sm' : 'md';
  return (
    <span className={cx('sh-badge', `sh-badge--${scale}`, className)} data-tone={kind} {...rest}>
      {dot && <span className="sh-badge__dot" aria-hidden="true" />}
      {glyph(icon, kind, scale === 'sm' ? 12 : 14)}
      {children}
    </span>
  );
}

/**
 * A chip you can act on. With onClick it is a toggle button (aria-pressed
 * follows `selected`); without it the label is plain text. onRemove adds a
 * separate, named remove button.
 */
export function Chip({ selected = false, onClick, onRemove, removeLabel, tone = 'neutral', size = 'md', icon, className, children, ...rest }) {
  useComponentCss(css, 'study-feedback');
  const kind = toneOf(tone);
  const scale = size === 'sm' ? 'sm' : 'md';
  const mark = glyph(icon, kind, scale === 'sm' ? 12 : 14);
  return (
    <span className={cx('sh-chip', `sh-chip--${scale}`, selected && 'is-selected', className)} data-tone={kind} {...rest}>
      {onClick
        ? <button type="button" className="sh-chip__main" aria-pressed={!!selected} onClick={onClick}>{mark}{children}</button>
        : <span className="sh-chip__label">{mark}{children}</span>}
      {onRemove && <IconButton icon="close" size="sm" className="sh-chip__remove" label={removeLabel || ui('移除')} onClick={onRemove} />}
    </span>
  );
}
