import { coveragePlan, coverageSpec, weighsSections } from '../../../coverage-plan.js';
import { lengthWeights, sectionWeights } from '../../../section-weights.js';
import { GENERATION_STAGE_TEXT } from '../../jobs/contracts.js';
import { partPlanFor, partsFor } from './job-seed.js';

/* What a job settles before its first round: how its coverage run is weighed, and the marker that says this job works the run. */

/** A small custom total is not weighed section by section (lib/coverage-plan.js weighsSections): the questions go to the longest sections anyway, and the whole material
    would be sent
    to the light model for it. The same length fallback as having no light model, with its reason kept on the draft. */
function weighedSections({ job, controller, models, prep, host }, weighing) {
  const { coverageRun, sources } = prep;
  if (!weighing) return { weights: lengthWeights(coverageRun.leaves), source: 'length', calls: 0, reasked: 0, reason: 'small-target' };
  const light = models.weigh ? (system, prompt, { signal: stop }) => models.weigh(system, prompt, { stage: job.stage, signal: AbortSignal.any([controller.signal,
    stop]) }) : undefined;
  return sectionWeights({ sections: coverageRun.leaves, sources, light, language: host.language, signal: controller.signal });
}

/** The importance of every section of a coverage run, asked once per chunk of about 20 sections from the light model (lib/section-weights.js), then the plan again from
    them: how many questions each
    section gets, and which sections the first round holds (the heaviest). Without a light model, or when it fails, the sections are weighted by length and the draft says so.
    The answer is what the first round is asked for: every other run is asked for what it was prepared with. */
export async function firstRoundOf(run) {
  const { job, plan, prep, host } = run;
  const { coverageRun, request, sources, reuse, fullSources, roundLimit } = prep;
  if (!coverageRun) return { assignments: prep.assignments, count: prep.planCount };
  const weighing = weighsSections({ goalCount: coverageRun.goalCount, sections: coverageRun.leaves.length });
  if (weighing) job.stage = `${GENERATION_STAGE_TEXT.planning} · Weighing the importance of the sections`;
  const weighed = await weighedSections(run, weighing);
  const made = coveragePlan({ leaves: coverageRun.leaves, weights: weighed.weights, level: coverageRun.level, goalCount: coverageRun.goalCount, limit: roundLimit });
  const [round] = made.rounds;
  const spec = coverageSpec({ plan: made.plan, rounds: made.rounds, weights: weighed.weights, weightSource: weighed.source,
    ...(weighed.reason === 'small-target' ? { weightReason: 'small-target' } : {}), custom: coverageRun.goalCount !== undefined });
  // The card shows what the run really does now: the questions of the first round, its parts, how the whole plan is cut into rounds.
  const again = partsFor(request, { sources, count: round.questions, reuse, assignments: round.assignments });
  Object.assign(job, { count: round.questions, requestedTotal: plan?.auto ? made.plan.goal : round.questions, parts: again.length, partPlan: partPlanFor(again,
    host.language, fullSources),
    coveragePlan: { level: coverageRun.level, goal: made.plan.goal, round: 1, rounds: made.rounds.length, sections: made.plan.mustCover, weights: weighed.source } });
  plan.spec = spec;
  return { assignments: round.assignments, count: round.questions };
}

/** The marker of the run: this job, whether it goes on by itself, what it may spend. */
export function startMarker({ job, control, plan, book, clock, prep }) {
  if (!plan) return;
  plan.marker = prep.previous ? prep.priorRun : null;
  book.moved({ type: prep.previous ? 'resume' : 'start', jobId: job.id, autoComplete: control.values.autoComplete, tokenBudget: plan.tokenBudget, estimate: plan.estimate });
  plan.onAuto = value => {
    book.moved({ type: 'auto', autoComplete: value });
    if (value) job.requestedTotal = Math.max(plan.spec?.goal || 0, job.savedCount || 0);
    book.syncRun();
  };
  plan.onPaused = () => { plan.paused = true; clock.hold(); };
  // The progress bar of a run that goes on by itself is the whole plan.
  if (plan.auto && plan.spec?.goal) job.requestedTotal = Math.max(plan.spec.goal, job.savedCount || 0);
  book.syncRun();
  plan.started = true;
}
