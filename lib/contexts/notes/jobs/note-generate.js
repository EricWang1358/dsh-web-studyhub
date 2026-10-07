import { runNoteGeneration } from '../note-generation.js';
import { NOTE_FIELDS, presentNote } from './note-generate-view.js';
import { NOTE_MESSAGES } from './messages.js';

export const NOTE_KIND = 'note-generate';
/** The one model call of a draft is a Step of the gateway, direct (a note draft has no effort of its own). */
const NOTE_POLICY = Object.freeze({ purpose: 'other', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });

/** One AI draft of a note. The note, its revision guard and what the note says about the draft stay with notes (runNoteGeneration);
 * this Job runs it: its stop signal, its Call and usage. The note-draft letter is written by the domain when the draft is saved,
 * so there is nothing to send when the Job settles. */
export const noteGenerateDefinition = {
  kind: NOTE_KIND, version: 1, title: NOTE_MESSAGES.title, legacyFields: NOTE_FIELDS,
  capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct'] },
  // Whole the moment submit returns: a second start, the list and the status find the draft in the same turn.
  initialPresentation: input => presentNote(input, { written: false }),

  admit(context, input) {
    const state = { written: false };
    context.present(presentNote(input, state));
    return { state };
  },

  async run(context, input, { worker }) {
    const { state } = context.admission;
    const job = { ...input.job, signal: context.signal };
    const complete = (system, prompt) => context.gateway.step('note:1', NOTE_POLICY).complete(system, prompt);
    const { written, error } = await runNoteGeneration({ store: worker.store, complete, job });
    state.written = written;
    if (error) throw error;
    context.signal.throwIfAborted();
    return written ? { refs: [{ kind: 'note', id: job.noteId }], completeness: 'complete' } : { refs: [], completeness: 'partial' };
  },
};
