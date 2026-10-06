import { LEGACY_AUDIO_TYPE } from '../../../audio-runtime-common.js';
import { AUDIO_TEXT } from '../../../audio-messages.js';
import { presentAudio } from './view.js';

/** Card fields existing readers (tools, inbox, audio page, console) keep reading from a class save. */
export const LIVE_SAVE_FIELDS = Object.freeze(['filename', 'liveKey', 'phase', 'done', 'total', 'steps', 'warnings', 'sourceIds', 'usage', 'usageRun', 'retryable',
  'language', 'parallel', 'minutes', 'chunks', 'titleEn', 'partCount', 'corrected', 'uncertain', 'reused', 'textProvider']);

/** The working card of one attempt: a text job of the audio family, keyed by the class it saves so one class is not saved twice at once. */
export const liveSaveView = (plan, { language, settings }) => ({ type: LEGACY_AUDIO_TYPE, filename: plan.session.title, liveKey: plan.session.id, phase: 'proofread',
  stage: AUDIO_TEXT.liveSaveStage, minutes: Math.round(plan.session.elapsedMs / 6000) / 10, chunks: 1, language, textProvider: settings.textProvider, warnings: [] });

export const presentLiveSave = view => presentAudio(view, { fields: LIVE_SAVE_FIELDS });
