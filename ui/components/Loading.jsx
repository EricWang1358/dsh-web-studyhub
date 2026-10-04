import React from 'react';
import { ui } from '../i18n.js';
import css from './feedback.css';
import { useComponentCss, cx } from './css.js';

/** The one spinner (.sh-spinner in components.css). Decorative: pair it with text or a status region. */
export function Spinner({ size = 'md', className }) {
  useComponentCss(css, 'study-feedback');
  return <span className={cx('sh-spinner', size === 'sm' && 'sh-spinner--sm', className)} aria-hidden="true" />;
}

/**
 * "Reading…" with a spinner. It is a polite status region, so a screen reader
 * hears it once when it appears. inline: a span that sits in a line of text.
 */
export function LoadingState({ label, inline = false, className, children, ...rest }) {
  useComponentCss(css, 'study-feedback');
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag className={cx('sh-loading', inline && 'sh-loading--inline', className)} role="status" {...rest}>
      <Spinner size="sm" />
      <span className="sh-loading__label">{label || ui('正在载入…')}</span>
      {children}
    </Tag>
  );
}
