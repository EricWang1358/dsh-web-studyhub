import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Icon, InlineMessage } from '../components/index.js';
import { JobUsage } from '../TokenUsage.jsx';
import { stepLabel } from '../generation-status.js';
import {
  WORK_PHASES, countsText, deckName, elapsedClock, failureCopy, isActive, jobPhase, phaseLabel, phaseName, resultHeadline, resultReasons,
} from './selection-job.js';

/* Passage supplements in the reader's learning panel, in place (the panel used to be blocked by one long call).
   A running job shows its phase, counts, clock, expected usage and a stop control; a finished one shows what was
   added, what did not pass and why, and the jump to the new questions; a stopped one says why and what is safe to retry. */

const clip = (text, size = 90) => { const clean = String(text ?? '').replace(/\s+/g, ' ').trim(); return clean.length > size ? `${clean.slice(0, size - 1)}…` : clean; };
const MARK = { done: 'success', partial: 'warning', failed: 'error', conflict: 'warning', cancelled: 'close' };
const STEP_STATUS = () => ({ starting: ui('启动中'), running: ui('进行中'), finishing: ui('收尾中'), complete: ui('已完成'), failed: ui('失败') });

/** Which of the four working phases is behind us, current, or still ahead. */
function PhaseStrip({ phase }) {
  const at = WORK_PHASES.indexOf(phase);
  return <ol className="selection-job__phases" aria-label={ui('补题的几个阶段')}>
    {WORK_PHASES.map((name, index) => <li key={name} data-state={index < at ? 'done' : index === at ? 'current' : 'next'} aria-current={index === at ? 'step' : undefined}>{phaseName(name)}</li>)}
  </ol>;
}

function Steps({ job }) {
  const steps = job.steps || [], status = STEP_STATUS();
  if (!steps.length) return null;
  return <details className="selection-job__trace">
    <summary>{uiFormat('查看执行过程 · {0} 步', [steps.length])}</summary>
    <ol>{steps.map((step) => <li key={step.id}><strong>{stepLabel(step, job)}</strong><small>{status[step.status] || step.status}</small></li>)}</ol>
  </details>;
}

function Reasons({ job }) {
  const { reasons, items } = resultReasons(job);
  if (!items.length) return null;
  return <div className="selection-job__reasons">
    <p>{ui('没通过审阅的题，原因：')}</p>
    <ul>{reasons.map((reason) => <li key={reason.code}>{reason.label}<small>{uiFormat(' · {0} 题', [reason.count])}</small></li>)}</ul>
    <details>
      <summary>{uiFormat('没通过审阅的题 · {0}', [items.length])}</summary>
      <ul>{items.map((item, index) => <li key={index}><strong>{item.prompt || ui('候选题目')}</strong>{item.note && <small className="muted">{item.note}</small>}</li>)}</ul>
    </details>
  </div>;
}

/** One supplement job. `canPractice`: the host can start a review run on exactly the new questions. */
export function SelectionJobCard({ job, now = Date.now(), canPractice = false, onCancel, onRetry, onDismiss, onPractice, onOpenDeck, onOpenCard }) {
  const phase = jobPhase(job), active = isActive(job), name = deckName(job), clock = elapsedClock(job, now);
  const added = job.publication?.cardIds?.length || 0, finished = phase === 'done' || phase === 'partial';
  const headline = finished ? resultHeadline(job)
    : phase === 'queued' ? uiFormat('补题排队中 ·「{0}」', [name])
      : phase === 'cancelling' ? uiFormat('正在停止补题 ·「{0}」', [name])
        : phase === 'cancelled' ? uiFormat('补题已停止 ·「{0}」', [name])
          : phase === 'conflict' ? uiFormat('补题待保存 ·「{0}」', [name])
            : phase === 'failed' ? uiFormat('补题没有完成 ·「{0}」', [name]) : uiFormat('正在补题 ·「{0}」', [name]);
  const copy = !active && !finished ? failureCopy(job) : null;
  return <article className={`selection-job selection-job--${phase}`} data-job-id={job.id} data-operation={job.operationId} data-phase={phase}>
    <header className="selection-job__head">
      <span className="selection-job__mark" aria-hidden="true">{active ? <span className="sh-spinner" /> : <Icon name={MARK[phase] || 'success'} size={18} />}</span>
      <strong className="selection-job__title">{headline}</strong>
    </header>
    {job.selection?.quote && <blockquote className="selection-job__passage">{clip(job.selection.quote)}</blockquote>}
    {/* Only the phase is announced; the clock ticks every second and stays out of the live region. */}
    {active && <div className="selection-job__live">
      {phase !== 'queued' && phase !== 'cancelling' && <PhaseStrip phase={phase} />}
      <p className="selection-job__stage" role="status" aria-live="polite">{phaseLabel(phase)}</p>
      {phase !== 'queued' && <p className="selection-job__meta">{countsText(job)}{clock && <> · {uiFormat('已用 {0}', [clock])}</>}</p>}
      <small className="muted">{ui('后台继续生成，关闭阅读器也不会中断；完成后进信箱。')}</small>
      <JobUsage job={job} />
      <Steps job={job} />
      {onCancel && ['queued', 'running'].includes(job.status) && <div className="selection-job__actions">
        <Button size="sm" variant="quiet" onClick={() => onCancel(job)}>{ui('停止')}</Button>
      </div>}
    </div>}
    {finished && <div className="selection-job__result" role="status">
      <p className="selection-job__meta">{countsText(job)}{clock && <> · {uiFormat('用时 {0}', [clock])}</>}</p>
      <Reasons job={job} />
      <JobUsage job={job} />
      <div className="selection-job__actions">
        {canPractice && onPractice && added > 0 && <Button size="sm" variant="primary" iconEnd="arrow-right"
          onClick={() => onPractice({ deckId: job.publication.deckId, cardIds: job.publication.cardIds })}>
          {added === 1 ? ui('马上练这 1 张') : uiFormat('马上练这 {0} 张', [added])}</Button>}
        {onOpenDeck && <Button size="sm" variant="secondary" onClick={() => onOpenDeck(job.publication?.deckId || job.deckId)}>{ui('打开题组')}</Button>}
        {onOpenCard && job.publication?.firstCardId && <Button size="sm" variant="quiet"
          onClick={() => onOpenCard({ deckId: job.publication.deckId, cardId: job.publication.firstCardId })}>{ui('查看这道题与解析')}</Button>}
        {onDismiss && <Button size="sm" variant="quiet" onClick={() => onDismiss(job)}>{ui('知道了')}</Button>}
      </div>
    </div>}
    {copy && <div className="selection-job__failure">
      {copy.kind === 'cancelled' ? <p className="selection-job__stage">{copy.title}</p>
        : <InlineMessage tone={copy.kind === 'conflict' ? 'warning' : 'error'} title={copy.title}>{copy.hint}</InlineMessage>}
      {copy.kind !== 'cancelled' && copy.kind !== 'conflict' && <small className="muted">{ui('题组没有变化，已通过审阅的题才会保存。')}</small>}
      <p className="selection-job__meta">{countsText(job)}{clock && <> · {uiFormat('用时 {0}', [clock])}</>}</p>
      <JobUsage job={job} />
      {copy.kind !== 'cancelled' && job.stage && <details className="selection-job__raw"><summary>{ui('技术详情')}</summary><code>{job.stage}</code></details>}
      <div className="selection-job__actions">
        {onRetry && <Button size="sm" variant="secondary" onClick={() => onRetry(job, copy.retry)}>{copy.retryLabel}</Button>}
        {onDismiss && <Button size="sm" variant="quiet" onClick={() => onDismiss(job)}>{ui('知道了')}</Button>}
      </div>
    </div>}
  </article>;
}

/** How many finished supplements stay open; the older ones fold away so the running one and the forms stay in view. */
export const RECENT_FINISHED = 2;

/** The supplements started from this material: running ones first, then the newest results; older results fold. */
export function SelectionJobList({ jobs = [], ...handlers }) {
  if (!jobs.length) return null;
  const running = jobs.filter(isActive), finished = jobs.filter((job) => !isActive(job));
  const card = (job) => <SelectionJobCard key={job.operationId || job.id} job={job} {...handlers} />;
  return <section className="selection-jobs" aria-label={ui('补题任务')}>
    {running.map(card)}
    {finished.slice(0, RECENT_FINISHED).map(card)}
    {finished.length > RECENT_FINISHED && <details className="selection-jobs__older">
      <summary>{uiFormat('更早的补题结果 · {0}', [finished.length - RECENT_FINISHED])}</summary>
      {finished.slice(RECENT_FINISHED).map(card)}
    </details>}
  </section>;
}
