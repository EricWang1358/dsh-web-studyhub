import { get, id } from '../../util.js';
import { publicationTarget } from '../../bank-import.js';
import { recordEvent } from '../../job-calls.js';
import { startGeneration } from './jobs/submit-generation.js';
import { PUBLISH_STEP } from './jobs/publish-reconcile.js';
import { REVIEW_FEATURE, publishDraft, receiptOf } from './jobs/publish-step.js';
import { PUBLISH_TEXT } from './jobs/messages.js';

/* The publication of a draft (`draft.publish.start`): the pre-publication review of the draft's cards and, when they pass, the one write that puts them into a deck. The job is queued by
   jobs/submit-generation.js like every generation job. Behind `runtime.pilot.generationPublish` (needs `generation`) it is a job of the unified runtime:
     1. the check (`draft.publish.plan`) asks its reviews through the gateway, and finds what the write will leave in the library; behind `generationRestart` the plan is kept on disk;
     2. the write is a commit of the runtime (`commit`): written down as pending before it is done, and - after a crash - looked at again, never done twice (publish-reconcile.js).
   Without the switch the job is exactly what it was: one `draft.publish` call that reviews and writes. */

/** What the card says once the write is known (what the legacy job always said). */
function applyReceipt(job, receipt) {
  job.status = 'complete';
  job.publishedId = receipt.id;
  job.deckId = receipt.deckId;
  job.added = receipt.added;
  job.total = receipt.total;
  job.accepted = receipt.accepted;
  job.rejected = receipt.rejected;
  job.rejectedDraftId = receipt.remainingDraftId || null;
  job.stage = receipt.rejected ? PUBLISH_TEXT.publishedSome(receipt.accepted, receipt.rejected) : PUBLISH_TEXT.published(receipt.accepted);
  if (receipt.recovered) {
    job.recovered = true;
    job.stage = PUBLISH_TEXT.recoveredStage(job.stage);
    recordEvent(job, { level: 'info', code: 'publish-recovered', args: { deckId: receipt.deckId, accepted: receipt.accepted, added: receipt.added } });
  }
}

/** `env`: how a prepared run is queued (operations.js); `managed`: whether this family's switch routes it through the runtime. */
export function createDraftPublish(ports, { env, managed }) {
  const { state: storagePort, call: providedCall, announceJob, language } = ports;
  const { jobs, generationControllers, jobOutputs } = ports.work;
  const { activeJob, pruneJobs } = ports.jobServices;
  const publishEnv = { ...env, managed, prepare: request => prepareAgain(request) };

  /** The run for `args` ({ id, draftVersion, mergeTargetId? }), ready to queue. `self`: the logical job that is preparing again, which is not its own rival. */
  async function prepare(args, { self } = {}) {
    const own = job => self !== undefined && job.contract?.jobId === self;
    const state = await storagePort.read();
    const draft = get(state.drafts, args.id, 'Draft');
    const target = publicationTarget(state, draft, args);
    if (args.draftVersion !== draft.draftVersion) throw new Error(PUBLISH_TEXT.draftStale);
    if ([...jobs.values()].some(job => job.root === storagePort.root && job.draftId === draft.id && activeJob(job) && !own(job))) throw new Error(PUBLISH_TEXT.busy);
    pruneJobs();
    const root = storagePort.root;
    const ahead = [...jobs.values()].filter(job => job.root === root && activeJob(job) && !own(job)).length;
    const job = { id: id(), root, type: 'draft-publish', draftId: draft.id, deckTitle: draft.title, ...(target ? { mergeTargetId: target.id } : {}),
      sourceIds: [...new Set(draft.cards.flatMap(card => (card.citations || []).map(ref => ref.sourceId)))],
      status: ahead ? 'queued' : 'running', stage: ahead ? PUBLISH_TEXT.waiting : PUBLISH_TEXT.checking,
      count: draft.cards.length, reviewed: 0, startedAt: new Date().toISOString() };
    job.language = language;

    const execute = async ({ job, controller, models, commit, plans }) => {
      job.status = 'running';
      job.stage = PUBLISH_TEXT.checking;
      try {
        controller.signal.throwIfAborted();
        const base = { id: draft.id, draftVersion: draft.draftVersion, ...(target ? { mergeTargetId: target.id } : {}), publishJobId: job.id };
        const onProgress = ({ reviewed, total }) => { job.reviewed = reviewed; job.count = total; job.stage = PUBLISH_TEXT.reviewing(reviewed, total); };
        if (!managed) {
          const result = await providedCall('draft.publish', { ...base, onProgress });
          applyReceipt(job, receiptOf(result));
          return;
        }
        applyReceipt(job, await publishDraft({ call: providedCall, read: storagePort.read, models, signal: controller.signal, commit, plans, base, draft, onProgress }));
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.stage = error.message;
      } finally {
        generationControllers.delete(job.id);
        jobOutputs.endJob(job.id);
        job.finishedAt = new Date().toISOString();
        announceJob(job);
      }
    };
    const task = { kind: 'draft-publish', args, root, seed: job, execute, models: { performance: {}, feature: REVIEW_FEATURE } };
    return { task, ahead };
  }

  /** A later Attempt of the same job (a retry, or after a restart). A write the runtime has already seen through (the commit is complete, perhaps because looking at the library showed it
   * had happened) is not prepared again: the draft is gone by then. */
  async function prepareAgain({ args, runId, persistence }) {
    const done = (await persistence?.store.load())?.commits.find(commit => commit.stepKey === PUBLISH_STEP && commit.status === 'complete');
    if (!done) return (await prepare(args, { self: runId })).task;
    const seed = { id: id(), root: storagePort.root, type: 'draft-publish', draftId: args.id, deckTitle: (await persistence.plan?.load(PUBLISH_STEP))?.deckTitle ?? '', status: 'running', stage: '', count: 0, reviewed: 0, startedAt: new Date().toISOString(), language };
    const execute = async ({ job }) => { try { applyReceipt(job, done.receipt); } finally { job.finishedAt = new Date().toISOString(); jobOutputs.endJob(job.id); announceJob(job); } };
    return { kind: 'draft-publish', args, root: storagePort.root, seed, execute, models: { performance: {}, feature: REVIEW_FEATURE } };
  }

  /** Queue the publication of `args` ({ id, draftVersion, mergeTargetId? }). */
  async function start(a) {
    const { task } = await prepare(a);
    const status = task.seed.status;
    const started = await startGeneration(publishEnv, task);
    return { jobId: started.jobId, draftId: a.id, status };
  }

  return { start, prepareAgain };
}
