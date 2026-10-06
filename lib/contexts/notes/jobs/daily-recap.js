import { runDailyGeneration } from '../daily-generation.js';
import { RECAP_FIELDS, presentRecap } from './daily-recap-view.js';
import { preferAgent } from '../../../jobs/gateway-policy.js';
import { RECAP_MESSAGES } from './messages.js';

export const RECAP_KIND = 'daily-recap';
/** Every model call of a generation is a Step of the gateway, direct (the plain recap path has no effort of its own). */
const RECAP_POLICY = Object.freeze({ purpose: 'other', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });

/** One generation of a day's recap. The note, its revision/fingerprint/fragments and the replace-or-protect rules stay with notes (runDailyGeneration);
 * this Job runs it: its stop signal, its Calls and usage, and its letter, sent when the Job settles. Attempt-local state lives on the admission lease. */
export function createDailyRecapDefinition({ sendLetter }) {
  return {
    kind: RECAP_KIND, version: 1, title: RECAP_MESSAGES.title, legacyFields: RECAP_FIELDS,
    capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct', 'subagent'] },
    // A letter that cannot be written never changes how the generation ended (the note is already committed).
    notifications: [{ channel: 'inbox', deliver: (_event, view) => view.detail.legacy?.letter && sendLetter(view.detail.legacy.letter) }],

    admit(context, input) {
      const state = { progress: null, letter: null, written: false };
      context.present(presentRecap(input, state));
      return { state };
    },

    async run(context, input, { worker, pending, agent }) {
      const { state } = context.admission;
      const job = { ...input.job, signal: context.signal, pending, letter: letter => { state.letter = letter; },
        onProgress: progress => { state.progress = progress; context.progress({ done: progress.completed, total: progress.total, unit: 'batches' }); } };
      // The domain asks as it always did, `(system, prompt)`; the Steps are numbered in the order it asks.
      let calls = 0;
      // `agent` (the submitter's reading of `runtime.pilot.dailyRecapAgent`) makes the calls prefer a host sub-agent.
      const policy = preferAgent(RECAP_POLICY, agent);
      const complete = (system, prompt) => context.gateway.step(`recap:${++calls}`, policy).complete(system, prompt);
      const { written, error } = await runDailyGeneration({ store: worker.store, complete, language: worker.language, job });
      state.written = written;
      if (error) throw error;
      return written ? { refs: [{ kind: 'note', id: job.noteId }], completeness: 'complete' } : { refs: [], completeness: 'partial' };
    },
  };
}
