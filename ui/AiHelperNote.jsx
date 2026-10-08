import React from 'react';
import { ui, uiFormat } from './i18n.js';
import { Disclosure, InlineMessage } from './components/index.js';
import { useInjectCss } from './shared.js';
import css from './ai-helper-note.css';
import { describeModelError } from './generation-status.js';
import { gateTitle } from './ModelSetupGate.jsx';
import { useModelSettingsLabel } from './ModelErrorNote.jsx';

/* One way of saying why an AI helper did not work (2.5.8), the same wherever a helper can fail: the 帮我想想 assist and the 分步生成路径
   refinement. The operation answers { reason, message?, sample? }:
     no-model        no model is configured: the settings are the way out
     failed          the call failed: its short error, in plain words when it is a known one (raw text to look at)
     nothing-usable  the model answered in a shape that could not be used: the answer, to look at and to send to the developer
   `fallback` says what the learner is left with ("先给你来自本地数据的建议"); the line is followed by 再试一次 when the helper can simply be asked again. */

const SETTINGS_KINDS = new Set(['credential', 'rejected', 'model-retired', 'quota']);

/** { kind, text, detail?, sample?, settings } for an unavailable answer, or null when there is nothing to explain (no signal, or no reason). */
export function describeAiUnavailable(unavailable, fallback) {
  const reason = unavailable?.reason, left = ui(fallback);
  if (reason === 'no-model') return { kind: reason, text: uiFormat('{0}。{1}。', [gateTitle('inline'), left]), settings: true };
  if (reason === 'failed') {
    const raw = String(unavailable.message || '').trim(), known = describeModelError(raw);
    return { kind: reason, settings: SETTINGS_KINDS.has(known.kind), detail: known.kind !== 'unknown' ? raw : '',
      text: uiFormat('AI 调用没有成功：{0}。{1}，可以再试一次。', [raw ? known.title : ui('没有说明原因'), left]) };
  }
  if (reason === 'nothing-usable')
    return { kind: reason, settings: false, sample: String(unavailable.sample || ''), text: uiFormat('AI 的回答不是约定的格式，没能用上。{0}，可以再试一次。', [left]) };
  return null;
}

/** onRetry: asks the helper again (omit when the page already has its own button for it); onSettings: opens the model settings. */
export default function AiHelperNote({ unavailable, fallback, onRetry, onSettings, className }) {
  useInjectCss(css, 'study-ai-helper-note');
  const settingsLabel = useModelSettingsLabel();
  const note = describeAiUnavailable(unavailable, fallback);
  if (!note) return null;
  const action = note.settings && onSettings ? { label: settingsLabel, onClick: onSettings }
    : !note.settings && onRetry ? { label: ui('再试一次'), onClick: onRetry } : undefined;
  const look = note.sample ? ui('看 AI 的回答（可以发给开发者）') : note.detail ? ui('看出错详情（可以发给开发者）') : '';
  return (
    <div className={['ai-helper-note', className].filter(Boolean).join(' ')} data-ai-helper-note={note.kind}>
      <InlineMessage tone="warning" action={action}>{note.text}</InlineMessage>
      {look && <Disclosure className="ai-helper-note__sample" summary={look}><pre>{note.sample || note.detail}</pre></Disclosure>}
    </div>
  );
}
