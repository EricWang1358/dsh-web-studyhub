import { jobContract } from '../../../job-contract.js';
import { STOP_MESSAGES } from './messages.js';

/** The learner's live settings of a run, as the runtime's `set` action reads and applies them (the pause switch is not one of them). */
export function controlAdapter(control) {
  const settings = () => Object.entries(control.spec).filter(([key]) => key !== 'paused' && control.values[key] !== undefined)
    .map(([key, rule]) => ({ key, ...rule, value: control.values[key] }));
  return { settings, patch: patch => control.patch(patch), close: () => control.close() };
}

/** The executor's own controller (it also aborts it for its time budget), linked to the Attempt's signal. A stop from the runtime is
 * marked as requested on the card and on the job table's record, exactly like every other path that stops a generation job. */
export function linkedController(signal, view, record) {
  const controller = new AbortController();
  const stop = () => {
    const at = new Date().toISOString();
    view.cancelRequestedAt ||= at;
    if (record) record.cancelRequestedAt ||= at;
    const user = signal.reason?.code === 'user-cancel';
    controller.abort(Object.assign(new Error(STOP_MESSAGES[user ? 'user-cancel' : 'unloaded']), { code: signal.reason?.code }));
  };
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  return controller;
}

/** What the executor left on its card, as the runtime's outcome: the result of a finished run, the card's own words for anything else. */
export function outcomeOf(view) {
  if (view.status === 'complete') {
    const { result } = jobContract(view);
    return { refs: result.refs, completeness: result.completeness };
  }
  throw Object.assign(new Error(view.stage), view.errorCode ? { code: view.errorCode } : {});
}
