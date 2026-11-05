import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatDateTime, joinMeta } from '../format.js';
import { runnerLabel } from './call-model.js';
import { batchSummary } from './coach-batch.js';

/* 实时输出 of a day of 为你定制. Its variants are written by the light model, called directly: no DSH sub-agent, so there is no session to open and no output kept
   to read (job.output knows no call of a day). In the place where other jobs offer their transcript it says so, and shows what there is: the batch picked on
   the timeline or under 正在进行 (else the newest), the questions it was for, what it wrote and kept, and its tokens. */
export default function CoachOutputNote({ contract, call }) {
  const batches = contract.detail.batches || [];
  const batch = batches.find((item) => item.id === call?.callId) || batches.at(-1) || null;
  return (
    <div className="tc-output" data-mode="none" data-coach-output>
      <div className="tc-output__head">
        <div className="tc-output__title"><strong>{ui('没有子代理原文')}</strong><span>{call ? runnerLabel(call) : ui('直接模型调用')}</span></div>
      </div>
      {batch && <p className="tc-output__facts">{joinMeta([uiFormat('第 {0} 批', [batches.indexOf(batch) + 1]), formatDateTime(batch.startedAt, 'time'), batchSummary(batch)])}</p>}
      <p className="tc-empty tc-output__quiet">{ui('变式由轻量模型直接写，不经过子代理，所以没有原文可以打开。每一批为几道题写、写了和留下几道、用了多少 tok，都在这里和「批次」里。')}</p>
      <div className="tc-output__foot" />
    </div>
  );
}
