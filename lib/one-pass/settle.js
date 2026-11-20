import { pieceOfAssignment, PLAN_SHORT } from '../assigned-plan.js';
import { stampPlaces } from '../card-places.js';

/* What a settled portion becomes in the run (lib/batch.js), in the records the staged pipeline keeps, so the draft, the coverage view and the failures read it the same way:
   - the portion's part counts the targets the program verified, and its outcome is the deck with every card credited to the section its target was verified in;
   - a portion that kept none of them failed with the reason (a quality failure: the rounds of the coverage run take the sections up again, not this run);
   - sections still short of their quota become ONE failed part whose range is exactly those sections, with the code plan-short (lib/assigned-plan.js), so they are
     planned-failed sections in lib/coverage.js and a line in the failures; a portion that verified no target at all IS that part. */

const lineOf = item => `${item.title ? `"${item.title}"` : item.key}: ${item.planned} of ${item.quota} knowledge points${item.error ? ` (${item.error})` : ''}`;

/** The failed part of the sections still short: { part, outcome, notes }. */
function shortPart(short, sources) {
  const asked = short.reduce((sum, item) => sum + item.quota, 0), got = short.reduce((sum, item) => sum + item.planned, 0);
  return {
    part: { sources: short.flatMap(item => pieceOfAssignment(item, sources)), kind: 'quiz', count: short.reduce((sum, item) => sum + item.missing, 0), short, onePass: true },
    outcome: { error: `The plan came back short (${PLAN_SHORT}): ${got} of ${asked} knowledge points for ${short.length} section(s) the plan could not fill after asking again`, final: true },
    notes: short.map(lineOf),
  };
}

/**
 * `result` is what lib/one-pass/portion.js writePortion returned, `sources` the run's sources. Returns { count, outcome, notes, short? }: the portion's own count, outcome and
 * note lines, and the failed part of its short sections, if any. When nothing was verified, `replace` is that failed part, to take the portion's place.
 */
export function settledPortion(result, sources) {
  if (!result.targets.length) {
    const failed = shortPart(result.short, sources);
    return { replace: failed.part, outcome: failed.outcome, notes: [...result.notes, ...failed.notes] };
  }
  const deck = { ...result.deck, cards: stampPlaces(result.deck.cards, result.targets) };
  const outcome = deck.cards.length ? { deck }
    : { deck, error: `Quality gate failed: none of the ${result.targets.length} question(s) written passed the program checks and the review`, final: true };
  return { count: result.targets.length, outcome, notes: result.notes, ...(result.short.length ? { short: shortPart(result.short, sources) } : {}) };
}
