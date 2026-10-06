import { assertTextModel } from '../../../audio-job.js';
import { reviewNotice } from '../../../audio-messages.js';
import { writeLetter } from './notifications.js';
import { audioFacade } from './view.js';
import { presentReview, reviewView, REVIEW_FIELDS } from './review-view.js';
import { runReview } from './review-run.js';

/**
 * A second look at the fixes proofreading was unsure about, as a job of the unified runtime. The input is the transcript already in the library, so
 * nothing is kept for a restart: the pending items are recomputed from the library whenever the review is asked for again. It can be retried while the
 * process lives; it cannot be paused or recovered. Its letter and announcement are written by the services of whoever submitted it.
 */
export const reviewDefinition = {
  kind: 'audio-review', version: 1, title: 'Transcript review', legacyFields: REVIEW_FIELDS,
  capabilities: { cancel: true, set: false, retry: true, pauseMode: 'unsupported', recoveryMode: 'none', executionModes: ['direct', 'subagent'] },
  notifications: [
    { channel: 'inbox', deliver: (_event, contract, { worker }) => writeLetter(worker, audioFacade(contract)) },
    { channel: 'session', deliver: (_event, contract, { worker }) => worker.notify?.(reviewNotice(audioFacade(contract), contract.detail.legacy?.language)) },
  ],

  async admit(context, input, { worker }) {
    const settings = await worker.audioSettings();
    assertTextModel(settings, worker.complete);
    const view = reviewView(input, { language: worker.language, settings });
    context.present(presentReview(view));
    return { state: { view, settings, input } };
  },

  run: (context, _input, binding) => runReview(context, binding),
};
