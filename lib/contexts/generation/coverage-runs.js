/* The bookkeeping of a coverage run for the generation context (lib/coverage-run.js has the rules, lib/contexts/generation/operations.js the executor): the marker a draft keeps, the live copy a job
   shows the console, and what a restart brings back. Plain data in, plain data out; nothing here talks to the library. */
import { roundList, interruptedRounds, runFacts } from '../../coverage-run.js';

/** The marker `editorial.coverageRun` of a run that starts now. */
export function newMarker({ jobId, autoComplete, tokenBudget, estimate, startedAt = new Date().toISOString() }) {
  return { jobId, autoComplete: autoComplete !== false, state: 'running', startedAt, updatedAt: startedAt, tokensUsed: 0,
    ...(tokenBudget > 0 ? { tokenBudget } : {}), ...(estimate ? { estimate } : {}) };
}

/** The marker of a run that goes on (接着做 / a resume): the same run, a new job, the tokens so far kept, the stop of the last time forgotten. */
export function resumedMarker(marker, { jobId, autoComplete, tokenBudget, estimate, startedAt = new Date().toISOString() }) {
  const { stop: _stop, ...rest } = marker || {};
  return { ...rest, jobId, autoComplete: autoComplete !== false, state: 'running', startedAt: marker?.startedAt || startedAt, updatedAt: startedAt, tokensUsed: marker?.tokensUsed || 0,
    ...(tokenBudget > 0 ? { tokenBudget } : marker?.tokenBudget ? { tokenBudget: marker.tokenBudget } : {}), ...(estimate ? { estimate } : marker?.estimate ? { estimate: marker.estimate } : {}) };
}

/** The rounds a job shows the console: small and bounded (a run has a dozen). */
export const listOf = (spec) => roundList(spec).slice(0, 40).map((round) => ({ round: round.round, questions: round.questions, status: round.status, fill: round.fill,
  sections: round.sectionIds.length, ...(round.unit ? { unit: round.unit } : {}), ...(round.code ? { code: round.code } : {}), ...(round.kept !== undefined ? { kept: round.kept } : {}), ...(round.covered !== undefined ? { covered: round.covered } : {}),
  ...(round.tokens ? { tokens: round.tokens } : {}), ...(round.ms ? { ms: round.ms } : {}), ...(round.reason ? { reason: String(round.reason).slice(0, 200) } : {}) }));

/**
 * The sections a job counts its progress in (`job.coverageRun`, read by lib/job-contract.js `coverOf`): all the sections of the plan, those that have a question, those that had one when the job started and how
 * many the job was asked to cover (the ones that had none, or - `fixed` - the sections of the one round it makes). `cover` is { leaves, covered, atStart, fixed? }; nothing is said without it.
 */
export function coverCounts(cover) {
  if (!(cover?.leaves > 0)) return {};
  return { leaves: cover.leaves, covered: cover.covered, coveredAtStart: cover.atStart, askedSections: cover.fixed > 0 ? cover.fixed : Math.max(0, cover.leaves - cover.atStart) };
}

/** The live copy of a run a job carries (`job.coverageRun`): the marker's facts and the rounds' states, for the contract (lib/job-contract.js detail.run) and the console. */
export function mirrorOf(spec, marker, { percent = null, cover, draftId } = {}) {
  return { autoComplete: marker.autoComplete !== false, state: marker.state, list: listOf(spec), percent, ...coverCounts(cover), tokensUsed: marker.tokensUsed || 0, startedAt: marker.startedAt,
    ...(marker.tokenBudget > 0 ? { tokenBudget: marker.tokenBudget } : {}), ...(marker.estimate ? { estimate: marker.estimate } : {}), ...(marker.stop ? { stop: marker.stop } : {}), ...(draftId ? { draftId } : {}) };
}

/** The runs a stopped host left behind: the drafts whose marker says 'running' or 'paused' (and whose plan has rounds that are not done). [{ draft, spec, marker, round }] */
export function interruptedRuns(drafts) {
  const out = [];
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const marker = draft?.editorial?.coverageRun, spec = draft?.editorial?.coverageSpec;
    if (!marker || !['running', 'paused'].includes(marker.state) || !spec?.rounds?.length || draft.editingDeckId) continue;
    const list = roundList(spec, { interrupted: true });
    if (!list.some((round) => round.status === 'pending')) continue;
    out.push({ draft, spec, marker, round: list.find((round) => round.status === 'pending').round, inflight: interruptedRounds(spec).map((index) => spec.rounds[index].round) });
  }
  return out;
}

/** The job's own line when a coverage run ends (English prose, like the rest of a job's stage: the console says it in words of its own from `job.coverageRun.stop`). */
export function runStageText(final, plan, job) {
  const rounds = plan.spec?.rounds?.length ?? 0, left = (plan.spec?.rounds || []).filter((round) => !round.status || round.status === 'pending').length;
  if (final?.type === 'wait') return `Round ${plan.round} of ${rounds} is done and saved; ${left} more round(s) wait for you`;
  const stop = final?.reason;
  if (stop === 'complete') return `Draft ready: every planned section has a question (${job.savedCount} questions in ${rounds} round(s))`;
  if (stop === 'target') return `Draft ready: the coverage target of this level was reached before every round ran (${job.savedCount} questions)`;
  if (stop === 'budget') return `Stopped after round ${plan.round} of ${rounds}: the token budget of this run is spent (${job.savedCount} questions kept)`;
  if (stop === 'no-progress') return `Stopped after round ${plan.round} of ${rounds}: it covered no new section after its retries, so the run did not ask again (${job.savedCount} questions kept)`;
  if (stop === 'sections-left') return `Stopped after ${rounds} round(s): ${final.left} section(s) still have no question after the retry rounds (${job.savedCount} questions kept)`;
  return `Draft saved with ${job.savedCount} questions`;
}

export { runFacts };
