import { normalizeGenerationPerformance, requestKinds } from '../generation-settings.js';
import { ONE_PASS_KINDS, ONE_PASS_LIMITS } from './limits.js';

/* Which runs one pass writes. The setting (`performance.strategy`, lib/generation-settings.js) chooses it, and one pass serves only what it can:
   a coverage run (its sections and quotas come from the plan: `assignments`) whose every kind is one ONE_PASS_KINDS writes. Anything else (another kind,
   a case paper, a plain run by a number of questions) is written by the staged pipeline, whatever the setting says. */

/** Whether the kinds of a request are all kinds one pass writes (and the setting asks for one pass). */
export function writesInOnePass(request) {
  if (normalizeGenerationPerformance(request?.performance).strategy !== 'one-pass' || request?.kind === 'case') return false;
  return requestKinds(request).every(kind => ONE_PASS_KINDS.includes(kind));
}

/** Whether this run is written in one pass: one-pass kinds and a coverage plan's assignments. */
export const runsInOnePass = request => writesInOnePass(request) && Array.isArray(request.assignments) && request.assignments.length > 0;

/** The questions a one-pass run of `goal` planned questions is expected to keep: { low, high }. The plan is the upper end; some cards are dropped by the checks and the review. */
export function questionRange(goal) {
  const high = Math.max(0, Math.floor(Number(goal) || 0));
  return { low: high ? Math.max(1, Math.floor(high * ONE_PASS_LIMITS.forecastKeepShare)) : 0, high };
}
