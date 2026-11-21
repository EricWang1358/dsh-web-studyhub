import { normalizeGenerationPerformance, requestKinds } from '../generation-settings.js';
import { ONE_PASS_KINDS, ONE_PASS_LIMITS } from './limits.js';

/* Which runs one pass writes. The setting (`performance.strategy`, lib/generation-settings.js) chooses it, and one pass serves only what it can:
   a coverage run (its sections and quotas come from the plan: `assignments`) whose every kind is one ONE_PASS_KINDS writes. Anything else (another kind,
   a case paper, a plain run by a number of questions) is written by the staged pipeline, whatever the setting says. */

/** Whether one pass can write the kinds of a request, whatever the setting says: every kind one of ONE_PASS_KINDS, and not a case paper. */
export const servesKinds = request => request?.kind !== 'case' && requestKinds(request).every(kind => ONE_PASS_KINDS.includes(kind));

/** Whether the kinds of a request are all kinds one pass writes (and the setting asks for one pass). */
export const writesInOnePass = request => normalizeGenerationPerformance(request?.performance).strategy === 'one-pass' && servesKinds(request);

/** Whether this run is written in one pass: one-pass kinds and a coverage plan's assignments. */
export const runsInOnePass = request => writesInOnePass(request) && Array.isArray(request.assignments) && request.assignments.length > 0;

/** Whether one round of a coverage run, with its own `assignments`, is written in one pass: a round with none (a top-up of targets written again only) is staged. */
export const roundInOnePass = (request, assignments) => runsInOnePass({ ...request, assignments });

/** The questions a one-pass run of `goal` planned questions is expected to keep: { low, high }. The plan is the upper end; some cards are dropped by the checks and the review. */
export function questionRange(goal) {
  const high = Math.max(0, Math.floor(Number(goal) || 0));
  return { low: high ? Math.max(1, Math.floor(high * ONE_PASS_LIMITS.forecastKeepShare)) : 0, high };
}

/** The performance a draft records: the strategy that really wrote it (a run one pass cannot serve was written staged), and the write style only when one pass wrote it,
    since the staged pipeline has none. The other keys stay as they were, in their order. */
export function writtenWith(performance, onePass) {
  const { writeStyle, ...rest } = performance;
  return onePass ? { ...rest, strategy: 'one-pass', writeStyle } : { ...rest, strategy: 'staged' };
}
