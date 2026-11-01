import { generateBatched } from '../../../batch.js';
import { boundedGuidance } from '../../../case-study.js';
import { recordEvent, recordWait } from '../../../job-calls.js';
import { mergePlanTargets } from '../../../plan-targets.js';
import { existingFor } from './estimate.js';
import { saverOf } from './save-progress.js';

/* One step of the pipeline for one round: every model call of the round goes through `callOf`, what the pipeline reports goes on the card. */

/** One model call. The signal is read when the call is made: the job's, or the round's own when the run has a time limit per round. */
const callOf = ({ job, plan, models, clock }) => async (system, prompt, context = {}) => {
  const { signal } = clock;
  signal.throwIfAborted();
  const notes = job.messages.map(message => message.text);
  return models.call(system,
    notes.length ? `${prompt}\n\nAdditional learner requirements (apply within the requested schema and source evidence):\n${JSON.stringify(notes)}` : prompt,
    { ...context, stage: context.stage || job.stage, signal, ...(plan ? { round: plan.round } : {}) });
};

/** A 429 back-off is a dashed bar on the job's timeline and a line of its log. */
const onWaitOf = job => wait => {
  recordWait(job, wait);
  if (wait.phase === 'start') recordEvent(job, { level: 'warn', code: 'rate-limit', args: { slot: wait.slot, seconds: Math.max(1, Math.round(wait.ms / 1000)) } });
};

/** The provider answered 429: the run slowed down (or sped up again); the card says so. */
const onThrottleOf = job => event => {
  const before = job.throttle || { events: 0, lowest: event.configured };
  job.throttle = { events: before.events + (event.reason === 'rate-limit' ? 1 : 0), concurrency: event.concurrency, configured: event.configured,
    lowest: Math.min(before.lowest, event.concurrency) };
  recordEvent(job, { level: event.reason === 'rate-limit' ? 'warn' : 'info', code: 'throttle', args: { reason: event.reason, concurrency: event.concurrency,
    configured: event.configured } });
};

/** Where the pipeline stands. A part that is filling its gap says which round and how many are still missing (the card shows the newest). */
const onStageOf = ({ job, controller }) => (stage, context) => {
  if (!controller.signal.aborted) job.stage = context?.part ? `Parallel generation · up to ${job.concurrency} batches` : stage;
  if (!context?.part || context.fill === undefined) return;
  job.fills ||= {};
  if (context.fill) job.fills[context.part] = context.fill; else delete job.fills[context.part];
};

const caseOptions = ({ prep, runId }, fresh) => {
  const { request } = prep;
  if (!request.case) return {};
  return { case: { ...request.case, guidance: boundedGuidance(fresh.sources.filter(source => request.case.guidanceSourceIds.includes(source.id))) },
    scenarioSourceId: `scenario-${runId}` };
};

export async function stepOfRound(run, ctx, fresh) {
  const { job, plan, control, clock, prep, host, book } = run;
  const { request, coverageRun, target } = prep;
  run.savedVersion = ctx.base?.draftVersion;
  const saveProgress = saverOf(run, ctx);
  const deck = await generateBatched(callOf(run), {
    ...request,
    notation: request.notationResolved,
    ...caseOptions(run, fresh),
    signal: clock.signal,
    control,
    onWait: onWaitOf(job),
    // The knowledge points the plan lists, and what became of each (lib/plan-targets.js): the job keeps a compact copy for the console; a round of a coverage run
    // replaces only its own.
    onTargets: record => { job.planTargets = mergePlanTargets(job.planTargets, plan?.round, record); book.syncRun(); },
    onThrottle: onThrottleOf(job),
    count: ctx.count,
    sources: ctx.sources,
    ...(ctx.assignments ? { assignments: ctx.assignments } : {}),
    ...(ctx.first && coverageRun ? { coverageLevel: coverageRun.level, coverageSpec: plan.spec } : {}),
    ...(ctx.covering ? { reuse: ctx.reuse, coverageSections: ctx.titles } : {}),
    // EXPERIMENTAL (hidden and off by default): a Jev pre-check before the independent review (lib/jev-triage.js), and, if the learner
    // chose it, Jev in place of the model for the cards it is sure about (lib/jev-review.js). Both are undefined unless switched on.
    ...(request.case ? {} : await host.experimentalHooks()),
    ...existingFor(fresh, target, ctx.base),
  }, onStageOf(run), saveProgress);
  await saveProgress(deck);
  return deck;
}
