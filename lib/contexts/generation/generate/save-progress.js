import { mergeContinuedDraft } from '../../../bank-import.js';
import { coverageForDraft } from '../../../coverage-state.js';
import { settleShort } from '../run-state.js';
import { CASE } from './messages.js';

/* A save of the draft of a run. Every save carries what was asked, which run saved it, and (for a coverage run) the plan and the marker: the draft is the checkpoint. */

const notated = (produced, request) => ({ ...produced, editorial: { ...produced.editorial,
  generation: { ...produced.editorial?.generation, notation: request.notation, notationResolved: request.notationResolved } } });

/** What the draft was asked and which run saved it (a continued draft is the base's, so this is written after the merge): jobs/input-ref.js, jobs/resume-args.js. */
function stamped(updated, { runId, prep }) {
  const generation = { ...updated.editorial.generation, inputRef: prep.inputRef, runId };
  return { ...updated, editorial: { ...updated.editorial, generation } };
}

/** A part is a draft of the whole DOCUMENT (its coverage is the document's, lib/coverage-state.js), whichever sources this round was written from, and it says which
    deck it is for. */
function ofPart(updated, part) {
  if (!part) return updated;
  return { ...updated, editorial: { ...updated.editorial, part: { deckId: part.deck.id, n: part.n }, generation: { ...updated.editorial.generation, sourceIds: part.sourceIds } } };
}

/** The plan of a coverage run and the state of its rounds travel with every save of the round. */
function withRunState(updated, plan) {
  if (plan?.spec) return { ...updated, editorial: { ...updated.editorial, coverageSpec: plan.spec, coverageRun: plan.marker } };
  return { ...updated, editorial: settleShort(updated.editorial, updated.cards.length, new Date().toISOString()) };
}

/** A case paper's scenario becomes a material before the draft that cites it. An earlier Attempt of this run may have added it and been cut short before the draft: that
    material is replaced, never duplicated. */
async function withScenario(updated, { host, prep }) {
  const pending = updated.case?.pendingScenario;
  if (!pending) return updated;
  const stored = (await host.read()).sources.find(source => source.id === pending.id);
  if (stored && stored.text !== pending.text) await host.call('source.remove', { id: pending.id });
  if (!stored || stored.text !== pending.text) await host.call('source.add', { id: pending.id, title: host.say(...CASE.sourceTitle(pending.title)), text: pending.text,
    courses: prep.request.course ? [prep.request.course] : [] });
  const { pendingScenario: _pending, ...meta } = updated.case;
  return { ...updated, case: meta };
}

/** `ctx`: the round's { base, mergeSources }. Saves what the pipeline `produced`, as the pipeline saves as it goes and once more at the end. */
export const saverOf = (run, ctx) => async (produced) => {
  const { job, plan, prep, host, book } = run;
  const { base, mergeSources } = ctx, { request, extraIds, part } = prep;
  const deck = notated(produced, request);
  let updated = base ? mergeContinuedDraft(base, deck, mergeSources, extraIds ? { addSourceIds: extraIds, requested: job.requestedTotal } : {}) : deck;
  updated = withRunState(ofPart(stamped(updated, run), part), plan);
  updated = await withScenario(updated, run);
  if (run.savedVersion !== undefined && !(await host.read()).drafts.some(draft => draft.id === updated.id)) throw new Error('Generation draft was removed; refusing to recreate it');
  // Reserve the draft identity before its commit becomes visible to another request; publication must see the active producer.
  job.draftId = updated.id;
  const saved = await host.call('draft.save', { deck: { ...updated, ...(run.savedVersion === undefined ? {} : { draftVersion: run.savedVersion }) },
    requireExisting: run.savedVersion !== undefined });
  run.savedVersion = saved.draftVersion;
  job.draftId = saved.id;
  job.deckTitle = saved.title;
  job.savedCount = saved.cards.length;
  await run.checkpoint?.(saved);
  // The coverage the run shows follows the questions as they are saved (at most every few seconds: it reads the whole material), not only the round boundaries.
  if (plan?.spec && Date.now() - (plan.percentAt || 0) > 3000) {
    plan.percentAt = Date.now();
    try { book.seen(coverageForDraft(await host.read(), saved)); book.syncRun(); } catch { /* the number is a convenience */ }
  }
};
