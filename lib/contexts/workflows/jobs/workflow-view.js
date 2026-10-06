import { WORKFLOW_MESSAGES } from './messages.js';

/** What `job.status` shows of a unit of the learning workflow: where it works and, once it ended, why. */
export const WORKFLOW_FIELDS = Object.freeze(['sessionId', 'stepId', 'mode', 'message']);

const ENDED = ['complete', 'failed', 'cancelled', 'interrupted'];

/** The presentation reader of one unit; `working` is the stage text while it runs. */
export function presentWorkflow({ kind, job }, working) {
  return observed => {
    const { status, error } = observed;
    const text = status === 'queued' ? WORKFLOW_MESSAGES.queued : status === 'running' ? working
      : status === 'failed' ? error?.message ?? '' : status === 'cancelled' ? WORKFLOW_MESSAGES.cancelled : '';
    return {
      title: job.title,
      stage: { code: `workflow.${kind}.${status}`, text },
      progress: { done: 0, total: null, unit: null, percent: null, segments: [] },
      legacy: { sessionId: job.sessionId, stepId: job.stepId ?? null, mode: job.mode ?? null, message: ENDED.includes(status) ? text : '' },
    };
  };
}

/** The recorded failure of a unit whose Job was stopped (a stop is told apart by why it was asked), or null when it was not stopped. */
export function stopMessage(signal, timeout) {
  if (!signal.aborted) return null;
  const why = signal.reason?.code;
  return why === 'execution-timeout' ? timeout : why === 'user-cancel' ? WORKFLOW_MESSAGES.cancelled : WORKFLOW_MESSAGES.ended;
}
