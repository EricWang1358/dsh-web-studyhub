import { LEGACY_AUDIO_TYPE } from '../../../audio-runtime-common.js';
import { AUDIO_TEXT } from '../../../audio-messages.js';
import { subtitleKey } from '../../../subtitle-job.js';
import { presentAudio } from './view.js';

/** Card fields existing readers (tools, inbox, audio page, console) keep reading from a subtitle import. */
export const SUBTITLE_FIELDS = Object.freeze(['filename', 'subtitle', 'subtitleKey', 'phase', 'done', 'total', 'steps', 'warnings', 'sourceIds', 'usage', 'usageRun',
  'retryable', 'language', 'parallel', 'minutes', 'chunks', 'titleEn', 'partCount', 'corrected', 'uncertain', 'reused', 'textProvider']);

/** The working card of one attempt: a text job of the audio family (no transcription), keyed by its content so the same file is not imported twice at once. */
export function subtitleView(plan, { language, settings }) {
  return { type: LEGACY_AUDIO_TYPE, subtitle: true, subtitleKey: subtitleKey(plan), filename: plan.filename, phase: 'proofread', stage: AUDIO_TEXT.subtitleStage,
    minutes: Math.round(plan.seconds / 6) / 10, chunks: 1, language, textProvider: settings.textProvider, warnings: [] };
}

export const presentSubtitle = view => presentAudio(view, { fields: SUBTITLE_FIELDS });
