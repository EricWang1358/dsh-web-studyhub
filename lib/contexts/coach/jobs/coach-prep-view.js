import { PREP_MESSAGES } from './messages.js';

/** What the old task of a batch showed, kept as fields of the Job record so `job.status` and the card projection read one place. */
export const PREP_FIELDS = Object.freeze(['label', 'cardIds', 'message', 'listedIn']);
/** A batch is a part of the day's row of the 任务 console, never a row of its own (lib/job-status.js isOwnRow). */
export const PREP_ROW = 'coach-daily';

const ENDED = ['complete', 'failed', 'cancelled', 'interrupted'];

/** The presentation reader of one batch: wording from the attempt's own state (`report` is the batch report the ledger keeps, `message` its outcome). */
export function presentPrep(input, state) {
  return observed => {
    const { status, error } = observed, total = input.batch.length;
    const text = status === 'complete' ? state.message : status === 'cancelled' ? PREP_MESSAGES.cancelled : error ? error.message
      : status === 'queued' ? PREP_MESSAGES.queued : PREP_MESSAGES.writing;
    return {
      title: PREP_MESSAGES.label(total),
      stage: { code: `coach.prep.${status}`, text },
      progress: { done: Math.min(state.report.passed ?? 0, total), total, unit: 'cards', percent: null, segments: [] },
      legacy: { label: PREP_MESSAGES.label(total), cardIds: input.cardIds, message: ENDED.includes(status) ? text : '', listedIn: PREP_ROW },
    };
  };
}
