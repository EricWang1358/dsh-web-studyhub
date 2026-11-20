import { normalizeGenerationPerformance, normalizeGenerationSettings } from '../../../generation-settings.js';
import { lightModelOf } from '../../../job-model.js';
import { EFFORT_PREFERENCES, FOLLOW_EFFORT } from '../../../model-effort.js';
import { EFFORT_STAGES, effortKey } from '../../../stage-effort.js';

/* The gateway policy of a parallel call: its purpose (the console's lane: inventory, outline, write, review, repair, plan), the learner's own model, direct,
   at the reasoning level the learner set for its stage (Settings > generation: planning, writing, review, repair; lib/stage-effort.js). The level is only named here; the
   one mapping onto the levels a model offers is lib/model-effort.js'. */

const LIGHT_ROUTE = Symbol('book.lightRoute');
const EFFORT_RANK = Object.freeze({ lowest: 0, low: 1, medium: 2, high: 3, highest: 4 });
/** Downward-only cap: preserves weaker levels (e.g. 'lowest') and caps stronger/follow/default levels to `cap`. */
export const capEffortDownward = (wanted, cap = 'low') =>
  (!Object.hasOwn(EFFORT_RANK, cap) ? (wanted ?? cap) : Object.hasOwn(EFFORT_RANK, wanted) && EFFORT_RANK[wanted] <= EFFORT_RANK[cap] ? wanted : cap);

/** The level of each stage from the saved generation settings: a relative preference, else `follow` (the session's own level). */
export function effortsOf(settings) {
  const performance = normalizeGenerationPerformance(settings?.generation);
  const levelOf = wanted => (EFFORT_PREFERENCES.includes(wanted) ? wanted : FOLLOW_EFFORT);
  const efforts = Object.fromEntries(EFFORT_STAGES.map(stage => [stage, levelOf(performance[effortKey(stage)])]));
  const lightRoute = lightModelOf(settings?.generation?.lightModel);
  if (lightRoute) Object.defineProperty(efforts, LIGHT_ROUTE, { value: lightRoute, enumerable: false });
  return efforts;
}

/** Which stage's level a purpose is asked at. */
const STAGE_OF = Object.freeze({
  inventory: 'planning', outline: 'planning', plan: 'planning', place: 'planning', write: 'writing', cards: 'writing', confusables: 'writing', exam: 'writing', kit: 'writing',
  review: 'review', repair: 'repair',
});
/** Mechanical extraction/placement and Book review (matching write/repair so thinking-key cache hits on unit pages) cap downward to 'low'. */
const LOW_CAPPED = Object.freeze(new Set(['inventory', 'plan', 'place', 'review']));
/** Prefix-disjoint extraction/post-pass stages that may route to `generation.lightModel` when configured. */
export const LIGHT_MODEL_PURPOSES = Object.freeze(new Set(['inventory', 'plan', 'place', 'cards', 'card', 'confusables', 'confusable', 'exam', 'paper']));

/** Configured `generation.lightModel` route for an eligible purpose, from `effortsOf(settings)` or raw `settings`; null otherwise. */
export function lightRouteOf(purpose, source) {
  if (!LIGHT_MODEL_PURPOSES.has(purpose) || !source) return null;
  if (source[LIGHT_ROUTE]) return source[LIGHT_ROUTE];
  return lightModelOf(source?.generation?.lightModel ?? source?.lightModel);
}

export const policyOf = (purpose, efforts) => {
  const raw = efforts?.[STAGE_OF[purpose]] ?? FOLLOW_EFFORT;
  const requestedEffort = LOW_CAPPED.has(purpose) ? capEffortDownward(raw, 'low') : raw;
  return Object.freeze({ purpose, feature: 'book', requestedEffort, executionMode: 'direct', budget: null });
};

/** Single-call timeout (seconds) configured for outline and review-book builds (`settings.generation.bookCallTimeoutMinutes`); `0` means no wall-clock limit. */
export function bookCallTimeoutSeconds(settings) {
  const minutes = normalizeGenerationSettings(settings?.generation).bookCallTimeoutMinutes;
  return minutes > 0 ? minutes * 60 : 0;
}

export const withCallTimeout = (policy, callTimeoutSeconds) => (callTimeoutSeconds > 0
  ? Object.freeze({ ...policy, budget: { ...(policy.budget || {}), timeoutMs: callTimeoutSeconds * 1000 } })
  : policy);
