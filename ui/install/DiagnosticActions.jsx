import React from 'react';
import { CopyDiagnosticsButton } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import css from './diagnostic-actions.css';

/* Shared one-click diagnostic copy (复制诊断信息) + main-chat hand-off (发给主会话) bar.
   The copy is the app's one CopyDiagnosticsButton (ui/components/ErrorState.jsx): the text is one fold away (看看会复制什么) and, when the clipboard
   refuses, the fold opens with the text selected. DiagnosticBar deliberately avoids importing HandOff.jsx: HandOff already sits at wave depth 3 in the
   workspace bundle, so callers pass their HandOff element ('setup.failed' or 'job.failed') via `children` (node or `input => ...`), keeping this shared
   module at depth 2 and preserving the 6-wave workspace static closure ceiling. `resetKey` starts the button afresh when what it reports changes. */

export function DiagnosticBar({ diagnostic, text, resetKey, row = false, className = '', children }) {
  useInjectCss(css, 'study-diagnostic-actions');
  const read = () => (typeof diagnostic === 'function' ? diagnostic() : diagnostic);
  const describe = () => (typeof text === 'function' ? text() : text) || read()?.text || '';
  return (
    <span className={['sh-diag-actions', row && 'sh-diag-actions--row', className].filter(Boolean).join(' ')}>
      <CopyDiagnosticsButton key={resetKey} describe={describe} />
      {typeof children === 'function' ? children(() => read()?.input || {}) : children}
    </span>
  );
}

export default DiagnosticBar;
