import { endsWithoutProgress, stepOf } from '../../../coverage-run.js';
import { topUpRound, sourcesOfDraft } from '../../../coverage-state.js';
import { isPermanentFailure } from '../../../generation-failure.js';
import { recordEvent } from '../../../job-calls.js';
import { get } from '../../../util.js';
import { NOT_FOUND_LABEL, ROUND } from './messages.js';

/* What a settled round leads to: the next round's context, or why the run is over for now. */

const isNext = step => step.type === 'round' || step.type === 'fill';
const knownCode = code => (code && code !== 'unknown' ? { code } : {});

/** A failure that repeating cannot fix (a refused key, no credit) ends the run; the questions that passed stay. A round that fails in a job that does not go on by
    itself is that job's failure, as it always was. */
async function endOnFailure({ control, book, job }, { failure, timedOut, reason, code }) {
  if (!failure) return;
  const permanent = !timedOut && isPermanentFailure(failure);
  if (!permanent && control.values.autoComplete) return;
  // The key was refused (or the account is out of credit): what passed stays, and the run can go on from its next round once that is fixed (the continue action).
  if (permanent) { book.stopRun('refused', { code, ...(code && code !== 'unknown' ? {} : { detail: reason }) }); job.retryable = true; }
  await book.persist();
  throw failure;
}

/** A round that covered no section it had none for, after its own retries, ends a run that goes on by itself: the same asking again would give the same answer.
    A PLANNED round that covered nothing is not the end while a bounded fill round can still write the sections that did not come out again (the last planned round, say,
    with sections left); only a round whose
    next step is another planned round, or a fill round that gained nothing, is "no progress". The stop says how many sections are left.
    Progress is NEW COVERAGE (a section that had no question has one now), never the number of questions kept: a round that kept questions and credited none is no
    progress, and says so (`uncredited`).
    A pass asked for PART of its round (a press, a cut to fit) is not the end either while the next step is the same round's sections that nobody tried: they are asked,
    never given up
    untried. It still ends: each such pass is asked for at least one section of the round that no pass tried (lib/coverage-run.js owedKeys, planRound keeps one pick at
    least). A failure
    that repeats (the same cause as the previous pass of the round) stops it there, so it does not cost a failed pass per section; the round stays pending, owing them
    (lib/coverage-run.js endsWithoutProgress). */
function stopWithoutProgress({ plan }, step, { ctx, round, failure, progress, uncovered, uncredited, reason, code }) {
  const lastPass = plan.passes.get(ctx.index);
  plan.passes.set(ctx.index, { failed: !!failure, code: code || 'unknown' });
  if (!endsWithoutProgress({ progress, step, index: ctx.index, fill: !!round.fill, failed: !!failure, code, previous: lastPass })) return step;
  return { type: 'stop', reason: 'no-progress', left: uncovered.size, ...(uncredited ? { uncredited } : {}), ...knownCode(code), ...(reason ? { detail: reason } : {}) };
}

/** Paused between rounds: the round in flight has finished, no new one starts until the learner goes on (or stops here). */
async function waitOutPause({ job, control, controller, book }, step, round, decide) {
  let next = step;
  while (isNext(next) && control.values.paused) {
    book.moved({ type: 'pause' });
    recordEvent(job, { level: 'done', code: 'run-paused', args: { after: round.round } });
    book.syncRun();
    await book.persist();
    await control.waitIfPaused(controller.signal);
    book.moved({ type: 'unpause' });
    recordEvent(job, { level: 'done', code: 'run-resumed', args: { next: round.round + 1 } });
    next = decide();
  }
  return next;
}

/** The round the step names, as the library is now: a new context, or the stop when its sections are gone. */
async function nextRoundOf({ job, plan, prep, host }, step) {
  const state = await host.read(), current = get(state.drafts, job.draftId, NOT_FOUND_LABEL.draft);
  const next = topUpRound(state, current, { sectionIds: step.keys, fit: true, batchSize: prep.request.performance?.batchSize, limit: prep.roundLimit });
  if (next.round.error || !next.round.questions) return { final: { type: 'stop', reason: 'round-failed', detail: host.say(...ROUND.nextGone) } };
  if (step.type === 'fill') plan.fills += 1;
  return { ctx: { base: current, mergeSources: sourcesOfDraft(state, current), sources: next.request.sources, count: next.request.count,
    assignments: next.request.assignments, reuse: next.request.reuse,
    titles: next.request.titles, covering: true, first: false, questions: next.round.questions, index: step.type === 'round' ? step.index : null, keys: next.request.sectionKeys } };
}

/** `{ ctx }`, the round to run next, or `{ final }`, the step the run ends on. */
export async function nextOfRound(run, { ctx, round, failure, timedOut }, { uncovered, progress, uncredited, reason, code }) {
  const { plan, control, prep, book } = run;
  await endOnFailure(run, { failure, timedOut, reason, code });
  const decide = () => stepOf({ spec: plan.spec, uncovered, run: { autoComplete: control.values.autoComplete, fillUsed: plan.fills, tokensUsed: plan.marker.tokensUsed,
    tokenBudget: plan.marker.tokenBudget }, fillRounds: prep.fillRounds });
  let step = stopWithoutProgress(run, decide(), { ctx, round, failure, progress, uncovered, uncredited, reason, code });
  step = await waitOutPause(run, step, round, decide);
  // A round that ran a pass already, even one a stopped host cut short, and owes nothing any more is done (what that pass tried and did not get is a fill round's), not
  // a round whose sections already had questions.
  for (const index of step.skipped || []) book.moved({ type: 'round-skip', index });
  return isNext(step) ? nextRoundOf(run, step) : { final: step };
}
