import { coveragePlan } from '../../../coverage-plan.js';
import { interruptedRounds, owedDue, roundOfKeys, roundsDue, wantedUncovered } from '../../../coverage-run.js';
import { coverageForDraft, leafSectionsFor } from '../../../coverage-state.js';
import { autoCompleteOf, levelOf } from '../../../coverage-strength.js';
import { lengthWeights } from '../../../section-weights.js';
import { readAfterStop } from './covering.js';
import { GOAL } from './messages.js';

/* The plan a job starts from. A new coverage run: made now from the lengths of the sections, because the job card and the estimate need it at once, and made again from
    the model's weights when the job runs.
   `plan`, what the executor works on: a new coverage run, the continue action, or a top-up of a draft that kept its plan. `spec` is the plan with each round's state;
   the draft keeps it (`editorial.coverageSpec`)
   together with the marker of the run (`editorial.coverageRun`) at every boundary, so the DRAFT is the checkpoint. */

/** The first version of a new coverage run: what the run covers, and the first round, which is what the job asks for now. */
export function newCoverageRun({ a, s, sources, roundLimit, say }) {
  const leaves = leafSectionsFor(s, sources);
  if (!leaves.length) throw new Error(say(...GOAL.noText));
  const goalCount = Number.isInteger(a.count) ? a.count : undefined;
  const made = coveragePlan({ leaves, weights: lengthWeights(leaves), level: levelOf(a.coverageLevel), goalCount, limit: roundLimit });
  const [round] = made.rounds;
  return { coverageRun: { level: made.plan.level, goalCount, leaves, goal: made.plan.goal, rounds: made.rounds.length, covered: made.plan.mustCover },
    count: round.questions, assignments: round.assignments };
}

function autoOf({ a, wantsCoverage, runAsked, coverageAsked, priorRun, synthesized }) {
  if (wantsCoverage) return a.autoComplete ?? autoCompleteOf(a.coverageLevel);
  return runAsked ? coverageAsked.autoComplete ?? priorRun.autoComplete ?? true : coverageAsked.autoComplete ?? synthesized;
}

/** Where the job starts: the sections that already have a question are not its work (its progress is counted from here; lib/job-contract.js coverOf). */
const startViewOf = ({ s, previous, part, covering, wantsCoverage }) => {
  if (wantsCoverage) return null;
  return part ? covering.coverage : coverageForDraft(s, previous);
};

function coverAtStart({ coverageRun, covering }, startView, auto) {
  const fixed = !auto && covering?.round.sections > 0 ? { fixed: covering.round.sections } : {};
  if (!startView) return { leaves: coverageRun.leaves.length, covered: 0, atStart: 0, ...fixed };
  return { leaves: startView.leaves, covered: startView.covered, atStart: startView.covered, ...fixed };
}

/** What is left of the plan when the job starts (lib/coverage-run.js roundsDue): its first round is what the job is asked for now (`count`: the sections of it that have
    no question, fitted), every other round
    not run yet the sections of it that still have no question, never the number the plan gave it (rounds before it may have covered most of them). `ahead`: what the
    rounds after the first one add when the run goes on by itself. */
function seedDue(plan, { runStart, covering, count }, startView) {
  const asked = covering.request.sectionKeys;
  const firstRound = runStart ? (runStart.type === 'round' ? runStart.index : -1) : roundOfKeys(plan.spec, asked);
  plan.uncovered = wantedUncovered(plan.spec, startView);
  plan.due = roundsDue(plan.spec, { uncovered: plan.uncovered, asked });
  // The first round may be asked for some of its sections only: what it owes besides them is its own next pass (lib/coverage-run.js owedDue), part of what is left and,
  // when the run goes on, of this job.
  const rest = firstRound >= 0 ? owedDue(plan.spec, firstRound, plan.uncovered, asked) : 0;
  if (firstRound >= 0) plan.due[firstRound] = count + rest;
  plan.ahead = plan.auto ? plan.due.reduce((sum, value, index) => sum + (index === firstRound ? 0 : value), 0) + rest : 0;
}

const budgetOf = ({ a, wantsCoverage, coverageAsked, priorRun }) => wantsCoverage ? a.tokenBudget : coverageAsked.tokenBudget ?? priorRun.tokenBudget;
const tokensBaseOf = ({ previous, priorRun }) => previous ? priorRun.tokensUsed || 0 : 0;
const hasPlan = ({ wantsCoverage, covering, plannedSpec }) => wantsCoverage || (covering && plannedSpec?.rounds?.length);

export function planOf(asked) {
  const { wantsCoverage, plannedSpec, runAsked, runStart } = asked;
  if (!hasPlan(asked)) return null;
  const auto = autoOf(asked), startView = startViewOf(asked);
  const plan = { auto, tokenBudget: budgetOf(asked), resumed: runAsked, newRun: wantsCoverage, spec: wantsCoverage ? null : readAfterStop(plannedSpec),
    rerun: runAsked ? interruptedRounds(plannedSpec) : [], first: runStart, marker: null, fills: 0, round: 1, percent: startView ? startView.percentLeaves : 0,
      tokensBase: tokensBaseOf(asked),
    estimate: null, started: false, cover: coverAtStart(asked, startView, auto), uncovered: null, due: null, ahead: 0, asks: new Map(), passes: new Map() };
  if (plan.spec) seedDue(plan, asked, startView);
  return plan;
}
