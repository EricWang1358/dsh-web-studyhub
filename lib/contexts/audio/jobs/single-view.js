import { LEGACY_AUDIO_TYPE } from '../../../audio-runtime-common.js';
import { presentAudio } from './view.js';

/** Card fields existing readers (tools, inbox, audio page) keep reading from a single import. */
export const SINGLE_FIELDS = Object.freeze(['filename', 'singleId', 'phase', 'done', 'total', 'steps', 'warnings', 'sourceIds', 'usage', 'usageRun',
  'retryable', 'language', 'parallel', 'pace', 'minutes', 'chunks', 'estimatedUsd', 'titleEn', 'partCount', 'corrected', 'uncertain', 'reused',
  'diagnostics', 'textProvider', 'vocabulary']);

/** The working card the shared pipeline updates while one recording is processed. */
export function singleView(record, { singleId, language }) {
  return { ...record.job, type: LEGACY_AUDIO_TYPE, singleId, warnings: [...(record.job.warnings || [])], language };
}

/** Presentation reader for the kernel: observed lifecycle + working card → public view. */
export const presentSingle = view => presentAudio(view, { fields: SINGLE_FIELDS });
