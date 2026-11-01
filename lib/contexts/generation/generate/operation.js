import { ROUND_LIMIT } from '../../../coverage-round.js';
import { FILL_ROUNDS } from '../../../coverage-run.js';
import { generationControl } from '../../../job-control.js';
import { get, id } from '../../../util.js';
import { startGeneration } from '../jobs/submit-generation.js';
import { answerOf, closingAnswer } from './answer.js';
import { checkConstraints, checkContinuation, checkCoverageArgs, checkExtra, checkGoal, checkKind, checkLevel, checkPartArgs, checkRunArgs, coverageAskedOf, extraIdsOf, partAskedOf,
  wantsCoverageOf } from './args.js';
import { checkRound, coveringOf, runStartOf, synthesizedSpec, synthesizesPlan } from './covering.js';
import { estimateInto } from './estimate.js';
import { executorOf } from './execute.js';
import { partsFor, planGoalOf, seedJob } from './job-seed.js';
import { applyNotation, applyReferences, checkSelectionSize, checkSourcesLeft, countOf, inputRefFor, narrowingOf, raisedCount, selectedSources } from './materials.js';
import { CONTINUE, NOT_FOUND_LABEL, RUN } from './messages.js';
import { newCoverageRun, planOf } from './plan-seed.js';
import { applyCase, applyKindCounts, partOfDocument, previousPartOf, requestOf, someoneElse, targetOf } from './request.js';

/* The operation `generate`, in the order it decides: what was asked, the request, the round, the materials, the card, the queue. The order is part of the contract: it
    says which refusal a request with several
   things wrong gets, and `plannedSpec` is read before the round is known and replaced after it. `prep` is what has been decided so far; each step adds to it, and the
   executor reads it as the last step left it. */

/** What the caller asked, judged. Nothing is written yet. */
async function argsJudged(host, a, publishTarget, mine) {
  const { say, language, call, retrieval, coverage, root, jobs, activeJob } = host;
  const s = await host.read();
  const previous = a.resumeDraftId ? get(s.drafts, a.resumeDraftId, NOT_FOUND_LABEL.draft) : null;
  // Adding from sources: the continuation of an open draft, written from these sources only and added to that same draft.
  const extraIds = extraIdsOf(a);
  checkExtra(a, { previous, extraIds, sources: s.sources, say });
  // The continuation that is asked for the sections of the draft's material that have no question (lib/coverage-round.js), not for a number of questions.
  // `coverage.run` is the continue action: the rounds of the draft's plan from the next one that is not done, one after another (lib/coverage-run.js).
  const coverageAsked = coverageAskedOf(a);
  // The same for a PUBLISHED deck's material (lib/deck-parts.js): never in place. A NEW draft whose targets are exactly the document's sections without a question; published into
  // the deck it becomes the deck's next part. `documentId` names the document (its key, its id or any of its sources: coverage.get's `key`), `partOf` the deck when
  // several hold its questions.
  const partAsked = partAskedOf(a);
  if (partAsked) checkPartArgs(a, { previous, extraIds, publishTarget, coverageAsked, say });
  if (coverageAsked) checkCoverageArgs({ previous, partAsked, extraIds, coverageAsked, say });
  const runAsked = coverageAsked?.run === true;
  const plannedSpec = previous?.editorial?.coverageSpec;
  checkRunArgs({ runAsked, coverageAsked, plannedSpec, say });
  const busy = holds => someoneElse({ jobs, root, activeJob, mine }, holds);
  if (previous) {
    checkContinuation(a, previous);
    if (busy(job => job.draftId === previous.id)) throw new Error(CONTINUE.busy);
  }
  // A NEW draft from sources is asked for a coverage level (lean / standard / full: lib/coverage-strength.js) and, optionally, a total number of questions (any whole number up to
  // GOAL_QUESTIONS_MAX; what does not fit in one round of ROUND_LIMIT questions becomes rounds). A caller that sends only `count` up to ROUND_LIMIT is planned exactly
  // as it always was.
  checkLevel(a, say);
  const wantsCoverage = wantsCoverageOf(a, { previous, extraIds, coverageAsked, publishTarget });
  if (wantsCoverage) checkGoal(a, say);
  return { a, s, root, publishTarget, mine, busy, say, language, call, retrieval, previous, extraIds, coverageAsked, partAsked, runAsked, plannedSpec, wantsCoverage, runStart: null,
    priorRun: previous?.editorial?.coverageRun || {}, roundLimit: coverage?.roundLimit ?? ROUND_LIMIT, fillRounds: coverage?.fillRounds ?? FILL_ROUNDS };
}

function requestSettled(prep) {
  prep.part = prep.partAsked ? partOfDocument(prep, prep.busy) : null;
  prep.previousPart = previousPartOf(prep.s, prep.previous);
  prep.request = requestOf(prep);
  prep.target = targetOf(prep);
}

async function roundSettled(prep) {
  prep.covering = coveringOf(prep);
  checkRound(prep.covering, prep.say);
  prep.synthesized = synthesizesPlan(prep);
  if (prep.synthesized) prep.plannedSpec = synthesizedSpec(prep);
  applyKindCounts(prep);
  checkKind(prep.request.kind);
  await applyCase(prep);
  checkConstraints(prep.request.constraints);
}

async function materialsChosen(prep) {
  const { covering, wantsCoverage, request } = prep;
  prep.count = countOf(prep);
  applyReferences(prep);
  prep.sources = selectedSources(prep);
  prep.count = raisedCount(prep);
  checkSourcesLeft(prep);
  // The sections of the whole material name what each part covers; the run itself is written from the text of the chosen sections only (pieces that remember where they were cut).
  prep.fullSources = prep.sources;
  if (covering) prep.sources = covering.request.sources;
  prep.reuse = covering?.request.reuse || [];
  prep.planCount = covering ? covering.request.count : prep.count;
  prep.narrowing = await narrowingOf(prep);
  if (prep.narrowing) prep.sources = prep.narrowing.sources;
  prep.coverageRun = null;
  prep.assignments = covering ? covering.request.assignments : undefined;
  if (wantsCoverage) {
    Object.assign(prep, newCoverageRun(prep));
    prep.planCount = prep.count;
  }
  applyNotation(request, prep.sources);
  checkSelectionSize(prep);
  prep.inputRef = inputRefFor(prep);
  prep.plan = planOf(prep);
}

async function cardSeeded(host, prep) {
  const { root, mine, previous, request, sources, planCount, reuse, assignments } = prep;
  host.pruneJobs();
  prep.ahead = [...host.jobs.values()].filter(job => job.root === root && host.activeJob(job) && !mine(job)).length;
  prep.planned = request.case ? null : partsFor(request, { sources, count: planCount, reuse, assignments });
  prep.parts = prep.planned ? prep.planned.length : 1;
  prep.planGoal = planGoalOf(prep);
  const job = seedJob(prep, { newId: id, now: () => new Date().toISOString(), language: host.language });
  await estimateInto(job, prep, { tokenMeter: host.tokenMeter, language: host.language });
  // One run per draft, decided in one breath with the registration of the job: two calls that both passed the check above (they await) do not both start.
  if (previous && prep.busy(other => other.draftId === previous.id)) throw new Error(CONTINUE.busy);
  return job;
}

/** Once the new job exists: an interrupted run of the draft is replaced by it (a job of the runtime brought back from its record says so in its contract: its card keeps
    the status the kernel maps it to).
    A plain run that was continued stays in the list as it ended (its numbers do not move), says by which task it was continued and offers nothing more
    (lib/job-contract.js `continued`). */
const isInterrupted = job => job.status === 'interrupted' || job.contract?.status === 'interrupted' || (job.status === 'failed' && job.retryable);
function supersede({ jobs, activeJob }, { root, previous }, newId) {
  if (!previous) return;
  for (const [jobId, other] of jobs) {
    if (other.root !== root || other.draftId !== previous.id || jobId === newId) continue;
    if (other.coverageRun && isInterrupted(other)) jobs.delete(jobId);
    else if (!other.coverageRun && other.retryable === true && !activeJob(other)) other.continuedBy = newId;
  }
}

/** Hand the prepared `task` to a caller that asked for it (a retry prepares its own run), or queue it. `answer` says what was done. */
async function handOver(host, prep, task, take, answer) {
  if (take) { take(task); return { prepared: true }; }
  const started = await startGeneration(host.env, task);
  supersede(host, prep, started.jobId);
  return answer(started.jobId);
}

/** Nothing is left to ask by section and at most the closing write was lost: nothing to ask a model, and a refusal would leave the job interrupted for ever. A plan that
    was closed is refused. */
function closeInstead(host, prep, take) {
  const { a, s, previous, publishTarget, say } = prep;
  const closing = publishTarget ? null : host.runClose.taskFor({ args: a, draft: previous, state: s });
  if (!closing) throw new Error(say(...RUN.complete));
  return handOver(host, prep, closing, take, jobId => closingAnswer(prep, { jobId, seed: closing.seed }));
}

/** The learner's live hand on this run (the console): concurrency, the model of this run alone and the reasoning of each stage; for a coverage run also pause (no new
    model call starts, the running ones
    finish; lib/batch.js) and whether it goes on by itself. It lasts as long as the job. */
const controlOf = (host, { request, plan }) => card => generationControl({ job: card, request, offers: host.offersModel,
  ...(plan ? { rounds: { autoComplete: plan.auto, onAuto: value => plan.onAuto?.(value), onPaused: () => plan.onPaused?.() } } : {}) });

const taskOf = (host, prep, job) => ({ kind: prep.publishTarget ? 'supplement' : 'generation', args: prep.a, root: prep.root, seed: job, makeControl: controlOf(host,
  prep), execute: executorOf(prep, host.execution),
  models: { performance: prep.request.performance, feature: prep.request.case ? 'case' : host.env.feature } });

export async function generate(host, a, { publishTarget = false, take = null, self } = {}) {
  if (!host.complete) throw new Error('Configure a model provider and model in the study settings first');
  // `take`: hand the prepared run to the caller instead of queueing it (a retry prepares its own run); `self`: the logical job that is preparing, which is not its own rival.
  const prep = await argsJudged(host, a, publishTarget, job => self !== undefined && job.contract?.jobId === self);
  requestSettled(prep);
  if (prep.runAsked) {
    prep.runStart = runStartOf(prep);
    if (prep.runStart.type === 'stop') return closeInstead(host, prep, take);
  }
  await roundSettled(prep);
  await materialsChosen(prep);
  const job = await cardSeeded(host, prep), { status } = job;
  return handOver(host, prep, taskOf(host, prep, job), take, jobId => answerOf(prep, { jobId, status }));
}
