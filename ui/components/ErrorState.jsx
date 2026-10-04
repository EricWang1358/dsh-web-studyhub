import React from 'react';
import { ui, uiMessage } from '../i18n.js';
import css from './feedback.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import { InlineMessage } from './Feedback.jsx';
import { Disclosure } from './Panel.jsx';
import Icon from './Icon.jsx';

/** The words of an error, localized: backend messages go through uiMessage, an empty one says something generic. */
export const errorText = error => {
  const raw = typeof error === 'string' ? error : error?.message;
  return raw ? uiMessage(String(raw)) : ui('出了点问题，请重试。');
};

/**
 * A failed read or action: an error alert (InlineMessage tone="error") with an
 * optional retry. compact drops the box for use inside a row or a line.
 */
export function ErrorState({ error, onRetry, retryLabel, compact = false, title, className, ...rest }) {
  useComponentCss(css, 'study-feedback');
  return (
    <InlineMessage tone="error" boxed={!compact} title={title} className={cx('sh-error-state', compact && 'sh-error-state--compact', className)}
      action={onRetry ? { label: retryLabel || ui('重试'), onClick: onRetry } : undefined} {...rest}>
      {errorText(error)}
    </InlineMessage>
  );
}

/**
 * What an error boundary shows when a part of the app throws: what happened
 * in plain words, a retry, and the raw error behind a disclosure for whoever
 * needs to report it.
 */
export function CrashFallback({ error, onRetry, retryLabel, title, hint, className, ...rest }) {
  useComponentCss(css, 'study-feedback');
  const detail = typeof error === 'string' ? error : error?.message;
  return (
    <div className={cx('sh-crash', className)} role="alert" {...rest}>
      <Icon name="error" size={24} className="sh-crash__icon" />
      <div className="sh-crash__body">
        <strong className="sh-crash__title">{title || ui('这部分没能显示')}</strong>
        <p className="sh-crash__hint">{hint || ui('学习记录没有受到影响。重试一次；如果还是不行，刷新页面。')}</p>
        {onRetry && <div className="sh-crash__actions"><Button size="sm" icon="refresh" onClick={onRetry}>{retryLabel || ui('重试')}</Button></div>}
        {detail && <Disclosure className="sh-crash__detail" summary={ui('技术详情')}><code className="sh-crash__raw">{String(detail)}</code></Disclosure>}
      </div>
    </div>
  );
}
