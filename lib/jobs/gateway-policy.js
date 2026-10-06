import { isEffortPreference, reasoningFor, FOLLOW_EFFORT } from '../model-effort.js';
import { effortRoute, plainRoute } from '../reasoning-effort.js';
import { LIMITS } from './limits.js';

/* What a gateway step may ask for: its policy, its labels and the reasoning level it is sent on. Pure validation plus the one level resolution. */

export const failure = code => Object.assign(new Error(code), { code });
const modes = ['direct', 'agent-preferred', 'agent-required'];
const POLICY_KEYS = ['purpose', 'feature', 'requestedEffort', 'executionMode', 'budget'];
const BUDGET_KEYS = ['timeoutMs', 'maxOutputTokens'];
// 'light': the host's light lane (lowest-latency route with its own hedge/transient retry), direct execution only.
export const MODEL_LANES = ['default', 'light'];
const TEXT_LABELS = ['stage', 'file'], COUNT_LABELS = ['part', 'parts', 'slot', 'inputChars', 'round', 'retry', 'queuedMs'];
const policyWord = text => typeof text === 'string' && text.length > 0 && text.length <= LIMITS.policyWordLength;
const budgetEntry = ([key, count]) => BUDGET_KEYS.includes(key) && Number.isSafeInteger(count) && count > 0 && (key !== 'timeoutMs' || count <= LIMITS.maxTimerMs);
export const labelValid = ([key, value]) => TEXT_LABELS.includes(key) ? typeof value === 'string' && value.length <= LIMITS.stepLabelLength
  : COUNT_LABELS.includes(key) && Number.isSafeInteger(value) && value >= 0;
// A model policy carries both model fields; a non-model step (process, transfer, ingest) carries neither and can never start a model call.
const modelFieldsValid = value => !Object.hasOwn(value, 'requestedEffort') && !Object.hasOwn(value, 'executionMode')
  || ((isEffortPreference(value.requestedEffort) || value.requestedEffort === FOLLOW_EFFORT) && modes.includes(value.executionMode));
export function policyOf(value) {
  if (!value || Object.keys(value).some(key => !POLICY_KEYS.includes(key)) || !['purpose', 'feature'].every(key => policyWord(value[key])) ||
      !modelFieldsValid(value) || !Object.hasOwn(value, 'budget')) throw failure('invalid-gateway-policy');
  if (value.budget !== null && (!value.budget || typeof value.budget !== 'object' || Array.isArray(value.budget) ||
      !Object.entries(value.budget).every(budgetEntry))) throw failure('invalid-gateway-policy');
  return structuredClone(value);
}

/** The route a call is sent on and the level chosen for it: the level the call asked for, or (follow) the learner's generation level
 * riding on the host route. The route is sent without that marker, so the chosen level is not replaced a second time downstream. */
export async function levelFor(ctx, route, requested, signal) {
  if (requested === FOLLOW_EFFORT) { const followed = await effortRoute(ctx, route, signal); return { selected: followed, choice: { id: followed?.reasoningEffort } }; }
  const choice = await reasoningFor(ctx, route, requested, signal);
  return { selected: { ...plainRoute(route), reasoningEffort: choice.id }, choice };
}

// The light lane keeps its own lowest level; a higher preference is named for it (its non-hedged path), as callers always did.
export const lightRequest = (request, { requestedEffort }) => (['default', 'lowest'].includes(requestedEffort) ? request : { ...request, reasoningEffort: requestedEffort });
