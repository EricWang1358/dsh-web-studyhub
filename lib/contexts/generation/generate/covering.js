import { topUpSpec } from '../../../coverage-round.js';
import { stepOf, wantedUncovered } from '../../../coverage-run.js';
import { coverageForDraft, documentTopUp, topUpRound } from '../../../coverage-state.js';
import { transitionRunState } from '../run-state.js';
import { ROUND } from './messages.js';

/* Which sections a run that goes by sections is for: where the plan of the draft stands, the round the screen showed, and the plan a draft without one gets. */

/** A plan as a stopped host left it: a round in flight is owed again (run-state.js). */
export const readAfterStop = spec => transitionRunState({ spec }, { type: 'recover' }).spec;

/** The continue action: where the plan of the draft stands now. The first step is the next planned round, else a fill round for the sections that were planned and did not come out.
    (The learner asked for it, so the retry bound of a run starts again.) */
export function runStartOf({ s, previous, plannedSpec, fillRounds }) {
  const fresh = readAfterStop(plannedSpec);
  return stepOf({ spec: fresh, uncovered: wantedUncovered(fresh, coverageForDraft(s, previous)), run: { autoComplete: true, fillUsed: 0, tokensUsed: 0 }, fillRounds });
}

/** The plan of a part is made over the sections nobody is working on (`planning`); what it says about coverage is the document's. */
function partRound({ a, s, part, coverageAsked, request, roundLimit }) {
  const found = documentTopUp(s, { documentId: a.documentId }, { partOf: part.deck.id, sectionIds: coverageAsked.sectionIds, batchSize: request.performance?.batchSize,
    limit: roundLimit });
  return { coverage: found.planning, round: found.round, request: found.request, inFlight: found.inFlight };
}

/** The round the screen showed (or, without section keys, the default round: the next round of the plan): which sections, how many questions, and what the planner is given. */
export function coveringOf(asked) {
  const { s, previous, runStart, part, coverageAsked, request, roundLimit } = asked;
  const batchSize = request.performance?.batchSize;
  if (runStart) return topUpRound(s, previous, { sectionIds: runStart.keys, fit: true, batchSize, limit: roundLimit });
  if (part) return partRound(asked);
  // `manual`: a press for ONE material on the draft page: its sections, fitted to one round, a section that failed again and again included (the press is the learner's).
  return coverageAsked ? topUpRound(s, previous, { sectionIds: coverageAsked.sectionIds, batchSize, limit: roundLimit, manual: coverageAsked.manual === true }) : null;
}

const ROUND_ERRORS = { covered: ROUND.covered, 'too-many': ROUND.tooMany };

export function checkRound(covering, say) {
  if (!covering) return;
  if (covering.round.error) throw new Error(say(...(ROUND_ERRORS[covering.round.error] ?? ROUND.gone)));
  if (covering.round.questions) return;
  throw new Error(say(...(covering.inFlight > 0 ? ROUND.inFlight : ROUND.allCovered)));
}

/** A draft with no plan: its uncovered sections ARE the plan of a run, rounds of at most `roundLimit` questions one after another until every section has a question,
    when the rounds are to go on
    by themselves (`autoComplete` asked for, or not said while no section was chosen; a caller that chose sections and said nothing gets the one round it chose, as it
    always did). A part of a deck always has its plan. */
export const synthesizesPlan = ({ covering, runAsked, plannedSpec, part, coverageAsked }) => !!covering && !runAsked && !plannedSpec?.rounds?.length
  && (!!part || (coverageAsked.autoComplete ?? coverageAsked.sectionIds === undefined));

export const synthesizedSpec = ({ covering, previous, roundLimit }) => topUpSpec(covering.coverage, { kept: previous?.cards.length ?? 0, limit: roundLimit });
