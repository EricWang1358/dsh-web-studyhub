import React, { useEffect } from 'react';
import { ui } from '../i18n.js';
import { Button } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useCopyFeedback } from '../use-copy-feedback.js';
import css from './diagnostic-actions.css';

/* Shared one-click diagnostic copy (复制诊断信息) + main-chat hand-off (发给主会话) bar.
   DiagnosticBar deliberately avoids importing HandOff.jsx: HandOff already sits at wave depth 3 in the workspace bundle, so callers pass
   their HandOff element ('setup.failed' or 'job.failed') via `children` (node or `input => ...`), keeping this shared module at depth 2
   and preserving the 6-wave workspace static closure ceiling. */

export function DiagnosticBar({ diagnostic, text, resetKey, fallback = '', row = false, className = '', children }) {
  useInjectCss(css, 'study-diagnostic-actions');
  const read = () => (typeof diagnostic === 'function' ? diagnostic() : diagnostic);
  const { copied, failed, copy, reset } = useCopyFeedback(text || (() => read()?.text || ''));
  useEffect(() => {
    if (resetKey !== undefined) reset();
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className={['sh-diag-actions', row && 'sh-diag-actions--row', className].filter(Boolean).join(' ')}>
      <Button size="sm" variant="quiet" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
        {copied ? ui('已复制') : ui('复制诊断信息')}
      </Button>
      {typeof children === 'function' ? children(() => read()?.input || {}) : children}
      {failed && <span className="sh-diag-actions__note">{fallback || ui('没能复制，请点「发给主会话」查看全文')}</span>}
    </span>
  );
}

export default DiagnosticBar;
