import { createPreReview } from './jev-triage.js';
import { createReviewHook } from './jev-review.js';
import { organizeWithJev } from './jev-course-suggest.js';
import { jevGate, readJevSettings } from './jev-settings.js';
import { jevRuntimeFor } from './jev-operations.js';

/* EXPERIMENTAL. The one-line hooks the existing pipelines call to find out whether a Jev experiment is on for this run. Each resolves
   `undefined` when it is not (the usual case: everything is off by default), so the call site just spreads the result and the pipeline
   behaves exactly as before. `seam` is `ports.jev`, the test and preview seam of lib/jev-operations.js. */

/**
 * The 出题预审 hook for `request.preReview` of lib/generation.js, or undefined unless experimental features are shown (`experimental`, the
 * "Show experimental features" switch), the master switch, the experiment's switch, a key and the confirmation are all in place right now.
 * (Every Jev call still re-checks the gate, so switching it off mid-run takes effect on the next card.)
 */
export async function jevPreReviewHook({ seam, language, experimental } = {}) {
  if (experimental !== true) return undefined;
  const settings = await readJevSettings();
  if (!jevGate(settings, 'preReview').ok) return undefined;
  return createPreReview({ runtime: jevRuntimeFor(seam), threshold: settings.threshold, language });
}

/**
 * The 请 AI 建议 replacement hook of `source.organize.suggest` (site `courseOrganize`), or undefined unless experimental features are shown and
 * the learner switched the site on. `hook({ state, sources, fallback, signal })` resolves { proposals, jev }; `fallback(sources)` is the
 * unchanged model path. A switch that is on but cannot work yet falls back at once and says why.
 */
export async function jevOrganizeHook({ seam, language, experimental } = {}) {
  if (experimental !== true) return undefined;
  const settings = await readJevSettings(), gate = jevGate(settings, 'courseOrganize');
  if (!gate.ok && (gate.reason === 'off' || gate.reason === 'feature-off')) return undefined;
  const runtime = jevRuntimeFor(seam);
  return ({ state, sources, fallback, signal }) => organizeWithJev({ runtime, state, sources, threshold: settings.threshold, language, signal, fallback });
}

/**
 * The 独立复审 replacement hook for `request.jevReview` of lib/generation.js (site `cardReview`), or undefined unless experimental features
 * are shown and the learner switched this site on (master switch and the site's own). With the switch off the pipeline is not touched at all.
 * A switch that is on but cannot work yet (no key, no confirmation) still returns the hook: it falls back to the model review at once and
 * says why, once, in the draft.
 */
export async function jevReviewHook({ seam, language, experimental } = {}) {
  if (experimental !== true) return undefined;
  const settings = await readJevSettings(), gate = jevGate(settings, 'cardReview');
  if (!gate.ok && (gate.reason === 'off' || gate.reason === 'feature-off')) return undefined;
  return createReviewHook({ runtime: jevRuntimeFor(seam), threshold: settings.threshold, language });
}
