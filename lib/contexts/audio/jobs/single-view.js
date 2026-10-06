import { jobContract } from '../../../job-contract.js';
import { AUDIO_TEXT, savedAs } from '../../../audio-messages.js';

/** Card fields existing readers (tools, inbox, audio page) keep reading from a single import. */
export const SINGLE_FIELDS = Object.freeze(['filename', 'singleId', 'phase', 'done', 'total', 'steps', 'warnings', 'sourceIds', 'usage', 'usageRun',
  'retryable', 'language', 'parallel', 'pace', 'minutes', 'chunks', 'estimatedUsd', 'titleEn', 'partCount', 'corrected', 'uncertain', 'reused',
  'diagnostics', 'textProvider', 'vocabulary']);

const sourceIdsOf = result => result.refs.filter(ref => ref.kind === 'source').map(ref => ref.id);

/** The working card the shared pipeline updates while one recording is processed. */
export function singleView(record, { singleId, language }) {
  return { ...record.job, type: 'audio-import', singleId, warnings: [...(record.job.warnings || [])], language };
}

const stageOf = (view, observed) => {
  if (observed.status === 'complete') return view.reused ? AUDIO_TEXT.reused : savedAs(view.sourceIds.length, view.corrected);
  if (observed.status === 'cancelled') return AUDIO_TEXT.cancelled;
  return observed.error ? observed.error.message : view.stage;
};

/** Presentation reader for the kernel: observed lifecycle + working card → public view. */
export function presentSingle(view) {
  return observed => {
    Object.assign(view, { id: observed.legacyId, status: observed.status, startedAt: observed.startedAt, finishedAt: observed.finishedAt,
      retryable: observed.status !== 'complete', sourceIds: sourceIdsOf(observed.result) });
    if (observed.status === 'complete') view.phase = 'done';
    view.stage = stageOf(view, observed);
    const projected = jobContract(view);
    return { title: projected.title, stage: projected.stage, progress: projected.progress, detail: projected.detail,
      legacy: Object.fromEntries(SINGLE_FIELDS.filter(key => view[key] !== undefined).map(key => [key, view[key]])), events: projected.events };
  };
}

/** The legacy job shape that notifications and announcements read. */
export const singleFacade = contract => ({ ...contract.detail.legacy, id: contract.runtime.legacyId, type: contract.kind,
  status: contract.status === 'interrupted' ? 'failed' : contract.status, stage: contract.error?.message || contract.stage.text || contract.stage.code,
  sourceIds: sourceIdsOf(contract.result) });
