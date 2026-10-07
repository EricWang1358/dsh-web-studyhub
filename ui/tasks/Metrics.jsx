import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Tooltip } from '../components/index.js';
import { stateLabel } from './task-summary.js';
import { progressHint, taskFacts, taskSegments } from './task-facts.js';

/* The overview of a task: its overall progress (a percent and the stage segments of the bar) and the four facts beside it. The label of the percent and of the question tile carry what they count, on hover and
   on keyboard focus (the project's Tooltip, never a title attribute): a top-up counts only its own work, a run with a plan counts sections (docs/job-contract.md). */

/** Stage-segmented progress: one segment per stage of the job, as wide as its share of the work, filled by what is done. */
function SegmentedProgress({ segments, label }) {
  return (
    <div className="tc-segments" role="img" aria-label={label}>
      {segments.map((segment) => (
        <span key={segment.stage} className="tc-segment" data-stage={segment.stage} style={{ flexGrow: Math.max(segment.total, 1) }}>
          <i style={{ transform: `scaleX(${segment.total > 0 ? Math.min(1, segment.done / segment.total) : 0})` }} />
        </span>
      ))}
    </div>
  );
}

/** A label of the overview; with a hint it is a focusable anchor of the explanation. */
function Label({ hint, children }) {
  return hint
    ? <Tooltip layer content={hint} anchorClassName="tc-metric__hint-anchor"><span className="tc-metric__k" data-metric-hint tabIndex={0}>{children}</span></Tooltip>
    : <span className="tc-metric__k">{children}</span>;
}

export default function Metrics({ job, summary, now }) {
  const segments = taskSegments(job), facts = taskFacts(job, now), hints = progressHint(job);
  const label = segments.map((segment) => uiFormat('{0} {1}/{2}', [segment.label, segment.done, segment.total])).join('，');
  return (
    <section className="tc-metrics" aria-label={ui('概览')}>
      <div className="tc-metric tc-metric--progress">
        <div className="tc-metric__top">
          <Label hint={hints.percent}>{summary.kind === 'coach'
            ? uiFormat('本日记录 · {0}', [summary.state === 'done' ? ui('暂无进行中的批次') : stateLabel(summary.state)])
            : uiFormat('总进度 · {0}', [stateLabel(summary.state)])}</Label>
          <strong className="tc-metric__pct">{summary.percent === null ? '—' : `${summary.percent}%`}</strong>
        </div>
        <SegmentedProgress segments={segments} label={label || ui('总进度')} />
      </div>
      {facts.map((fact) => (
        <div className="tc-metric" key={fact.key}>
          <Label hint={fact.hint}>{fact.label}</Label>
          <span className="tc-metric__v">{fact.value}</span>
          {fact.note !== undefined && (fact.note
            ? <Tooltip layer content={fact.note} anchorClassName="tc-metric__note-anchor"><span className="tc-metric__note" data-metric-note tabIndex={0}>{fact.note}</span></Tooltip>
            : <span className="tc-metric__note" data-metric-note />)}
        </div>
      ))}
    </section>
  );
}
