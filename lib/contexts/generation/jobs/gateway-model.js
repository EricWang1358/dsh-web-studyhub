import { unifyCall } from '../../../job-calls.js';
import { EFFORT_PREFERENCES, FOLLOW_EFFORT } from '../../../model-effort.js';
import { effortKey, effortStageOf } from '../../../stage-effort.js';
import { GENERATION_TIMEOUT_MS, SECTION_WEIGHT_TIMEOUT_MS } from '../../../generation-limits.js';
import { LIMITS } from '../../../jobs/limits.js';
import { stepKeyOf } from './step-identity.js';
import { replyCounts } from '../../../call-counts.js';
import { modelOfKey } from '../../../job-model.js';

const count = value => (Number.isInteger(value) && value >= 1 ? value : undefined);
const labelsOf = ({ stage, part, slot, round, retry, waitedMs }) => Object.fromEntries(Object.entries({
  stage: typeof stage === 'string' ? stage.slice(0, LIMITS.stepLabelLength) : undefined, part: count(part), slot: count(slot),
  round: count(round), retry: count(retry), queuedMs: Number.isFinite(waitedMs) ? Math.round(waitedMs) : undefined,
}).filter(([, value]) => value !== undefined));

/** How a generation run asks its model when the runtime runs it: every call is a step of the runtime's gateway, which owns the reasoning
 * level, the execution mode and the usage of the call. The section weights use the host's light lane. The executor sees the same two functions as with legacy-model.js.
 * `refresh()` re-reads the record into the card after each call (the executor reads the tally and the steps from it). */
export function gatewayModels({ gateway, control, performance, feature, outputs, jobId, refresh }) {
  // The level the learner set for the stage this call belongs to; anything else follows the session's level, as the legacy path did.
  const effortOf = stage => {
    const wanted = stage && (control.values[effortKey(stage)] ?? performance[effortKey(stage)]);
    return EFFORT_PREFERENCES.includes(wanted) ? wanted : FOLLOW_EFFORT;
  };
  const sink = {
    open: callId => outputs.open(jobId(), callId), append: (callId, text) => outputs.append(jobId(), callId, text),
    reasoning: (callId, size) => outputs.reasoning(jobId(), callId, size), close: callId => outputs.close(jobId(), callId),
  };
  const policyOf = (purpose, call) => call.light
    ? { purpose, feature: call.feature ?? feature, requestedEffort: 'default', executionMode: 'direct', budget: { timeoutMs: SECTION_WEIGHT_TIMEOUT_MS } }
    : { purpose, feature: call.feature ?? feature, requestedEffort: effortOf(effortStageOf(call.stage)), executionMode: 'agent-preferred',
      budget: { timeoutMs: GENERATION_TIMEOUT_MS } };

  // One gateway step per call; the host model the gateway uses is already prepared like every other model call (language, local content).
  // The model the learner chose for this run (lib/job-model.js), read as the call starts; the light lane keeps the host's.
  const ask = async (system, prompt, call) => {
    const purpose = unifyCall({ stage: call.stage, kind: call.kind }).kind, chosen = call.light ? null : modelOfKey(control.values.model);
    const options = { labels: labelsOf(call), output: sink, signal: call.signal, counted: reply => replyCounts(purpose, reply),
      ...(call.light ? { model: 'light' } : {}), ...(chosen ? { route: chosen } : {}) };
    const step = gateway.step(stepKeyOf({ ...call, purpose }), policyOf(purpose, call), options);
    try { return await step.complete(system, prompt); } finally { refresh(); }
  };

  return {
    call: (system, prompt, context) => ask(system, prompt, context),
    weigh: (system, prompt, context) => ask(system, prompt, { ...context, kind: 'plan', unit: 'weights', light: true }),
  };
}
