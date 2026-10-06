import { runDailyGeneration } from '../daily-generation.js';
import { RECAP_FIELDS, presentRecap } from './daily-recap-view.js';
import { recapModel } from './recap-step.js';
import { RECAP_MESSAGES } from './messages.js';

export const RECAP_KIND = 'daily-recap';

/** One generation of a day's recap. The note, its revision/fingerprint/fragments and the replace-or-protect rules stay with notes (runDailyGeneration);
 * this Job runs it: its stop signal, its Calls and usage, and its letter, sent when the Job settles. Attempt-local state lives on the admission lease. */
export function createDailyRecapDefinition({ sendLetter }) {
  return {
    kind: RECAP_KIND, version: 1, title: RECAP_MESSAGES.title, legacyFields: RECAP_FIELDS,
    capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct'] },
    // A letter that cannot be written never changes how the generation ended (the note is already committed).
    notifications: [{ channel: 'inbox', deliver: (_event, view) => view.detail.legacy?.letter && sendLetter(view.detail.legacy.letter) }],

    admit(context, input) {
      const state = { progress: null, letter: null, written: false };
      context.present(presentRecap(input, state));
      return { state };
    },

    async run(context, input, { worker, pending }) {
      const { state } = context.admission;
      const job = { ...input.job, signal: context.signal, pending, letter: letter => { state.letter = letter; },
        onProgress: progress => { state.progress = progress; context.progress({ done: progress.completed, total: progress.total, unit: 'batches' }); } };
      const { written, error } = await runDailyGeneration({ store: worker.store, complete: recapModel(context.gateway), language: worker.language, job });
      state.written = written;
      if (error) throw error;
      return written ? { refs: [{ kind: 'note', id: job.noteId }], completeness: 'complete' } : { refs: [], completeness: 'partial' };
    },
  };
}
