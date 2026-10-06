import { LIMITS } from '../../../jobs/limits.js';

const count = value => (Number.isInteger(value) && value >= 1 ? value : undefined);

/** The identity of the logical unit one model call belongs to. It is a function of the unit's coordinates only, never of a counter or a clock,
 * so a new attempt of the same run names the same units the same way and a changed unit never inherits another unit's key.
 *   round    the round of a coverage run (absent for a plain run)
 *   group    the group of pages one planning call covers (planning is per group, before any part exists)
 *   part     the part of the round being written
 *   attempt  which try of the part (the first is the default: a part that failed is written again as attempt 2)
 *   fill     the fill round inside the part (reserve first, then planned anew)
 *   retry    the n-th re-ask of an unreadable review reply
 *   card     the draft card a repair works on (its id: the same card is the same unit however the list of rejected cards shrinks)
 *   unit     a named unit outside parts (the section weights of a coverage run) */
export function stepKeyOf({ purpose, round, group, part, card, attempt, fill, retry, unit }) {
  const segments = [count(round) && `r${round}`, count(group) && `g${group}`, count(part) && `p${part}`, typeof card === 'string' && card && `k${card}`,
    count(attempt) > 1 && `a${attempt}`, count(fill) && `f${fill}`, unit, purpose, count(retry) && `x${retry}`].filter(Boolean);
  return segments.join(':').slice(0, LIMITS.stepKeyLength);
}
