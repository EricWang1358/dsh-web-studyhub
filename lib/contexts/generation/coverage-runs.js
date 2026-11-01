/* The bookkeeping of a coverage run for the generation context (lib/coverage-run.js has the rules, lib/contexts/generation/operations.js the executor): the marker a draft keeps, the live copy a job
   shows the console, and what a restart brings back. Plain data in, plain data out; nothing here talks to the library. */
import { roundList, interruptedRounds, resetRunning, runFacts, roundKeys } from '../../coverage-run.js';

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

/** The rounds a job shows the console: small and bounded (a run has a dozen). `due` (lib/coverage-run.js roundsDue, by index): what each round still has to make, for a round that is not done.
 *  `sections`: what the round was asked for once it has run, what it still owes while it waits (lib/coverage-run.js roundKeys): the 「n 个小节」 of its row and the y of its 「新覆盖 x/y」. */
export const listOf = (spec, due) => roundList(spec).slice(0, 40).map((round) => ({ round: round.round, questions: round.questions, status: round.status, fill: round.fill,
  ...(Number.isFinite(due?.[round.index]) && ['pending', 'running'].includes(round.status) ? { due: due[round.index] } : {}),
  sections: roundKeys(round).length, ...(round.unit ? { unit: round.unit } : {}), ...(round.code ? { code: round.code } : {}), ...(round.kept !== undefined ? { kept: round.kept } : {}), ...(round.covered !== undefined ? { covered: round.covered } : {}),
  ...(round.uncredited ? { uncredited: round.uncredited } : {}), ...(round.tokens ? { tokens: round.tokens } : {}), ...(round.ms ? { ms: round.ms } : {}), ...(round.reason ? { reason: String(round.reason).slice(0, 200) } : {}) }));

/**
 * The sections a job counts its progress in (`job.coverageRun`, read by lib/job-contract.js `coverOf`): all the sections of the plan, those that have a question, those that had one when the job started and how
 * many the job was asked to cover (the ones that had none, or - `fixed` - the sections of the one round it makes). `cover` is { leaves, covered, atStart, fixed? }; nothing is said without it.
 */
export function coverCounts(cover) {
  if (!(cover?.leaves > 0)) return {};
  return { leaves: cover.leaves, covered: cover.covered, coveredAtStart: cover.atStart, askedSections: cover.fixed > 0 ? cover.fixed : Math.max(0, cover.leaves - cover.atStart) };
}

/**
 * The live copy of a run a job carries (`job.coverageRun`): the marker's facts and the rounds' states, for the contract (lib/job-contract.js detail.run) and the console. `due`: what each round still has to
 * make (roundsDue). `tokensBase`: the run's tokens before this job started (the marker counts every job of the run, for its budget): a copy that has it is a JOB's, and its 已用 is the job's own (runFacts).
 */
export function mirrorOf(spec, marker, { percent = null, cover, draftId, due, tokensBase } = {}) {
  return { autoComplete: marker.autoComplete !== false, state: marker.state, list: listOf(spec, due), percent, ...coverCounts(cover), tokensUsed: marker.tokensUsed || 0, ...(Number.isFinite(tokensBase) ? { tokensBase } : {}), startedAt: marker.startedAt,
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

/** The job a run of interruptedRuns comes back as: the same id the run had (so what the learner archived stays archived), with the retry 接着做. `say(zh, en)` words it; `newId` and `now` for a marker that lacks them. */
export function restoredJob({ draft, spec, marker, round }, { root, language, say, newId, now }) {
  const rounds = spec.rounds.length;
  return { id: marker.jobId || newId(), root, status: 'interrupted', retryable: true, continued: true, draftId: draft.id, deckTitle: draft.title, kind: draft.editorial.generation?.kind || 'quiz', course: draft.course ?? '',
    sourceIds: draft.editorial.generation?.sourceIds || [], count: 0, savedCount: draft.cards.length, requestedTotal: Math.max(spec.goal || 0, draft.cards.length), parts: 0, steps: [], messages: [],
    coveragePlan: { level: spec.level, goal: spec.goal, round, rounds, sections: spec.mustCover, weights: spec.weightSource },
    coverageRun: mirrorOf(resetRunning(spec), marker, { draftId: draft.id }),
    stage: say(`上次运行被中断：第 ${round} 轮没有做完。已通过的题已保存，点「接着做」从第 ${round} 轮继续。`, `The last run was interrupted before round ${round}. The questions that passed are saved; 接着做 continues at round ${round}.`),
    startedAt: marker.startedAt || now, finishedAt: marker.updatedAt || now, language };
}

/** The job's own line when a coverage run ends (English prose, like the rest of a job's stage: the console says it in words of its own from `job.coverageRun.stop`). */
export function runStageText(final, plan, job) {
  const rounds = plan.spec?.rounds?.length ?? 0, left = (plan.spec?.rounds || []).filter((round) => !round.status || round.status === 'pending').length;
  if (final?.type === 'wait') return `Round ${plan.round} of ${rounds} is done and saved; ${left} more round(s) wait for you`;
  const stop = final?.reason;
  if (stop === 'complete') return `Draft ready: every planned section has a question (${job.savedCount} questions in ${rounds} round(s))`;
  if (stop === 'target') return `Draft ready: the coverage target of this level was reached before every round ran (${job.savedCount} questions)`;
  if (stop === 'questions-short') return `Draft saved with ${job.savedCount} of ${job.requestedTotal} questions: every planned section has a question, but the run was cut short before it wrote the rest`;
  if (stop === 'budget') return `Stopped after round ${plan.round} of ${rounds}: the token budget of this run is spent (${job.savedCount} questions kept)`;
  if (stop === 'no-progress') return `Stopped after round ${plan.round} of ${rounds}: it covered no new section after its retries, so the run did not ask again (${job.savedCount} questions kept)`;
  if (stop === 'sections-left') return `Stopped after ${rounds} round(s): ${final.left} section(s) still have no question after the retry rounds (${job.savedCount} questions kept)`;
  return `Draft saved with ${job.savedCount} questions`;
}

export { runFacts };
