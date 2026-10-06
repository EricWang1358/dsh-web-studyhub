import { modelFailureMessage } from '../../../model-retry.js';
import { PREP_FIELDS, presentPrep } from './coach-prep-view.js';
import { PREP_MESSAGES } from './messages.js';

export const PREP_KIND = 'coach-prep';
const PREP_STEP = 'variants:1';
/** One batch is one model call on the host's light lane (hedged, one transient retry, its own time limit). The effort is the day's setting (lowest unless
 * the learner raised it) and the reply cap is the one the variants asked for; every call is its own Step run of the same key. */
const lightStep = gateway => (system, prompt, { reasoningEffort = 'lowest', maxTokens } = {}) => gateway.step(PREP_STEP,
  { purpose: 'prep', feature: 'coach', requestedEffort: reasoningEffort, executionMode: 'direct', budget: maxTokens ? { maxOutputTokens: maxTokens } : null },
  { model: 'light' }).complete(system, prompt);

/** One batch of variants for the day's wrong cards. The queue (one batch after another per library) and the day's ledger stay the coach's own;
 * this Job is what runs the batch: its stop signal, its Call and its usage. Attempt-local state lives on the admission lease. */
export const coachPrepDefinition = {
  kind: PREP_KIND, version: 1, title: PREP_MESSAGES.title, legacyFields: PREP_FIELDS,
  capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct'] },

  admit(context, input) {
    const state = { report: {}, message: '' };
    context.present(presentPrep(input, state));
    return { state };
  },

  async run(context, input, { worker }) {
    const { state } = context.admission;
    try {
      state.message = await worker.writePrepared(input.batch, { complete: lightStep(context.gateway), id: context.jobId, signal: context.signal, report: state.report });
    } catch (error) {
      state.message = context.signal.aborted ? PREP_MESSAGES.cancelled : modelFailureMessage(error);
      throw Object.assign(new Error(state.message), error?.code ? { code: error.code } : {});
    }
    return { refs: [], completeness: 'complete' };
  },
};
