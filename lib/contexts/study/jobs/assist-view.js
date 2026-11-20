import { ASSIST_MESSAGES } from './messages.js';

/** What `job.status` shows of an assistant task: which card and mode, and what it said when it ended. */
export const ASSIST_FIELDS = Object.freeze(['taskId', 'mode', 'cardId', 'message']);
const ENDED = ['complete', 'failed', 'cancelled', 'interrupted'];

/** Stable legacy id of an assistant Job, shared with `work.jobOutputs` so live output and `job.output` share one key. */
export const assistLegacyId = ({ job }) => `assist-${String(job?.taskId || 'task').replace(/[^\w.-]/g, '_').slice(0, 110)}`;

/** The presentation reader of one task; `state` is the attempt's own (the message and current stage). */
export function presentAssist({ job }, state) {
  return observed => {
    const { status, error } = observed;
    const isTerms = job.mode === 'terms';
    const repairing = isTerms && status === 'running' && state.stage === 'repair';
    const text = status === 'queued' ? ASSIST_MESSAGES.queued
      : status === 'running' ? (repairing ? ASSIST_MESSAGES.termsRepairing : isTerms ? ASSIST_MESSAGES.termsWorking : ASSIST_MESSAGES.working)
      : status === 'complete' ? state.message
      : status === 'cancelled' ? ASSIST_MESSAGES.cancelled
      : error?.message ?? '';
    const stageCode = isTerms ? `study.terms.${repairing ? 'repair' : status}` : `study.assist.${status}`;
    return {
      title: job.title,
      stage: { code: stageCode, text },
      progress: { done: 0, total: null, unit: null, percent: null, segments: [] },
      detail: {
        mode: job.mode,
        ...(job.deckId ? { deckId: job.deckId } : {}),
        cardId: job.cardId,
        ...(Array.isArray(job.terms) && job.terms.length ? { terms: job.terms } : {}),
      },
      legacy: { taskId: job.taskId, mode: job.mode, cardId: job.cardId, message: ENDED.includes(status) ? text : '' },
    };
  };
}
