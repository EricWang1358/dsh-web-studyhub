import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Tooltip } from '../components/index.js';
import { useApp } from '../app/app-context.js';
import { formatElapsed, formatList, joinMeta } from '../format.js';
import { contractOf } from './task-model.js';
import { callLabel } from './call-model.js';
import { LIMIT_ANCHOR, callLimitHit, limitFacts, longRuleText, slowestText } from './time-limit.js';

/* The time limit of a task, on its page (the owner's complaint of 2026-10-06): the limit that applies and how much of it is used, one clause on the limit of a single call, what a stop by the limit
   keeps, the steps that took the time (a button each: it selects the call, like its bar on the timeline), and, where the limit is the setting, the way to change it. The words and numbers are
   ui/tasks/time-limit.js' (limitFacts, slowSteps) over the contract's detail.timeLimit; the link only opens 设置 › 出题偏好 (ui/GenerationSettings.jsx), which is the one editor of the number. */

const minutes = (seconds) => uiFormat('{0} 分钟', [Math.max(1, Math.round(seconds / 60))]);
const limitText = ({ scope, seconds, callSeconds }) => {
  if (scope === 'call') return callSeconds > 0 ? uiFormat('单次模型调用最长 {0}', [minutes(callSeconds)]) : ui('单次模型调用时限 无上限');
  if (seconds === 0) return scope === 'round' ? ui('每轮运行时限 无上限') : ui('运行时限 无上限');
  return uiFormat(scope === 'round' ? '每轮运行时限 {0}' : scope === 'fixed' ? '运行时限 {0}（固定）' : '运行时限 {0}', [minutes(seconds)]);
};
const usedText = ({ scope, usedMs }) => (usedMs === null ? '' : uiFormat(scope === 'round' ? '本轮已用 {0}' : '已用 {0}', [formatElapsed(usedMs)]));
const KEPT = { questions: '已通过检查的题已保留', paragraphs: '已翻译的段落已保留', nothing: '题组没有变化', inventory: '已读完的部分已保留' };
const secondaryCallText = ({ scope, callSeconds, silentSeconds }) => {
  if (scope === 'call') return silentSeconds > 0 ? uiFormat('连续 {0} 分钟无输出自动截断', [Math.max(1, Math.round(silentSeconds / 60))]) : '';
  if (callSeconds > 0) return uiFormat('单次模型调用最长 {0}', [minutes(callSeconds)]);
  if (callSeconds === 0) return ui('单次模型调用 无上限');
  return '';
};

export default function TimeLimit({ task, now, steps = [], onPick }) {
  const { settingsEntry } = useApp();
  const contract = contractOf(task), facts = limitFacts(contract, { now });
  if (!facts) return null;
  const calls = new Map(contract.calls.map((call) => [call.callId, call]));
  // The steps are named while the task runs (a step far past its kind) and when it ended by the limit (where the time went); an ended task that was not stopped by it has nothing to answer for.
  const shown = facts.hit || facts.live ? steps : [];
  const named = shown.slice(0, 2).map((step) => ({ ...step, call: calls.get(step.callId) })).filter((step) => step.call);
  const kept = ui(KEPT[facts.keeps] || KEPT.questions);
  const note = facts.hit ? uiFormat('已用满时限，任务自动停止；{0}。', [kept])
    : facts.rounds.length ? uiFormat('{0}到了时限；已通过的题已保留。', [uiFormat('第 {0} 轮', [formatList(facts.rounds)])]) : '';
  const slowest = facts.hit, lead = slowest ? (shown.length > 1 ? ui('最慢的几步：') : ui('最慢的一步：')) : ui('运行偏久：');
  const secondary = secondaryCallText(facts);
  return (
    <div className="tc-limit" role="status" aria-label={ui('时限')} data-limit-scope={facts.scope} data-limit-hit={facts.hit ? 'true' : 'false'} {...(facts.rounds.length ? { 'data-limit-rounds': facts.rounds.join(',') } : {})}>
      <span className="tc-limit__k">{ui('时限')}</span>
      <strong className="tc-limit__line" data-limit-line>{joinMeta([limitText(facts), usedText(facts)])}</strong>
      {secondary && <span className="tc-limit__call" data-limit-call>{secondary}</span>}
      {facts.adjustable && settingsEntry?.openSettings && (
        <Button iconEnd="arrow-right" size="sm" variant="quiet" className="tc-limit__adjust" data-limit-adjust
          title={ui('在「设置 › 出题偏好」里修改运行时限或单次调用时限（填 0 为无上限）。只对之后开始的任务生效，已经开始的不受影响。')} onClick={() => settingsEntry.openSettings(LIMIT_ANCHOR)}>{ui('调整时限')}</Button>
      )}
      {note && <span className="tc-limit__note" data-limit-note>{note}</span>}
      {named.length > 0 && (
        <span className="tc-limit__slow" data-limit-slow>
          <Tooltip layer anchorClassName="tc-limit__lead" content={slowest ? slowestText() : longRuleText()}><span tabIndex={0}>{lead}</span></Tooltip>
          {named.map((step) => (
            <Button key={step.callId} size="sm" variant="link" className="tc-limit__step" data-slow-call={step.callId} data-mark={step.mark} title={step.mark === 'long' ? longRuleText() : slowestText()}
              onClick={() => onPick?.(step.callId)}>{joinMeta([callLabel(step.call, { file: true }), formatElapsed(step.ms), callLimitHit(step.call, facts.callSeconds, now) ? ui('到了单次调用上限') : ''])}</Button>
          ))}
          {shown.length > named.length && <span className="tc-limit__more">{uiFormat('另有 {0} 步', [shown.length - named.length])}</span>}
        </span>
      )}
    </div>
  );
}
