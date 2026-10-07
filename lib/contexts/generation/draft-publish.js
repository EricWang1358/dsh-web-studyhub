import { createHash } from 'node:crypto';
import { get, id } from '../../util.js';
import { publicationTarget } from '../../bank-import.js';
import { recordEvent } from '../../job-calls.js';
import { featureOf } from '../../model-usage.js';
import { startGeneration } from './jobs/submit-generation.js';
import { PUBLISH_STEP } from './jobs/publish-reconcile.js';
import { PUBLISH_TEXT } from './jobs/messages.js';

/* 发布草稿 (`draft.publish.start`): the pre-publication review of the draft's cards and, when they pass, the one write that puts them into a deck. The job is queued by
   jobs/submit-generation.js like every generation job. Behind `runtime.pilot.generationPublish` (needs `generation`) it is a job of the unified runtime:
     1. the check (`draft.publish.plan`) asks its reviews through the gateway, and finds what the write will leave in the library; behind `generationRestart` the plan is kept on disk;
     2. the write is a commit of the runtime (`commit`): written down as pending before it is done, and - after a crash - looked at again, never done twice (publish-reconcile.js).
   Without the switch the job is exactly what it was: one `draft.publish` call that reviews and writes. */

// The reviews of a publication are the authoring context's work, and the usage summary has always told them so (not question writing).
const REVIEW_FEATURE = featureOf('authoring', 'draft.publish');
const digestOf = cardIds => createHash('sha256').update(JSON.stringify(cardIds)).digest('hex').slice(0, 12);
/** The receipt of a write as the job keeps it: small and plain, so it can sit in the runtime's record. */
const receiptOf = result => ({ id: result.id, deckId: result.deckId ?? null, accepted: result.accepted, rejected: result.rejected, added: result.added ?? 0, total: result.total ?? null,
  autoReviewed: result.autoReviewed ?? 0, unchecked: result.unchecked ?? 0, remainingDraftId: result.rejectedDraft?.id ?? null });

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
  job.stage = receipt.rejected ? `已发布 ${receipt.accepted} 题；${receipt.rejected} 题留在草稿待处理` : `已发布 ${receipt.accepted} 题`;
  if (receipt.recovered) {
    job.recovered = true;
    job.stage = `${PUBLISH_TEXT.recovered}；${job.stage}`;
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
    if (args.draftVersion !== draft.draftVersion) throw new Error('草稿已更新，请重新打开后再发布');
    if ([...jobs.values()].some(job => job.root === storagePort.root && job.draftId === draft.id && activeJob(job) && !own(job))) throw new Error('这份草稿已有后台任务，请等待完成');
    pruneJobs();
    const root = storagePort.root;
    const ahead = [...jobs.values()].filter(job => job.root === root && activeJob(job) && !own(job)).length;
    const job = { id: id(), root, type: 'draft-publish', draftId: draft.id, deckTitle: draft.title, ...(target ? { mergeTargetId: target.id } : {}),
      sourceIds: [...new Set(draft.cards.flatMap(card => (card.citations || []).map(ref => ref.sourceId)))],
      status: ahead ? 'queued' : 'running', stage: ahead ? '等待前一个学习任务' : '正在检查发布条件',
      count: draft.cards.length, reviewed: 0, startedAt: new Date().toISOString() };
    job.language = language;

    const execute = async ({ job, controller, models, commit, plans }) => {
      job.status = 'running';
      job.stage = '正在检查发布条件';
      try {
        controller.signal.throwIfAborted();
        const base = { id: draft.id, draftVersion: draft.draftVersion, ...(target ? { mergeTargetId: target.id } : {}), publishJobId: job.id };
        const onProgress = ({ reviewed, total }) => { job.reviewed = reviewed; job.count = total; job.stage = `发布前逐卡复审 ${reviewed}/${total}`; };
        if (!managed) {
          const result = await providedCall('draft.publish', { ...base, onProgress });
          applyReceipt(job, receiptOf(result));
          return;
        }
        // The same batch asked twice (its reply could not be read) is told apart by how many times it was asked.
        const asked = new Map();
        const ask = (system, prompt, { cardIds }) => {
          const key = digestOf(cardIds), retry = asked.get(key) ?? 0;
          asked.set(key, retry + 1);
          return models.call(system, prompt, { stage: 'Publication review', kind: 'review', unit: 'publish', card: key, retry, signal: controller.signal });
        };
        const plan = await planned({ base, ask, onProgress, plans, draft });
        const write = async decided => receiptOf(await providedCall('draft.publish', { ...base, planned: true, publishDecision: decided.decision }));
        applyReceipt(job, commit ? await commit(PUBLISH_STEP, async () => plan, { publish: write }) : await write(plan));
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

  /** The check of the publication; one that an earlier Attempt already made (and kept) is not paid for again while the draft and the deck are what they were. */
  async function planned({ base, ask, onProgress, plans, draft }) {
    const kept = await plans?.load();
    if (kept) {
      const state = await storagePort.read(), target = publicationTarget(state, get(state.drafts, draft.id, 'Draft'), base);
      if (kept.expect.draftId === draft.id && kept.expect.draftVersion === draft.draftVersion && (kept.expect.before?.contentVersion ?? null) === (target ? target.contentVersion || 0 : null)) return kept;
    }
    const plan = { ...await providedCall('draft.publish.plan', { ...base, ask, onProgress }), deckTitle: draft.title };
    await plans?.save(plan);
    return plan;
  }

  /** A later Attempt of the same job (a retry, or after a restart). A write the runtime has already seen through (the commit is complete, perhaps because looking at the library showed it
   * had happened) is not prepared again: the draft is gone by then. */
  async function prepareAgain({ args, runId, persistence }) {
    const done = (await persistence?.store.load())?.commits.find(commit => commit.stepKey === PUBLISH_STEP && commit.status === 'complete');
    if (!done) return (await prepare(args, { self: runId })).task;
    const seed = { id: id(), root: storagePort.root, type: 'draft-publish', draftId: args.id, deckTitle: (await persistence.plan?.load())?.deckTitle ?? '', status: 'running', stage: '', count: 0, reviewed: 0, startedAt: new Date().toISOString(), language };
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
