import { roundList, roundOfKeys } from '../../../coverage-run.js';
import { NEXT } from './messages.js';

/* What the operation answers once a run is queued: what it will do, in the words an agent and the UI read. */

const coverageOf = ({ round }) => ({ sections: round.sections, questions: round.questions, left: round.left, rounds: round.rounds });

/** The continue action: the plan of the draft and the round this job starts with. */
function continuedPlan({ plannedSpec, runStart, count }) {
  const round = runStart.type === 'round' ? plannedSpec.rounds[runStart.index].round : plannedSpec.rounds.length + 1;
  return { level: plannedSpec.level, goal: plannedSpec.goal, sections: plannedSpec.mustCover, rounds: plannedSpec.rounds.length, round, questions: count };
}
/** A top-up in the same words: the plan of the draft (a plain draft's is its uncovered sections), the round it starts with and how many questions that is. */
function topUpPlan({ plannedSpec, plan, covering, count }) {
  const round = roundList(plan.spec)[roundOfKeys(plan.spec, covering.request.sectionKeys)]?.round ?? plannedSpec.rounds.length + 1;
  return { ...(plannedSpec.level ? { level: plannedSpec.level } : {}), goal: plannedSpec.goal, sections: plannedSpec.mustCover, rounds: plannedSpec.rounds.length, round,
    questions: count };
}
/** What a coverage run will do: its level, how many questions in all, the sections it covers, how many rounds it takes and that this job makes the first. */
const newRunPlan = ({ coverageRun, count }) => ({ level: coverageRun.level, goal: coverageRun.goal, sections: coverageRun.covered, rounds: coverageRun.rounds, round: 1,
  questions: count });

function planField(prep) {
  if (prep.runAsked) return { plan: continuedPlan(prep) };
  if (prep.coverageRun) return { plan: newRunPlan(prep) };
  return prep.plan ? { plan: topUpPlan(prep) } : {};
}

const nextOf = ({ publishTarget, plan }) => publishTarget ? NEXT.supplement : plan?.auto ? NEXT.rounds : NEXT.plain;

export function answerOf(prep, { jobId, status }) {
  const { publishTarget, target, previous, part, covering, ahead, parts, count, plan } = prep;
  return {
    jobId,
    status,
    queuedBehind: ahead,
    parts,
    ...(publishTarget ? { deckId: target.id, completion: 'published-to-target' } : {}),
    ...(previous ? { draftId: previous.id, missing: count } : {}),
    ...(part ? { part: { deckId: part.deck.id, deckTitle: part.deck.title, n: part.n } } : {}),
    ...(covering ? { coverage: coverageOf(covering) } : {}),
    ...planField(prep),
    ...(plan ? { autoComplete: plan.auto } : {}),
    next: nextOf(prep),
  };
}

/** Nothing is left to ask by section and at most the closing write was lost: the job only closes the run. */
export const closingAnswer = ({ previous }, { jobId, seed }) => ({ jobId, status: seed.status, queuedBehind: 0, parts: 0, draftId: previous.id,
  missing: seed.requestedTotal - seed.savedCount, autoComplete: true, next: NEXT.closing });
