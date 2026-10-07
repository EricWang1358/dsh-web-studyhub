import { createHash } from 'node:crypto';
import { get } from '../../../util.js';
import { publicationTarget } from '../../../bank-import.js';
import { featureOf } from '../../../model-usage.js';
import { PUBLISH_STEP } from './publish-reconcile.js';

/* The publication of a draft as a runtime job does it, for every job that publishes (the publication of a draft, the supplement's own at the end of its run):
   the check (reviews through the gateway, and what the write will leave in the library), the plan kept on disk, then the write as a commit of the runtime.
   `call(action, args)` is the context's own call to another context; `commit` is the runtime's `commitArtifact` (absent when the job is not kept on disk: the write is then
   just done). */

/** The reviews of a publication are the authoring context's work, and the usage summary has always told them so (not question writing). */
export const REVIEW_FEATURE = featureOf('authoring', 'draft.publish');
const digestOf = cardIds => createHash('sha256').update(JSON.stringify(cardIds)).digest('hex').slice(0, 12);

/** The receipt of a write as the job keeps it: small and plain, so it can sit in the runtime's record. */
export const receiptOf = result => ({ id: result.id, deckId: result.deckId ?? null, accepted: result.accepted, rejected: result.rejected, added: result.added ?? 0,
  total: result.total ?? null, autoReviewed: result.autoReviewed ?? 0, unchecked: result.unchecked ?? 0, remainingDraftId: result.rejectedDraft?.id ?? null });

/** The write as the `result` the legacy publication call answers with (what a supplement run reads). */
export const resultOfReceipt = receipt => ({ ...receipt, rejectedDraft: receipt.remainingDraftId ? { id: receipt.remainingDraftId } : undefined });

/** The check of a publication; one that an earlier Attempt already made (and kept) is not paid for again while the draft and the deck are what they were. */
async function planned({ call, read, plans, stepKey, base, ask, onProgress, draft, meta, quick }) {
  const kept = await plans?.load(stepKey);
  if (kept) {
    const state = await read(), target = publicationTarget(state, get(state.drafts, draft.id, 'Draft'), base);
    const same = kept.expect.draftId === draft.id && kept.expect.draftVersion === draft.draftVersion;
    if (same && (kept.expect.before?.contentVersion ?? null) === (target ? target.contentVersion || 0 : null)) return kept;
  }
  const plan = { ...await call('draft.publish.plan', { ...base, ...(quick ? { quick: true } : { ask, onProgress }) }), deckTitle: draft.title, meta };
  await plans?.save(stepKey, plan);
  return plan;
}

/** Publish `draft` ({ id, draftVersion, title }) with `base` (the arguments of `draft.publish`); resolves with the receipt.
 * `meta` is kept with the plan for whoever finds the write done later. */
export async function publishDraft({ call, read, models, signal, commit, plans, stepKey = PUBLISH_STEP, base, draft, onProgress, meta, quick = false }) {
  // The same batch asked twice (its reply could not be read) is told apart by how many times it was asked.
  const asked = new Map();
  const ask = (system, prompt, { cardIds }) => {
    const key = digestOf(cardIds), retry = asked.get(key) ?? 0;
    asked.set(key, retry + 1);
    return models.call(system, prompt, { stage: 'Publication review', kind: 'review', unit: stepKey, card: key, retry, feature: REVIEW_FEATURE, signal });
  };
  const plan = await planned({ call, read, plans, stepKey, base, ask, onProgress, draft, meta, quick });
  // The quick publication (a pasted case with answers) takes every question as it is: there is no review to have made and nothing to decide.
  const write = async decided => receiptOf(quick ? await call('draft.publish.quick', { id: base.id, draftVersion: base.draftVersion })
    : await call('draft.publish', { ...base, planned: true, publishDecision: decided.decision }));
  return commit ? commit(stepKey, async () => plan, { publish: write }) : write(plan);
}
