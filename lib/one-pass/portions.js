import { ONE_PASS_LIMITS } from './limits.js';

/* The portions of a one-pass run: consecutive assignments (lib/coverage-strength.js assignmentsOf: a section with its range and quota) packed into the material of one write call. */

const lengthOf = assignment => assignment.end - assignment.start;

/** An assignment whose quota alone is more than one reply holds, as equal contiguous ranges that share its quota; any other assignment as it is. */
function withinReply(assignment, cardsPerReply) {
  const pieces = Math.ceil(assignment.quota / cardsPerReply);
  if (pieces <= 1) return [assignment];
  const length = lengthOf(assignment);
  return Array.from({ length: pieces }, (_, index) => ({ ...assignment, key: `${assignment.key}/${index + 1}`,
    start: assignment.start + Math.floor(length * index / pieces), end: assignment.start + Math.floor(length * (index + 1) / pieces),
    quota: Math.floor(assignment.quota / pieces) + (index < assignment.quota % pieces ? 1 : 0) }));
}

const fits = (portion, assignment, { portionChars, cardsPerReply }) =>
  portion.chars + lengthOf(assignment) <= portionChars && portion.questions + assignment.quota <= cardsPerReply;

/** The portions of `assignments`, in reading order: [{ assignments, chars, questions }]. */
export function packPortions(assignments, limits = ONE_PASS_LIMITS) {
  const portions = [];
  for (const assignment of (Array.isArray(assignments) ? assignments : []).flatMap(item => withinReply(item, limits.cardsPerReply))) {
    const last = portions.at(-1);
    if (last && fits(last, assignment, limits)) {
      last.assignments.push(assignment);
      last.chars += lengthOf(assignment);
      last.questions += assignment.quota;
    } else portions.push({ assignments: [assignment], chars: lengthOf(assignment), questions: assignment.quota });
  }
  return portions;
}
