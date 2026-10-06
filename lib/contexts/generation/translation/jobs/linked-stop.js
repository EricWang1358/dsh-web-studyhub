import { TRANSLATION_STOPPING, TRANSLATION_STOP_MESSAGES } from './messages.js';

/** The executor's own controller (it also aborts it for its time budget), linked to the Attempt's signal. A stop from the runtime is marked as requested on
 * the card and on the job table's record, as every other path that stops a translation does, and says what the learner has always been told. */
export function linkedStop(signal, view, record) {
  const controller = new AbortController();
  const stop = () => {
    const at = new Date().toISOString();
    view.cancelRequestedAt ||= at;
    if (record) record.cancelRequestedAt ||= at;
    const user = signal.reason?.code === 'user-cancel';
    if (user) view.stage = TRANSLATION_STOPPING;
    controller.abort(Object.assign(new Error(TRANSLATION_STOP_MESSAGES[user ? 'user-cancel' : 'unloaded']), { code: signal.reason?.code }));
  };
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  return controller;
}
