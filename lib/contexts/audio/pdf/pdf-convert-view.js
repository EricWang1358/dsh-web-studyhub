import { jobContract } from '../../../job-contract.js';

/** The fields the panel, the history and the notices have always read from a conversion's job record. */
export const PDF_FIELDS = Object.freeze(['convertId', 'filename', 'route', 'converter', 'tier', 'env', 'service', 'phase', 'done', 'total', 'chunk', 'chunks', 'warnings', 'note',
  'fingerprint', 'courses', 'language', 'sourceIds', 'documentId', 'skippedPages', 'local', 'liveness', 'errorCode', 'retryable']);

const sourceIdsOf = result => result.refs.filter(ref => ref.kind === 'source').map(ref => ref.id);

/** The job record of the panel for one observed lifecycle laid over the attempt's working card. The card keeps its own `id` (the conversion's folder and history row are
 * named by it) and `status`; what the panel is told is the Job's. */
export const viewOf = (card, observed) => ({ ...card, id: observed.legacyId, convertId: card.id, status: observed.status, startedAt: observed.startedAt,
  finishedAt: observed.finishedAt,
  sourceIds: sourceIdsOf(observed.result), retryable: observed.status === 'complete' ? false : card.retryable ?? true });

/** The kernel's presentation reader for one conversion. `card.runtimeId` is the id the Job has in the job list (it changes with a retry). */
export function presentPdf(card) {
  return observed => {
    card.runtimeId = observed.legacyId;
    const view = viewOf(card, observed), projected = jobContract(view);
    return { title: projected.title, stage: projected.stage, progress: projected.progress, detail: projected.detail,
      legacy: Object.fromEntries(PDF_FIELDS.filter(key => view[key] !== undefined).map(key => [key, view[key]])), events: projected.events };
  };
}
