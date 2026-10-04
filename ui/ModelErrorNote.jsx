import React, { createContext, useContext } from 'react';
import { ui } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Disclosure, InlineMessage } from './components/index.js';
import { describeFailure, describeModelError } from './generation-status.js';
import css from './model-notes.css';

/** A page that can open the model settings provides it here, so a note deep inside it offers the button without prop threading. */
export const ModelSettingsContext = createContext(null);

/**
 * A model failure in plain words, wherever it is shown: an alert with the title and hint from the one failure table
 * (generation-status.js), a fix when there is one (the model settings for a key or a balance, a retry for the rest) and the
 * provider's own text behind a Disclosure. An error that is not recognised is shown as it is.
 * error: the message text or an Error. onSettings / onRetry: the buttons exist only when the page can do them.
 * context: 'generate' reads the error as a generation failure (a spent time budget, a failed quality gate...; hasDraft says
 * questions were kept), anything else as a failure of a call in the learning flow.
 */
export default function ModelErrorNote({ error, onSettings, onRetry, context, hasDraft = false, className, ...rest }) {
  useInjectCss(css, 'study-model-notes');
  const fromPage = useContext(ModelSettingsContext);
  onSettings = onSettings ?? fromPage ?? undefined;
  const text = typeof error === 'string' ? error : String(error?.message ?? error ?? '');
  const info = context === 'generate' ? { ...describeFailure(text, { hasDraft }), detail: text.trim() } : describeModelError(text);
  const known = info.kind !== 'unknown';
  if (!known && context !== 'generate') return <InlineMessage tone="error" className={className} data-context={context} {...rest}>{info.title}</InlineMessage>;
  const want = info.action || 'retry';
  const action = want === 'settings' && onSettings ? { label: ui('打开模型设置'), onClick: onSettings }
    : want === 'retry' && onRetry ? { label: ui('重试'), onClick: onRetry } : undefined;
  return (
    <InlineMessage tone="error" title={info.title} action={action} className={className} data-context={context} {...rest}>
      {info.hint}
      {info.detail && <Disclosure summary={ui('技术详情')} className="model-note__detail"><code className="model-note__raw">{info.detail}</code></Disclosure>}
    </InlineMessage>
  );
}
