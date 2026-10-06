import { modelFailureMessage } from '../../../model-retry.js';
import { gatewayModel } from '../../../gateway-model.js';
import { PREP_FIELDS, presentPrep } from './coach-prep-view.js';
import { PREP_MESSAGES } from './messages.js';

export const PREP_KIND = 'coach-prep';
const PREP_STEP = 'variants:1';
/** One batch is one model call. Effort is the day's setting (lowest unless the learner raised it); the host's light path keeps its own time limit. */
const prepPolicy = options => ({ purpose: 'prep', feature: 'coach', requestedEffort: options.reasoningEffort ?? 'lowest', executionMode: 'direct', budget: null });

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
    const complete = gatewayModel(context.gateway, { stepKey: PREP_STEP, policyFor: prepPolicy }, worker.gatewayLight);
    try {
      state.message = await worker.writePrepared(input.batch, { complete, id: context.jobId, signal: context.signal, report: state.report });
    } catch (error) {
      state.message = context.signal.aborted ? PREP_MESSAGES.cancelled : modelFailureMessage(error);
      throw Object.assign(new Error(state.message), error?.code ? { code: error.code } : {});
    }
    return { refs: [], completeness: 'complete' };
  },
};
