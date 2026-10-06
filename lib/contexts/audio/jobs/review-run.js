import { executeReviewJob, reviewTarget } from '../../../audio-review.js';
import { textJobModel } from './text-model.js';

/**
 * One attempt at reviewing a transcript's unsure fixes, a batch of them at a time through the gateway's text model. Each batch is written into the
 * transcript (every volume of the import) before the next is asked, so a stop or a failure keeps what was decided and a retry asks only for what is
 * still pending: the pending items are read from the library, not from the job.
 */
export async function runReview(context, { worker, work }) {
  const { view, settings, input } = context.admission.state, store = worker.audioStore;
  const ids = reviewTarget(await store.read(), input.sourceId).ids;
  const model = textJobModel(context, { worker, work }, { view, settings, paidOnly: input.paidOnly });
  try { await executeReviewJob({ job: view, store, sourceId: input.sourceId, complete: model.complete, vocabulary: input.vocabulary, signal: context.signal }); }
  finally { model.finish(); }
  return { refs: ids.map(id => ({ kind: 'source', id })), completeness: 'complete' };
}
