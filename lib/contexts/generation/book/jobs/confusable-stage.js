import { policyOf } from '../../inventory/policy.js';
import { assembleConfusables, planConfusables } from '../confusables/plan.js';
import { confusablePrompt } from '../confusables/prompt.js';
import { readConfusables } from '../confusables/read.js';

/* The confusable pairs of a build (#710 S3), after the term cards: the pairs of cards the book calls opposite or parallel (book/confusables/plan.js) that have no
   comparison written from the same words get one, CONFUSABLE_PAIRS to a call, in the attempt's one pool. The comparisons are set on `work.confusables` for the save.
   A call that failed leaves its pairs out (counted as missed: the Job ends partial, the book is saved, the next build asks only them). Nothing to compare: no call. */

/** The comparisons this build keeps and writes: [{ items, print, rows }], none when the book has no pair. */
export async function confusableStage(ctx, work) {
  const { plan, state, show, parallel } = ctx, confusables = planConfusables(work.items, { language: plan.language, previous: plan.previous?.courseNotes.confusables });
  Object.assign(state.confusables, { done: 0, total: confusables.batches.length });
  const written = new Map(), policy = policyOf('confusables', plan.efforts);
  if (confusables.batches.length) { state.stage = 'confusables'; show(); }
  await parallel.each(confusables.batches, async batch => {
    const answer = await parallel.ask(batch.key, { stage: 'confusables', part: batch.number, parts: confusables.batches.length }, policy, confusablePrompt(batch, plan),
      text => readConfusables(text, batch));
    batch.pairs.forEach((pair, at) => {
      const rows = answer?.get(at);
      if (rows) { written.set(pair.key, rows); state.confusables.made++; } else state.missed++;
    });
    state.confusables.done++; show();
  }, 'confusables');
  const record = assembleConfusables(confusables, written);
  if (record.length) work.confusables = record;
}
