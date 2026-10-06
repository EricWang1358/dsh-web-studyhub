import { abortable } from '../../../host-capabilities.js';
import { ASSIST_MESSAGES } from './messages.js';

/** What the runtime refuses a request with, in the learner's words (any other refusal keeps its own message). */
const REFUSALS = Object.freeze({ 'executor-unavailable': ASSIST_MESSAGES.unavailable, 'scope-unloaded': ASSIST_MESSAGES.unavailable });

/**
 * How one request is carried out when `runtime.pilot.assist` is on (the one place that reads it): as a Job of the study context, through the internal
 * operation `assist.job`. Null when it is off: the assistant then runs the request in process, as before. A request the runtime refuses fails the
 * task with the refusal; the host's session, owner and capability checks are the ones the service was built with. As before, a stopped task ends at once
 * for the learner; the Job itself settles when its request and its host teacher are really done.
 */
export function assistExecutor(service) {
  const options = service.modelOptions;
  if (options?.runtimePilot?.assist !== true || typeof service.runtime?.invoke !== 'function') return null;
  return async ({ input, work, controller }) => {
    const running = service.runtime.invoke('study.v1', 'assist.job', { input, work, controller }, options);
    running.catch(() => {});
    let ended;
    try { ended = await abortable(running, controller.signal); }
    catch (error) { throw controller.signal.aborted ? error : new Error(REFUSALS[error.code] ?? error.message); }
    if (ended.status !== 'complete') throw new Error(ended.error?.message || ended.message);
    return { message: ended.message };
  };
}
