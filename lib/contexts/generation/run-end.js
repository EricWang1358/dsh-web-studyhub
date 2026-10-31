/* How a generation job ended when something was thrown: the one decision of the executor's catch. Pure, no I/O: the executor gathers the facts, does what this says, and words it.
   Legacy path: this is the job's status. On the unified runtime the same executor reports it and the kernel decides the Job's status (jobs/generation-view.js). */
import { classifyFailure, isPermanentFailure } from '../../generation-failure.js';

const BUDGET = 'GENERATION_BUDGET';

/**
 * `status`: 'cancelled' (the learner asked) | 'interrupted' (a run that had started lost its host: its draft is left as it is) | 'failed'.
 * `stop`: what a run that ended this way writes on its draft ({ reason, extra, roundReason }), or null. `retryAfterStop`: it can go on with 接着做 afterwards.
 * `readAsked`: a top-up of one round reads the draft for the number of questions it was asked. `offerContinue`: a plain run looks whether its draft can be continued.
 * `publishWhatPassed`: a supplement at its time limit publishes the questions that passed.
 */
export function endOfRun({ error, aborted, abortCode, cancelRequested, planStarted, hasSpec, stopped, hasDraft, hasPlan, covering, publishTarget, retryable, savedCount }) {
  const cancelled = aborted && cancelRequested;
  const interrupted = planStarted && aborted && !cancelRequested && abortCode !== BUDGET;
  return {
    status: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'failed',
    stop: planStarted && hasSpec && !stopped && !interrupted ? stopOf(error, cancelled) : null,
    retryAfterStop: !cancelled && hasDraft,
    readAsked: !hasPlan && covering && hasDraft,
    offerContinue: !hasPlan && !publishTarget && hasDraft && !retryable,
    publishWhatPassed: publishTarget && abortCode === BUDGET && !cancelRequested && hasDraft && savedCount > 0,
  };
}

function stopOf(error, cancelled) {
  if (cancelled) return { reason: 'learner', extra: {}, roundReason: 'cancelled' };
  const message = String(error?.message || error), code = classifyFailure(error).code;
  return { reason: isPermanentFailure(error) ? 'refused' : 'round-failed', extra: { ...(code !== 'unknown' ? { code } : {}), detail: message.slice(0, 200) }, roundReason: message.slice(0, 160) };
}
