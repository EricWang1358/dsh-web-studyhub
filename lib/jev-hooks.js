import { createPreReview } from './jev-triage.js';
import { jevGate, readJevSettings } from './jev-settings.js';
import { jevRuntimeFor } from './jev-operations.js';

/* EXPERIMENTAL. The one-line hooks the existing pipelines call to find out whether a Jev experiment is on for this run. Each resolves
   `undefined` when it is not (the usual case: everything is off by default), so the call site just spreads the result and the pipeline
   behaves exactly as before. `seam` is `ports.jev`, the test and preview seam of lib/jev-operations.js. */

/**
 * The 出题预审 hook for `request.preReview` of lib/generation.js, or undefined unless the master switch, the experiment's switch, a key
 * and the confirmation are all in place right now. (Every Jev call still re-checks the gate, so switching it off mid-run takes effect
 * on the next card.)
 */
export async function jevPreReviewHook({ seam, language } = {}) {
  const settings = await readJevSettings();
  if (!jevGate(settings, 'preReview').ok) return undefined;
  return createPreReview({ runtime: jevRuntimeFor(seam), threshold: settings.threshold, language });
}
