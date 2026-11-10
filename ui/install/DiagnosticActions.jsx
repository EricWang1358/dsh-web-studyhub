import React from 'react';
import { CopyDiagnosticsButton, Tooltip } from '../components/index.js';
import { ui } from '../i18n.js';
import { needsWrite } from '../agent-prompts/setup-repairs.js';
import { useInjectCss } from '../shared.js';
import css from './diagnostic-actions.css';

/* Shared one-click diagnostic copy (复制诊断信息) + main-chat hand-off (发给主会话) bar.
   The copy is the app's one CopyDiagnosticsButton (ui/components/ErrorState.jsx): the text is one fold away (看看会复制什么) and, when the clipboard
   refuses, the fold opens with the text selected. DiagnosticBar deliberately avoids importing HandOff.jsx: HandOff already sits at wave depth 3 in the
   workspace bundle, so callers pass their HandOff element ('setup.failed' or 'job.failed') via `children` (node or `input => ...`), keeping this shared
   module at depth 2 and preserving the 6-wave workspace static closure ceiling. `resetKey` starts the button afresh when what it reports changes.
   A bar given a `diagnostic` is a local tool's (the 'setup.failed' hand-off, #939). When the repairs for its failure code may write outside the workspace (needsWrite:
   ui/agent-prompts/setup-repairs.js) the main chat needs DSH's full permission, so the bar says to switch it first and back afterwards (StudyHub cannot switch it, and
   cannot read the session's mode: it is a log event of DSH, so the sentence is always there when it applies). A failure whose repairs only read (the search extension,
   a network test) says nothing, and neither does a bar with only a `text` (a failed job). The sentence has its own row under the two buttons, before the fold: a local tool's bar hands the hand-off and the sentence to the copy button as its slot (between the button and the fold),
   so the DOM, and the tab order, is the visual order; a failed job's bar keeps the copy button and the hand-off side by side as before. */

const PERMISSION_HINT = '发送前，把主会话权限（输入框左下角）换成「完全权限」，修完换回。';
const PERMISSION_WHY = '主会话要改 StudyHub 文件夹以外的东西（比如工具的安装位置）。权限是「仅可查看」或「工作区内修改」时，它改不了工作区以外的文件，命令会被拒绝。「完全权限」意味着这个会话可以改这台电脑上的任何文件；StudyHub 切换不了它，要你自己在输入框左下角的权限菜单里选。修好后请换回原来的选项。';

export function DiagnosticBar({ diagnostic, text, resetKey, row = false, className = '', children }) {
  useInjectCss(css, 'study-diagnostic-actions');
  const read = () => (typeof diagnostic === 'function' ? diagnostic() : diagnostic);
  const failure = diagnostic != null ? read()?.input : null, asks = !!failure && needsWrite(failure.tool, failure.code, failure.installedBy);
  const beside = typeof children === 'function' ? children(() => read()?.input || {}) : children;
  const hint = asks && <Tooltip layer content={ui(PERMISSION_WHY)} anchorClassName="sh-diag-actions__hint-row"><span tabIndex={0} className="sh-diag-actions__hint">{ui(PERMISSION_HINT)}</span></Tooltip>;
  const describe = () => (typeof text === 'function' ? text() : text) || read()?.text || '';
  return (
    <span className={['sh-diag-actions', row && 'sh-diag-actions--row', className].filter(Boolean).join(' ')}>
      {diagnostic != null
        ? <CopyDiagnosticsButton key={resetKey} describe={describe} className="sh-diag-actions__copy">{beside}{hint}</CopyDiagnosticsButton>
        : <><CopyDiagnosticsButton key={resetKey} describe={describe} />{beside}</>}
    </span>
  );
}

export default DiagnosticBar;
