import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import { formatDuration, joinMeta } from '../format.js';
import { callLabel } from './call-model.js';

/* 资料部分: the parts a question run was split into, each with the state of its three stages (writing, review, repair) and what it kept once the run has
   reported. A selected part shows, in a strip of fixed height at the bottom, the calls it made. (The questions themselves live in the draft; the job does
   not record which part wrote which.) */

const STAGES = [['author', '出题'], ['review', '审阅'], ['repair', '修复']];
const STATUS_WORD = { passed: '全部通过', partial: '只保留了部分', failed: '没有出题', running: '进行中', working: '进行中', waiting: '等待中' };
const dot = (status) => (status === 'passed' ? 'done' : status === 'partial' ? 'partial' : status === 'failed' ? 'fail' : status === 'waiting' ? 'queued' : 'run');

export default function GenerationParts({ contract }) {
  const parts = contract.detail.partList || [], [picked, setPicked] = useState(parts.length === 1 ? 1 : null);
  const part = picked !== null ? parts.find((item) => item.part === picked) : null;
  const calls = part ? contract.calls.filter((call) => call.part === part.part) : [];
  return (
    <div className="tc-files">
      <div className="tc-scroll">
        {parts.map((item) => (
          <Button key={item.part} variant="quiet" block className="tc-filerow" aria-pressed={picked === item.part} data-part={item.part} onClick={() => setPicked(picked === item.part ? null : item.part)}>
            <span className="tc-dot" data-state={dot(item.status)} aria-hidden="true" />
            <span className="tc-filerow__name">{uiFormat('第 {0} 部分', [item.part])}</span>
            <span className="tc-cells" role="img" aria-label={STAGES.map(([stage, label]) => `${ui(label)} ${item.stages[stage] || '—'}`).join('，')}>
              {STAGES.map(([stage]) => <i key={stage} data-stage={stage} data-state={item.stages[stage] || 'none'}><b /></i>)}
            </span>
            <span className="tc-num">{item.kept !== undefined ? uiFormat('{0}/{1} 题', [item.kept, item.asked]) : ui(STATUS_WORD[item.status] || '等待中')}</span>
          </Button>
        ))}
        {parts.length === 0 && <p className="tc-empty">{ui('还没有开始出题。')}</p>}
      </div>
      <div className="tc-strip" aria-live="polite">
        {part ? <>
          <span className="tc-strip__title">{uiFormat('第 {0} 部分', [part.part])}</span>
          <span className="tc-strip__line">{part.kept !== undefined ? joinMeta([uiFormat('要 {0} 题，保留 {1} 题', [part.asked, part.kept]), ui(STATUS_WORD[part.status] || '')])
            : joinMeta(calls.map((call) => `${callLabel(call)}${call.endedAt ? ` ${formatDuration(Date.parse(call.endedAt) - Date.parse(call.startedAt))}` : ''}`)) || ui('还没有开始')}</span>
        </> : <span className="tc-strip__hint">{ui('选一个部分，在这里看它做了什么。')}</span>}
      </div>
    </div>
  );
}
