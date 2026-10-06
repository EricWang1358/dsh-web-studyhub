import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, IconButton, Tooltip } from '../components/index.js';
import { formatDuration, joinMeta } from '../format.js';
import { callLabel } from './call-model.js';
import { partOpener } from './task-actions.js';
import { useApp } from '../app/app-context.js';
import GenerationTrace from '../GenerationTrace.jsx';
import { coverageInRange } from '../../lib/coverage.js';
import { useCoverage } from '../coverage/use-coverage.js';
import { reasonWord, uncoveredInRange } from '../coverage/copy.js';
import { PartCoverage } from '../coverage/PartCoverage.jsx';
import RunRounds from './RunRounds.jsx';

/* 批次: the batches a question run was split into, each with the state of its three stages (writing, review, repair) and what it kept once the run has
   reported. A selected part shows, in a strip of fixed height at the bottom, the calls it made. (The questions themselves live in the draft; the job does
   not record which part wrote which.) What a part covers (its range, its sources) is recorded when the run plans its parts (lib/part-plan.js); 在资料中查看 opens the
   reader on the first of them through the app's own handler (task-actions.js partOpener, the one 打开结果 uses). */

const STAGES = [['author', '出题'], ['review', '审阅'], ['repair', '修复']];
const STATUS_WORD = { passed: '全部通过', partial: '只保留了部分', failed: '没有出题', running: '进行中', working: '进行中', waiting: '等待中' };
const dot = (status) => (status === 'passed' ? 'done' : status === 'partial' ? 'partial' : status === 'failed' ? 'fail' : status === 'waiting' ? 'queued' : 'run');
/* Why a part kept fewer questions than it was asked for, from the reason codes the run's report carries (lib/generation-report.js failureReason); the words are the shared ones (ui/coverage/copy.js). */
const shortfallLine = (part) => {
  if (part.kept === undefined || !(part.kept < part.asked) || !part.reasons?.length) return '';
  return uiFormat('原因：{0}', [part.reasons.map((code) => reasonWord(code)).join(ui('；'))]);
};

/** One line of the strip, cut with an ellipsis; what is cut is the tooltip (a title on a plain element never shows on touch or keyboard focus). */
function Clipped({ className, text }) {
  if (!text) return <span className={className} />;
  return <Tooltip layer anchorClassName={`tc-strip__clip ${className}`} content={text}><span tabIndex={0} className="tc-strip__cut">{text}</span></Tooltip>;
}

export default function GenerationParts({ contract, task }) {
  const app = useApp(), { host } = app;
  const parts = contract.detail.partList || [], [picked, setPicked] = useState(parts.length === 1 ? 1 : null);
  const part = picked !== null ? parts.find((item) => item.part === picked) : null;
  const calls = part ? contract.calls.filter((call) => call.part === part.part) : [];
  const opener = part ? partOpener(part, app) : null;
  // 覆盖: what each part's range of the material has, from the draft this run writes (a record whose draft is gone shows none).
  const covered = useCoverage(contract.detail.draftId ? { draftId: contract.detail.draftId } : null, { version: `${app.data?.revision}:${task?.savedCount ?? ''}` });
  const coverage = covered.view?.coverage || null, here = (item) => (coverage && item?.ranges?.length ? coverageInRange(coverage, item.ranges) : null);
  const inPart = part ? here(part) : null;
  // The rounds of a coverage run come first; the parts below are those of the round that is being made (or was made last).
  const run = contract.detail.run, draft = run ? (app.data?.drafts || []).find((item) => item.id === contract.detail.draftId) : null;
  const why = part ? joinMeta([inPart?.leaves ? uncoveredInRange({ ...inPart, sections: [...inPart.sections, ...inPart.borrowed] }, { recorded: coverage.recorded }) : '', opener && (!opener.available ? opener.reason : opener.count > 1 ? uiFormat('共 {0} 份资料，先打开第一份', [opener.count]) : ''), shortfallLine(part)]) : '';
  return (
    <div className="tc-files">
      <div className="tc-scroll">
        {run && <RunRounds run={run} draft={draft} coverage={coverage} />}
        {run && parts.length > 0 && <p className="tc-rounds__head tc-rounds__head--parts">{uiFormat('第 {0} 轮的批次', [run.running ?? run.round])}</p>}
        {parts.map((item) => {
          const row = item.sourceIds?.length ? partOpener(item, app) : null;
          return (
            <div key={item.part} className="tc-partrow">
              <Button variant="quiet" block className="tc-filerow" aria-pressed={picked === item.part} data-part={item.part} title={item.range || undefined} onClick={() => setPicked(picked === item.part ? null : item.part)}>
                <span className="tc-dot" data-state={dot(item.status)} aria-hidden="true" />
                <span className="tc-filerow__name">{uiFormat('第 {0} 批', [item.part])}{item.range && <span className="tc-filerow__text tc-filerow__range">{item.range}</span>}
                  <PartCoverage range={here(item)} units={coverage?.units} recorded={coverage?.recorded} /></span>
                <span className="tc-cells" role="img" aria-label={STAGES.map(([stage, label]) => `${ui(label)} ${item.stages[stage] || '—'}`).join('，')}>
                  {STAGES.map(([stage]) => <i key={stage} data-stage={stage} data-state={item.stages[stage] || 'none'}><b /></i>)}
                </span>
                <span className="tc-num">{item.kept !== undefined ? uiFormat('{0}/{1} 题', [item.kept, item.asked]) : ui(STATUS_WORD[item.status] || '等待中')}</span>
              </Button>
              {row && <IconButton icon="external" size="sm" className="tc-partrow__open" data-part-open={item.part} label={uiFormat('在资料中查看第 {0} 批', [item.part])}
                title={row.available ? undefined : row.reason} disabled={!row.available} onClick={row.run} />}
            </div>
          );
        })}
        {parts.length === 0 && <p className="tc-empty">{ui('还没有开始出题。')}</p>}
        {/* The run's process (every step with its tokens and waits) and its technical details, open: the card on the home no longer carries them. */}
        {task && <GenerationTrace job={task} openAgent={host?.openAgent} defaultOpen />}
      </div>
      <div className="tc-strip tc-strip--parts" aria-live="polite">
        {part ? <>
          <span className="tc-strip__title">{uiFormat('第 {0} 批', [part.part])}</span>
          <Clipped className="tc-strip__line" text={joinMeta([part.range, part.kept !== undefined ? joinMeta([uiFormat('要 {0} 题，保留 {1} 题', [part.asked, part.kept]), ui(STATUS_WORD[part.status] || '')])
            : joinMeta(calls.map((call) => `${callLabel(call)}${call.endedAt ? ` ${formatDuration(Date.parse(call.endedAt) - Date.parse(call.startedAt))}` : ''}`)) || ui('还没有开始')])} />
          {opener && <Button size="sm" data-part-view={part.part} disabled={!opener.available} onClick={opener.run}>{opener.label}</Button>}
          <Clipped className="tc-strip__why" text={why} />
        </> : <span className="tc-strip__hint">{ui('选一个批次，在这里看它做了什么。')}</span>}
      </div>
    </div>
  );
}
