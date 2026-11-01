import { calibrationFor } from '../../../estimate-calibration.js';
import { holdClock, workClock } from '../../../job-parallel.js';
import { observedByStage } from '../../../stage-usage.js';
import { get } from '../../../util.js';
import { firstRoundOf, startMarker } from './first-round.js';
import { EXECUTE, NOT_FOUND_LABEL } from './messages.js';
import { beginRound, firstContext } from './round-begin.js';
import { createRoundClock } from './round-clock.js';
import { nextOfRound } from './round-next.js';
import { settleRound } from './round-settle.js';
import { stepOfRound } from './round-step.js';
import { createRunBook } from './run-book.js';
import { failRun } from './run-failed.js';
import { finishRun } from './run-finish.js';

/* The executor of a prepared run, the ONE executor of a coverage run: nothing else loops. It keeps the contract of jobs/submit-generation.js: `execute({ job, control,
    controller, models, runId, checkpoint, commit, plans })`.
   `runId`: what the run is called across Attempts (the runtime's logical job; the job's own id when it is not one). `checkpoint(draft)`: told after every save of the run's draft.
   `run` below is one execution: what it was handed, `prep` (what was prepared, never written here but for `plan`), `host` (the ports), its clock and its book, and what
   it has come to know: `savedVersion`, `deck`, `latest`, `lastUncovered`. */

function letGo({ job, control, host }) {
  const { generationControllers, jobControls } = host.work;
  generationControllers.delete(job.id);
  jobControls.delete(job.id);
  control.close();
}

/** Stopped before it started. A run of the runtime is announced by its settlement sink (jobs/notices.js), once, whatever the mode. */
function cancelledInQueue(run) {
  const { job, host } = run;
  job.status = 'cancelled';
  job.finishedAt ||= new Date().toISOString();
  letGo(run);
  if (!host.managed) host.announce(job);
}

/** The clocks of a run. A plain run has `jobTimeoutMinutes` as a whole; a coverage run per round (round-clock.js). The limit is the time the run works, so a job held in
    the queue after a model error does not spend it. */
function startClocks(run) {
  const { job, control, controller, plan, prep: { request }, clock } = run;
  if (plan) {
    control.on(changed => { if (changed.paused === false) clock.resume(); });
    return { letGoOfHold: holdClock(job, { stop: () => clock.hold(), resume: () => { if (!control.values.paused) clock.resume(); } }) };
  }
  return { timer: workClock(job, job.totalTimeoutSeconds * 1000, () => {
    job.status = 'cancelling';
    job.stage = 'Time budget reached; stopping workers';
    controller.abort(Object.assign(new Error(`Generation reached its ${request.performance.jobTimeoutMinutes}-minute total budget; approved questions were retained`),
      { code: 'GENERATION_BUDGET' }));
  }) };
}

/** The sources and the draft may have gone while the job waited in the queue. */
async function baseOfRun({ prep: { sources, previous }, host }) {
  const latest = await host.read();
  if (sources.some(source => !latest.sources.some(current => current.id === source.id))) throw new Error(EXECUTE.sourcesGone);
  const base = previous ? get(latest.drafts, previous.id, NOT_FOUND_LABEL.draft) : null;
  if (base && base.draftVersion !== previous.draftVersion) throw new Error(EXECUTE.draftChangedInQueue);
  return { latest, base };
}

/** One round, up to the point its failure is decided on. A single job is as it always was: the failure is the job's. A coverage run settles the round unless it is a
    stop, or a first round that left no draft behind. */
async function runOneRound(run, ctx, begun) {
  const { job, plan, controller, clock } = run;
  if (plan) clock.arm();
  let failure = null;
  try { run.deck = await stepOfRound(run, ctx, begun.fresh); } catch (error) { failure = error; }
  const timedOut = clock.timedOut(failure);
  if (plan) clock.disarm();
  if (failure && (!plan || controller.signal.aborted || !job.draftId)) throw failure;
  return { failure, timedOut };
}

/** The rounds. What the run ended on, or null for a plain run. */
async function runRounds(run, first) {
  const { plan, control, controller } = run;
  let ctx = first;
  // Paused before the first round (asked while the sections were being weighed): the first round waits for the learner.
  if (plan) await control.waitIfPaused(controller.signal);
  for (;;) {
    controller.signal.throwIfAborted();
    const begun = await beginRound(run, ctx), { failure, timedOut } = await runOneRound(run, ctx, begun);
    if (!plan) return null;
    const asked = { ctx, ...begun, failure, timedOut };
    const next = await nextOfRound(run, asked, await settleRound(run, asked));
    if (next.final) return next.final;
    ctx = next.ctx;
  }
}

async function work(run) {
  const { latest, base } = await baseOfRun(run);
  run.latest = latest;
  const asked = await firstRoundOf(run);
  startMarker(run);
  await finishRun(run, await runRounds(run, firstContext(run, { base, latest, ...asked })));
}

/** What always happens as a run ends. What a finished run really used, per stage, next to what was estimated: the next estimate learns from it. Awaited, so the library
    folder is quiet when the job ends; never a reason to fail the job. */
async function cleanUp(run, { timer, letGoOfHold }) {
  const { job, plan, clock, prep, host } = run;
  timer?.clear();
  letGoOfHold?.();
  clock.clear();
  host.work.generationControllers.delete(job.id);
  host.work.generationMessengers.delete(job.id);
  host.work.jobControls.delete(job.id);
  run.control.close();
  host.work.jobOutputs.endJob(job.id);
  delete job.fills;
  if (job.status === 'complete' && job.estimate?.stageTotals && !plan) await calibrationFor(prep.root).record({ stageTotals: job.estimate.stageTotals,
    actual: observedByStage(job) }).catch(() => {});
  job.finishedAt = new Date().toISOString();
  if (!host.managed) host.announce(job);
}

export const executorOf = (prep, host) => async ({ job, control, controller, models, runId = job.id, checkpoint, commit, plans }) => {
  const { plan } = prep;
  const run = { job, control, controller, models, runId, checkpoint, commit, plans, plan, prep, host, savedVersion: undefined };
  if (controller.signal.aborted) { cancelledInQueue(run); return; }
  run.clock = createRoundClock({ job, controller, plan, roundMs: host.coverage?.roundTimeoutMs ?? job.totalTimeoutSeconds * 1000 });
  run.book = createRunBook(run);
  const clocks = startClocks(run);
  job.status = 'running';
  // The run clock (the console's elapsed time) starts here, once the library's queue has let the job in; a retry or a continuation is a job of its own.
  job.runStartedAt ??= new Date().toISOString();
  job.stage = 'Writing source-grounded questions';
  try { await work(run); } catch (error) { await failRun(run, error); } finally { await cleanUp(run, clocks); }
};
