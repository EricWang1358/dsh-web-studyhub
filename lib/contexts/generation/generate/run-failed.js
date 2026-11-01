import { canContinueDraft } from '../../../draft-continuation.js';
import { recordEvent } from '../../../job-calls.js';
import { endOfRun } from '../run-end.js';
import { publishIntoTarget } from './run-finish.js';
import { EXECUTE } from './messages.js';

/* A run that ended by an error or a stop: what `endOfRun` decides, carried out on the job and the draft. */

/** A coverage run that ends this way (the learner stopped it, a failure that repeating cannot fix) leaves the draft saying so: the rounds done stay done, the round in
    flight is not left "running".
    Whatever stopped the round (a refused key, the time limit, a model failure), the draft is the checkpoint: the continue action goes on from the next round that is not done. */
async function stopInDraft({ job, plan, book, clock }, end) {
  try {
    book.moved({ type: 'round-stopped', tokens: book.tokensNow() - (plan.tokensBefore || 0), ms: clock.workedMs(), reason: end.stop.roundReason, uncovered: plan.uncovered });
    book.stopRun(end.stop.reason, end.stop.extra);
    if (end.retryAfterStop) job.retryable = true;
    await book.persist();
  } catch { /* the draft may be gone; the job still ends */ }
}

/** A top-up of one round (no plan) that ended before it was done asked for `kept + this round's questions`, a number of its own: once it has ended the number of
    questions is the draft's one (what it
    was asked for, or what it holds), the number the banner, the row and the draft page say (lib/shortfall.js), so the console says the same. */
async function readAsked({ job, host }) {
  try {
    const kept = (await host.read()).drafts.find(item => item.id === job.draftId);
    if (kept) job.requestedTotal = Math.max(Number.isInteger(kept.editorial?.requested) ? kept.editorial.requested : 0, kept.cards.length);
  } catch { /* the draft may be gone */ }
}

/** A plain run (a count, no plan) that ended before it was done and kept a draft is continued, not started again: it makes the questions it was asked for and did not
    get, with its own settings. */
async function offerContinue({ job, host }) {
  try {
    const kept = (await host.read()).drafts.find(item => item.id === job.draftId);
    if (kept && canContinueDraft(kept)) job.retryable = true;
  } catch { /* the draft may be gone */ }
}

async function publishWhatPassed(run) {
  const { job, prep: { target } } = run;
  job.status = 'running';
  try {
    await publishIntoTarget(run, true);
    job.status = 'complete';
    job.stage = `Time budget reached; added ${job.publication.added}/${job.requestedTotal} requested questions to ${target.title}; total ${job.publication.total}`;
  } catch (error) {
    job.status = job.cancelRequestedAt ? 'cancelled' : 'failed';
    job.stage = `Time budget reached; checkpoint publication blocked: ${error.message}`;
  }
}

const endFacts = ({ job, plan, controller, prep }, error) => ({ error, aborted: controller.signal.aborted, abortCode: controller.signal.reason?.code,
  cancelRequested: !!job.cancelRequestedAt, planStarted: !!plan?.started,
  hasSpec: !!plan?.spec, stopped: !!plan?.marker?.stop, hasDraft: !!job.draftId, hasPlan: !!plan, covering: !!prep.covering, publishTarget: prep.publishTarget,
    retryable: !!job.retryable, savedCount: job.savedCount });

export async function failRun(run, error) {
  const { job, plan, controller, host } = run;
  const end = endOfRun(endFacts(run, error));
  job.status = end.status;
  job.stage = controller.signal.aborted ? controller.signal.reason.message : error.message;
  // The host stopped under a coverage run (the plugin was unloaded, the app is closing): nobody stopped it and nothing failed. The draft is left as it is (its marker
  // says the run was running, the round in
  // flight is run again) and the job is INTERRUPTED with the continue action, exactly what the next start would restore from the draft (coverage.recover).
  if (end.status === 'interrupted') {
    job.retryable = true;
    job.stage = host.say(...EXECUTE.interrupted);
    recordEvent(job, { level: 'error', code: 'run-interrupted', args: { round: plan.round, rounds: plan.spec?.rounds?.length ?? 0 } });
  }
  if (end.stop) await stopInDraft(run, end);
  if (end.readAsked) await readAsked(run);
  if (end.offerContinue) await offerContinue(run);
  if (end.publishWhatPassed) await publishWhatPassed(run);
}
