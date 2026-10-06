import { RECAP_BATCH_SIZE } from '../daily-generation.js';
import { RECAP_MESSAGES } from './messages.js';

/** What `job.status` and the card projection read from the Job record; `written` and `letter` also carry the outcome to the entry and the settled-event sink. */
export const RECAP_FIELDS = Object.freeze(['noteId', 'generationId', 'phase', 'written', 'letter']);
const batchCount = group => Math.ceil(group.questions.length / RECAP_BATCH_SIZE);

/** The presentation reader of one generation; `state` is the attempt's own (progress the domain reported, the letter it asked for, whether it wrote). */
export function presentRecap(input, state) {
  const { job } = input, total = batchCount(job.group);
  return observed => {
    const { status, error } = observed, phase = state.progress?.phase;
    const text = status === 'queued' ? RECAP_MESSAGES.queued : status === 'running' ? RECAP_MESSAGES[phase] ?? RECAP_MESSAGES.explaining
      : status === 'failed' ? error?.message ?? '' : status === 'complete' && !state.written ? RECAP_MESSAGES.partial : RECAP_MESSAGES[status] ?? '';
    return {
      title: job.title,
      stage: { code: `notes.recap.${status === 'running' ? phase ?? 'explaining' : status}`, text },
      progress: { done: Math.min(state.progress?.completed ?? 0, total), total, unit: 'batches', percent: null, segments: [] },
      legacy: { noteId: job.noteId, generationId: job.id, phase: phase ?? null, written: state.written, letter: state.letter },
    };
  };
}
