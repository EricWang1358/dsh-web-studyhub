import React from 'react';
import { ui } from '../i18n.js';
import { Badge, Button, Tooltip } from '../components/index.js';
import { useApp } from '../app/app-context.js';
import { contractOf } from './task-model.js';
import { parallelOf, parallelButton, askTip, blockedTip, blockedLine, badgeText, badgeTip, queueTip, queueLine, requeuedLine, requeuedTip } from './task-parallel.js';

/* 要求并行 in the 任务 console (lib/job-parallel.js): the header button (the form it takes is the contract's: ask, or blocked with the reason), the badge of a job that runs beside the queue, and the
   strip under the facts that says why a job waits, that it was sent back after a model error, or why it cannot run in parallel. Each one explains itself on hover and on keyboard focus (a tooltip in
   the top layer); a refusal and a job sent back also stay on the screen as a line, so the words are never only in a tooltip. */

const Explain = ({ lead, more }) => <><span>{lead}</span>{more && <span className="tc-tip__more">{more}</span>}</>;

/** 要求并行 for a queued job: a button; or, when another job writes the same thing, a button that cannot be pressed and says which job and why. Nothing for a job that cannot have it. */
export function ParallelButton({ task }) {
  const { core } = useApp();
  const form = parallelButton(task), { action, requeued } = parallelOf(task);
  if (!form) return null;
  if (form === 'blocked') {
    return (
      <Tooltip layer placement="bottom-end" content={<Explain {...blockedTip(action.reason)} />}>
        <Button size="sm" aria-disabled="true" data-parallel="blocked">{ui('要求并行')}</Button>
      </Tooltip>
    );
  }
  return (
    <Tooltip layer placement="bottom-end" content={<Explain {...askTip(requeued)} />}>
      <Button size="sm" disabled={core.busy} data-parallel="ask"
        onClick={() => core.act('job.parallel', { jobId: contractOf(task).jobId }, () => core.notify?.(ui('已要求并行：这个任务现在就开始。')))}>{ui('要求并行')}</Button>
    </Tooltip>
  );
}

/** 「并行中（手动）」: a quiet badge on a job that runs beside the queue because the learner asked. */
export function ParallelBadge({ task }) {
  if (!parallelOf(task).parallel) return null;
  return (
    <Tooltip layer placement="bottom-end" content={<Explain {...badgeTip()} />}>
      <Badge size="sm" tone="info" tabIndex={0} data-parallel-badge>{badgeText()}</Badge>
    </Tooltip>
  );
}

/** Under the facts of a queued job: why it waits (and behind which job), or that a model error sent it back, and, when it cannot run in parallel, which job is in the way. */
export default function QueueNote({ task }) {
  const { action, requeued, queue } = parallelOf(task);
  if (contractOf(task).status !== 'queued') return null;
  const blocked = action && !action.available && action.reason?.code === 'target-busy' ? action.reason : null;
  if (!requeued && !queue && !blocked) return null;
  return (
    <div className="tc-queue" role="status" aria-label={ui('排队说明')} data-queue-state={requeued ? 'requeued' : 'waiting'}>
      <Tooltip layer content={<Explain {...(requeued ? requeuedTip(requeued) : queueTip(queue))} />} anchorClassName="tc-queue__anchor">
        <span className="tc-queue__line" tabIndex={0} data-queue-explain>{requeued ? requeuedLine(requeued) : queueLine(queue)}</span>
      </Tooltip>
      {blocked && <span className="tc-queue__blocked" data-parallel-blocked>{blockedLine(blocked)}</span>}
    </div>
  );
}
