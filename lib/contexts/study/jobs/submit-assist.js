import { abortable } from '../../../host-capabilities.js';
import { ASSIST_MESSAGES } from './messages.js';

/** What the runtime refuses a request with, in the learner's words (any other refusal keeps its own message). */
const REFUSALS = Object.freeze({ 'executor-unavailable': ASSIST_MESSAGES.unavailable, 'scope-unloaded': ASSIST_MESSAGES.unavailable });

const canAdmit = executor => {
  if (typeof executor?.assertAvailable !== 'function') return false;
  try { executor.assertAvailable(); return true; }
  catch { return false; }
};

const hasModelHost = host => {
  if (!host || typeof host !== 'object') return false;
  try {
    const route = typeof host.route === 'function' ? host.route() : host.route;
    return Boolean(route || host.webGemini);
  } catch {
    return false;
  }
};

/**
 * How one request is carried out as a Job of the study context (`assist.job`):
 * - For `mode: 'terms'` (background term-filling), runs on the unified job runtime by default whenever a live `jobExecutor` and `jobModelHost` can admit it
 *   (falling back smoothly to in-process execution on preview/test hosts without a live executor).
 * - For other assist modes, gated behind `runtime.pilot.assist === true` as before.
 * As before, a stopped task ends at once for the learner; the Job itself settles when its request and its host sub-agent are really done.
 */
export function assistExecutor(service, { mode } = {}) {
  const options = service.modelOptions;
  if (typeof service.runtime?.invoke !== 'function') return null;
  const useRuntime = options?.runtimePilot?.assist === true
    || (mode === 'terms' && canAdmit(options?.jobExecutor) && hasModelHost(options?.jobModelHost));
  if (!useRuntime) return null;
  return async ({ input, work, controller }) => {
    const running = service.runtime.invoke('study.v1', 'assist.job', { input, work, controller }, options);
    running.catch(() => {});
    let ended;
    try { ended = await abortable(running, controller.signal); }
    catch (error) { throw controller.signal.aborted ? error : new Error(REFUSALS[error.code] ?? error.message); }
    if (ended.status !== 'complete') throw new Error(ended.error?.message || ended.message);
    return {
      message: ended.message,
      ...(ended.outcome ? { outcome: ended.outcome } : {}),
      ...(ended.cardId ? { cardId: ended.cardId } : {}),
      ...(ended.jobId ? { jobId: ended.jobId } : {}),
      ...(ended.childId ? { childId: ended.childId } : {}),
      ...(ended.executionMode ? { executionMode: ended.executionMode } : {}),
    };
  };
}
