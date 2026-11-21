import { topUpSpec } from '../../../coverage-round.js';
import { roundList, stepOf, wantedUncovered } from '../../../coverage-run.js';
import { coverageForDraft, documentTopUp, topUpRound } from '../../../coverage-state.js';
import { transitionRunState } from '../run-state.js';
import { POINTS, ROUND } from './messages.js';
import { openPoints, pointTopUpRound, settlePointRounds } from './point-round.js';

/* Which sections a run that goes by sections is for: where the plan of the draft stands, the round the screen showed, and the plan a draft without one gets. */

/** A plan as a stopped host left it: a round in flight is owed again (run-state.js). */
export const readAfterStop = spec => transitionRunState({ spec }, { type: 'recover' }).spec;

/** A round of knowledge points a stopped host left pending, with the points of it that still have no question: { type: 'points', index, pointIds }, or null. */
function stoppedPointRound(s, previous, spec) {
  const round = roundList(spec).findLast(item => item.fill && item.status === 'pending' && item.pointIds?.length);
  const open = round ? openPoints(s, previous, round.pointIds) : [];
  return open.length ? { type: 'points', index: round.index, pointIds: open } : null;
}

/** The continue action: where the plan of the draft stands now. The first step is a round of knowledge points a stopped host left (its points that still have no
    question: it is not skipped in silence), else the next planned round, else a fill round for the sections that were planned and did not come out.
    A round of points that cannot be finished any more (point-round.js settlePointRounds) is skipped with why first: the step carries the plan so (`settled`),
    for the run to start from and write down. (The learner asked for it, so the retry bound of a run starts again.) */
export function runStartOf({ s, previous, plannedSpec, fillRounds, roundLimit }) {
  const settled = settlePointRounds(s, previous, plannedSpec, roundLimit ? { limit: roundLimit } : {}), fresh = readAfterStop(settled);
  const step = stoppedPointRound(s, previous, fresh)
    ?? stepOf({ spec: fresh, uncovered: wantedUncovered(fresh, coverageForDraft(s, previous)), run: { autoComplete: true, fillUsed: 0, tokensUsed: 0 }, fillRounds });
  return settled === plannedSpec ? step : { ...step, settled };
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
  if (runStart?.type === 'points') return pointTopUpRound(s, previous, { pointIds: runStart.pointIds, batchSize, limit: roundLimit });
  if (runStart) return topUpRound(s, previous, { sectionIds: runStart.keys, fit: true, batchSize, limit: roundLimit });
  if (part) return partRound(asked);
  // 补这些知识点: the draft's round for these knowledge points (point-round.js), recorded like a manual press.
  if (coverageAsked?.pointIds) return pointTopUpRound(s, previous, { pointIds: coverageAsked.pointIds, batchSize, limit: roundLimit });
  // `manual`: a press for ONE material on the draft page: its sections, fitted to one round, a section that failed again and again included (the press is the learner's).
  return coverageAsked ? topUpRound(s, previous, { sectionIds: coverageAsked.sectionIds, batchSize, limit: roundLimit, manual: coverageAsked.manual === true }) : null;
}

const ROUND_ERRORS = { covered: ROUND.covered, 'too-many': ROUND.tooMany, 'point-unknown': POINTS.unknown, 'point-covered': POINTS.covered, 'point-no-text': POINTS.noText };

/** The refusal of a round that cannot run: a round of knowledge points says why in its own words (its limit, the outline it rests on). */
function roundRefusal(round) {
  if (round.error === 'points-unavailable') return POINTS.unavailable[round.reason] ?? POINTS.unavailable['no-outline'];
  if (round.error === 'points-held') return POINTS.held[round.reason] ?? POINTS.held['cannot-top-up'];
  if (round.error === 'too-many' && round.points) return POINTS.tooMany(round.limit);
  return ROUND_ERRORS[round.error] ?? ROUND.gone;
}

export function checkRound(covering, say) {
  if (!covering) return;
  if (covering.round.error) throw new Error(say(...roundRefusal(covering.round)));
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
