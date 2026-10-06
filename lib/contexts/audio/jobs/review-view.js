import { LEGACY_AUDIO_TYPE } from '../../../audio-runtime-common.js';
import { AUDIO_TEXT, reviewName } from '../../../audio-messages.js';
import { presentAudio } from './view.js';

/** Card fields existing readers (tools, inbox, audio page, console) keep reading from a review. */
export const REVIEW_FIELDS = Object.freeze(['filename', 'review', 'reviewKey', 'phase', 'done', 'total', 'warnings', 'sourceIds', 'summary', 'retryable', 'language',
  'textProvider', 'usage', 'usageRun']);

/** The working card of one attempt: a text job of the audio family, keyed by the transcript it reviews so it is not reviewed twice at once. */
export const reviewView = ({ title, sourceId }, { language, settings }) => ({ type: LEGACY_AUDIO_TYPE, filename: reviewName(title), reviewKey: sourceId,
  review: { applied: 0, rejected: 0, unsure: 0 }, phase: 'proofread', stage: AUDIO_TEXT.reviewStage, done: 0, total: 0, language, textProvider: settings.textProvider, warnings: [] });

export const presentReview = view => presentAudio(view, { fields: REVIEW_FIELDS });
