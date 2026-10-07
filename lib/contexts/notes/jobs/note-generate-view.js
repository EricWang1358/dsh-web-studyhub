import { NOTE_MESSAGES } from './messages.js';

/** What `job.status` and the card projection read from the Job record; `written` also carries the outcome back to the entry. */
export const NOTE_FIELDS = Object.freeze(['noteId', 'generationId', 'written']);

/** The presentation reader of one draft; `state` is the attempt's own (whether it wrote the note). The same reader describes the Job before its first turn. */
export function presentNote(input, state) {
  const { job } = input;
  return observed => {
    const { status, error } = observed;
    const text = status === 'queued' ? NOTE_MESSAGES.queued : status === 'running' ? NOTE_MESSAGES.writing : status === 'failed' ? error?.message ?? ''
      : status === 'complete' && !state.written ? NOTE_MESSAGES.partial : NOTE_MESSAGES[status] ?? '';
    return {
      title: job.title,
      stage: { code: `notes.draft.${status}`, text },
      progress: { done: status === 'complete' ? 1 : 0, total: 1, unit: 'drafts', percent: null, segments: [] },
      legacy: { noteId: job.noteId, generationId: job.jobId, written: state.written },
    };
  };
}
