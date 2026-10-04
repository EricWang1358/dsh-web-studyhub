import React from 'react';
import css from './feedback.css';
import { useComponentCss, cx } from './css.js';
import { toneOf } from './tones.js';

/** The one small muted note under a control or heading. size: xs | sm; `as` picks the element. */
export function Hint({ size = 'sm', tone, as: Tag = 'p', className, children, ...rest }) {
  useComponentCss(css, 'study-feedback');
  return <Tag className={cx('sh-hint', `sh-hint--${size === 'xs' ? 'xs' : 'sm'}`, className)} data-tone={tone ? toneOf(tone) : undefined} {...rest}>{children}</Tag>;
}
