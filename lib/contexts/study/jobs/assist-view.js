import { ASSIST_MESSAGES } from './messages.js';

/** What `job.status` shows of an assistant task: which card and mode, and what it said when it ended. */
export const ASSIST_FIELDS = Object.freeze(['taskId', 'mode', 'cardId', 'message']);
const ENDED = ['complete', 'failed', 'cancelled', 'interrupted'];

/** The presentation reader of one task; `state` is the attempt's own (the message the save answered with). */
export function presentAssist({ job }, state) {
  return observed => {
    const { status, error } = observed;
    const text = status === 'queued' ? ASSIST_MESSAGES.queued : status === 'running' ? ASSIST_MESSAGES.working
      : status === 'complete' ? state.message : status === 'cancelled' ? ASSIST_MESSAGES.cancelled : error?.message ?? '';
    return {
      title: job.title,
      stage: { code: `study.assist.${status}`, text },
      progress: { done: 0, total: null, unit: null, percent: null, segments: [] },
      legacy: { taskId: job.taskId, mode: job.mode, cardId: job.cardId, message: ENDED.includes(status) ? text : '' },
    };
  };
}
