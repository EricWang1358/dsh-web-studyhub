import React, { useContext, useEffect, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage } from '../i18n.js';
import css from './feedback.css';
import { useComponentCss, cx } from './css.js';
import { Button } from './Button.jsx';
import { InlineMessage } from './Feedback.jsx';
import { Disclosure } from './Panel.jsx';
import Icon from './Icon.jsx';
import { useCopyFeedback } from '../use-copy-feedback.js';
import { DiagnosticContext } from './diagnostic-context.js';

/** The words of an error, localized: backend messages go through uiMessage, an empty one says something generic. */
export const errorText = error => {
  const raw = typeof error === 'string' ? error : error?.message;
  return raw ? uiMessage(String(raw)) : ui('这次没有成功，也没有拿到具体原因。可以再试一次。');
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
 * 复制诊断信息: writes `describe()` (the text of ui/diagnostics.js) to the clipboard and says 已复制 for a moment. The text itself is always one fold
 * away (看看会复制什么), so the learner reads what leaves the app before it does. When the browser refuses the clipboard, the fold opens and the text
 * is selected, so a bug report is never blocked on it. `describe()` runs only when the text is needed: on copy, and while the fold is open.
 */
export function CopyDiagnosticsButton({ describe, variant = 'quiet', size = 'sm', className, children }) {
  const { copied, copy } = useCopyFeedback(describe);
  const [refusals, setRefusals] = useState(0), [open, setOpen] = useState(false);
  const field = useRef(null);
  useEffect(() => { if (refusals) field.current?.focus(); }, [refusals]);
  const press = async () => {
    const worked = await copy();
    setRefusals(count => (worked ? 0 : count + 1));
    if (!worked) setOpen(true);
  };
  return (
    <span className={cx('sh-diagnostic-copy', className)}>
      <Button size={size} variant={variant} icon="copy" onClick={press}>{copied ? ui('已复制') : ui('复制诊断信息')}</Button>
      {children}
      {refusals > 0 && <small className="sh-diagnostic-copy__refused" role="status">{ui('没能复制，请选中下面的文字再复制')}</small>}
      <Disclosure className="sh-diagnostic-copy__fold" summary={ui('看看会复制什么')} open={open} onToggle={setOpen}>
        {open && <textarea ref={field} className="sh-diagnostic-copy__text" readOnly rows={8} value={describe()} aria-label={ui('诊断信息')} onFocus={event => event.target.select()} />}
      </Disclosure>
    </span>
  );
}

/**
 * What an error boundary shows when a part of the app throws: what happened
 * in plain words, a retry, a copyable diagnostic text (`diagnostic(error)`
 * gives it), and the raw error behind a disclosure for whoever needs to
 * report it.
 */
export function CrashFallback({ error, onRetry, retryLabel, title, hint, diagnostic: given, className, ...rest }) {
  useComponentCss(css, 'study-feedback');
  // The page's boundary provides the text (DiagnosticContext), so a boundary inside the page offers the button too.
  const inherited = useContext(DiagnosticContext), diagnostic = given || inherited;
  const detail = typeof error === 'string' ? error : error?.message;
  return (
    <div className={cx('sh-crash', className)} role="alert" {...rest}>
      <Icon name="error" size={24} className="sh-crash__icon" />
      <div className="sh-crash__body">
        <strong className="sh-crash__title">{title || ui('这部分没能显示')}</strong>
        <p className="sh-crash__hint">{hint || (onRetry ? uiFormat('这部分显示出了错。先点「{0}」；还不行就刷新页面（已保存的内容不会因此丢失）。', [retryLabel || ui('重试')]) : ui('这部分显示出了错。刷新页面再试（已保存的内容不会因此丢失）。'))}</p>
        {(onRetry || diagnostic) && <div className="sh-crash__actions">
          {onRetry && <Button size="sm" icon="refresh" onClick={onRetry}>{retryLabel || ui('重试')}</Button>}
          {diagnostic && <CopyDiagnosticsButton describe={() => diagnostic(error)} />}
        </div>}
        {detail && <Disclosure className="sh-crash__detail" summary={ui('技术详情')}><code className="sh-crash__raw">{String(detail)}</code></Disclosure>}
      </div>
    </div>
  );
}
