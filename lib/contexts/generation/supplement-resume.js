import { id } from '../../util.js';
import { recordEvent } from '../../job-calls.js';
import { supplementPublication } from '../../runtime/jobs.js';
import { PUBLISH_STEPS } from './jobs/publish-reconcile.js';
import { PUBLISH_TEXT, SUPPLEMENT_TEXT } from './jobs/messages.js';
import { publishDraft } from './jobs/publish-step.js';

/* A top-up of a deck ends with one publication: the questions the run approved go into the target deck. A run that was cut short after that write is not run again, and one that
   was cut short before it has only the write left to do. A later Attempt of a supplement asks here first (behind `generationPublish`, for a run kept on disk):
     - the runtime has seen the write through (its commit is complete, perhaps because looking at the library showed it had happened): the Attempt only reports it;
     - the run's draft is complete and not yet published: the Attempt publishes it (and nothing else);
     - otherwise: nothing for this module to do, and the run goes on from its draft as before. */

/** What the card of a supplement says once its publication is known (what the run itself says when it publishes). */
export function applySupplementReceipt(job, receipt, title) {
  job.publication = { deckId: receipt.deckId, added: receipt.added, total: receipt.total, accepted: receipt.accepted, rejected: receipt.rejected, remainingDraftId: receipt.remainingDraftId };
  if (receipt.remainingDraftId) job.draftId = receipt.remainingDraftId; else delete job.draftId;
  job.status = 'complete';
  job.stage = SUPPLEMENT_TEXT.added(receipt.added, title, receipt.total);
  if (receipt.recovered) {
    job.recovered = true;
    job.stage = PUBLISH_TEXT.recoveredStage(job.stage);
    recordEvent(job, { level: 'info', code: 'publish-recovered', args: { deckId: receipt.deckId, accepted: receipt.accepted, added: receipt.added } });
  }
}

export function createSupplementResume(ports, { env }) {
  const { state: storagePort, call, language } = ports;
  const { generationControllers, jobOutputs } = ports.work;

  /** The card of a supplement that is only being finished: the target, what was asked and what was kept, from what the run left. */
  const seedOf = ({ args, meta, draft, title }) => ({ id: id(), root: storagePort.root, type: 'supplement', mergeTargetId: args.deckId, targetTitle: meta?.targetTitle ?? title ?? '',
    deckTitle: meta?.targetTitle ?? title ?? '', sourceIds: meta?.sourceIds ?? args.sourceIds ?? [], kind: meta?.kind ?? args.kind ?? 'flashcard', count: meta?.count ?? args.count ?? 0,
    requestedTotal: meta?.requestedTotal ?? draft?.editorial?.requested ?? 0, savedCount: meta?.savedCount ?? draft?.cards.length ?? 0, parts: 1, steps: [], messages: [],
    ...(draft ? { draftId: draft.id } : {}), status: 'running', stage: SUPPLEMENT_TEXT.finishing, startedAt: new Date().toISOString(), language });
  // Only a runtime Attempt finishes this way: the runtime's session sink announces the result, so the task does not.
  const settle = job => { generationControllers.delete(job.id); jobOutputs.endJob(job.id); job.finishedAt = new Date().toISOString(); };

  /** The task a later Attempt of the supplement `runId` should run instead of the whole run, or null. */
  async function taskFor({ args, runId, persistence }) {
    const state = await storagePort.read(), title = state.decks.find(deck => deck.id === args.deckId)?.title;
    const stored = await persistence?.store.load();
    const done = stored?.commits.find(commit => PUBLISH_STEPS.includes(commit.stepKey) && commit.status === 'complete');
    if (done) {
      const meta = (await persistence.plan?.load(done.stepKey))?.meta;
      const execute = async ({ job }) => { try { applySupplementReceipt(job, done.receipt, meta?.targetTitle ?? title); } finally { settle(job); } };
      return { kind: 'supplement', args, root: storagePort.root, seed: seedOf({ args, meta, title }), execute, models: { performance: {}, feature: env.feature } };
    }
    const draft = state.drafts.find(item => item.editorial?.generation?.runId === runId);
    const whole = draft && draft.mergeTargetId === args.deckId && draft.cards.length >= (draft.editorial?.requested ?? Infinity) && draft.cards.length > 0;
    if (!whole) return null;
    const execute = async ({ job, controller, models, commit, plans }) => {
      job.status = 'running';
      try {
        controller.signal.throwIfAborted();
        const base = { id: draft.id, draftVersion: draft.draftVersion, mergeTargetId: args.deckId, requireReviewed: true, [supplementPublication]: job.id };
        const receipt = await publishDraft({ call, read: storagePort.read, models, signal: controller.signal, commit, plans, base,
          draft: { id: draft.id, draftVersion: draft.draftVersion, title: draft.title }, meta: { targetTitle: title, sourceIds: job.sourceIds, kind: job.kind, count: job.count, requestedTotal: job.requestedTotal, savedCount: job.savedCount } });
        if (receipt.deckId !== args.deckId) throw new Error(SUPPLEMENT_TEXT.nothingAdded);
        applySupplementReceipt(job, receipt, title);
      } catch (error) {
        job.status = controller.signal.aborted && job.cancelRequestedAt ? 'cancelled' : 'failed';
        job.stage = error.message;
      } finally { settle(job); }
    };
    return { kind: 'supplement', args, root: storagePort.root, seed: seedOf({ args, draft, title }), execute, models: { performance: {}, feature: env.feature } };
  }

  return { taskFor };
}
