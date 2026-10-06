import { INDEX_TEXT } from '../../../../retrieval-messages.js';
import { ALL_COURSES } from '../index-plan.js';

export const INDEX_KIND = 'retrieval-index';
/** Logical states in which a build still holds the library's one slot. */
export const ACTIVE_STATUSES = Object.freeze(['queued', 'running', 'cancelling']);
const FAILED_SHOWN = 10;
const RUN_STATUS = Object.freeze({ queued: 'running', running: 'running', cancelling: 'running', complete: 'complete', cancelled: 'cancelled',
  failed: 'failed', interrupted: 'failed' });
const END_PHASE = Object.freeze({ complete: 'done', cancelled: 'cancelled', failed: 'failed', interrupted: 'failed' });

/** What one Attempt knows while it runs. The run writes it, the presentation reads it; it lives on the admission lease. */
export const newRunState = course => ({ course, phase: 'preparing', done: 0, total: 0, unchanged: 0, firstRun: false, summary: null, prepared: null,
  inFlight: null, unconfirmed: [], unsaved: false });

const phaseOf = (state, status) => END_PHASE[status] || state.phase;
const percentOf = (state, status) => status === 'complete' ? 100 : state.total > 0 ? Math.floor(state.done * 100 / state.total) : null;

/** The kernel's presentation reader for one build. */
export function presentIndex(state) {
  return observed => {
    const phase = phaseOf(state, observed.status), { summary } = state;
    return { title: INDEX_TEXT.title(state.course),
      stage: { code: `retrieval.${phase}`, args: { done: state.done, total: state.total }, text: INDEX_TEXT.stage(phase, state) },
      progress: { done: state.done, total: state.total || null, unit: 'pages', percent: percentOf(state, observed.status), segments: [] },
      detail: { index: { course: state.course, phase, unchanged: state.unchanged, firstRun: state.firstRun, added: summary?.added ?? 0, removed: summary?.removed ?? 0,
        failed: (summary?.failed ?? []).slice(0, FAILED_SHOWN), failedCount: summary?.failed.length ?? 0, unconfirmed: state.unconfirmed } } };
  };
}

/** The shape retrieval.index.status has always answered, read from the job's public contract. `fallback` fills what an unadmitted build does not know yet. */
export function runView(contract, fallback = {}) {
  const index = { ...fallback, ...contract.detail.index };
  return { runId: contract.runtime.legacyId, course: index.course ?? ALL_COURSES, status: RUN_STATUS[contract.status], stage: index.phase ?? 'preparing',
    done: contract.progress.done, total: contract.progress.total ?? index.total ?? 0, added: index.added ?? 0, removed: index.removed ?? 0, unchanged: index.unchanged ?? 0,
    failed: index.failed ?? [], failedCount: index.failedCount ?? 0, firstRun: index.firstRun ?? false, startedAt: contract.startedAt ?? fallback.startedAt,
    ...(contract.finishedAt ? { finishedAt: contract.finishedAt } : {}), ...(index.unconfirmed?.length ? { unconfirmed: index.unconfirmed.map(item => item.id) } : {}),
    ...(contract.error ? { error: String(contract.error.message).slice(0, 400), ...(contract.error.code ? { errorCode: contract.error.code } : {}) } : {}) };
}
