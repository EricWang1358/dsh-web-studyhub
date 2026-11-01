import { contractOf, isHeldTask, isRunningTask } from './task-model.js';
import { taskSummary } from './task-summary.js';

/* 「发给主会话」 at a job that did not finish (the hand-off plan N8, N9, N11: 'job.failed'): when it is offered and what it carries. One rule for the card on a
   page (ui/tasks/CompactJobCard.jsx), the 任务 console (ui/tasks/RunLine.jsx) and a conversion's failure detail (ui/PdfConvertJob.jsx). */

/** The ends of a job the hand-off is for: it failed, was interrupted or was stopped. */
export const FAILED_HAND_OFF_STATES = Object.freeze(['failed', 'interrupted', 'cancelled']);

/** What a conversion's failure says: its summary, the exit code and the converter's last lines (the text 复制诊断信息 copies). */
export const failureText = (failure) => (failure ? [failure.summary, ...(Number.isInteger(failure.exitCode) ? [`exit code ${failure.exitCode}`] : []),
  ...(Array.isArray(failure.lines) ? failure.lines : [])].filter(Boolean).join('\n') : '');

/**
 * The input of 'job.failed' for `job`, or null when the hand-off is not offered: a job still running (or paused), one that finished, one another run
 * continued (that run says where things stand), one put away in 已归档, one leaving the list. `line`: what the card says about it.
 */
export function failedHandOffInput(job, { line = '' } = {}) {
  if (!job || job.leaving || job.archived) return null;
  const contract = contractOf(job);
  if (isHeldTask(job) || isRunningTask(job) || !FAILED_HAND_OFF_STATES.includes(contract.status) || contract.continuedBy || job.continuedBy) return null;
  const error = [contract.error?.message, failureText(job.failure)].filter(Boolean).filter((text, index, all) => all.indexOf(text) === index).join('\n');
  const sources = contract.result?.refs?.filter((ref) => ref.kind === 'source').map((ref) => ref.id) || [];
  return { jobId: contract.jobId, kind: contract.kind, title: taskSummary(job).title, status: contract.status, line, error,
    sourceIds: [...new Set([...(job.sourceIds || []), ...sources])], draftId: contract.detail?.draftId || job.draftId || '', converter: job.converter || '' };
}

/** The Tooltip sentence of the hand-off at a job. */
export const FAILED_HAND_OFF_WHAT = '让主会话先查清原因，再换条路做完；接着做之前会先问你';
