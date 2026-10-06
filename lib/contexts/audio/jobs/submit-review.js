import { AUDIO_TEXT } from '../../../audio-messages.js';
import { startTextJob } from './submit-text.js';

export const REVIEW_KIND = 'audio-review';

/** Start the review of one transcript's unsure fixes on the runtime; the same transcript is not reviewed twice at once. */
export const startReview = (service, { sourceId, title, vocabulary, paidOnly }, running) =>
  startTextJob(service, { kind: REVIEW_KIND, input: { sourceId, title, vocabulary, paidOnly: paidOnly === true }, key: sourceId, busy: AUDIO_TEXT.reviewRunning }, running);
