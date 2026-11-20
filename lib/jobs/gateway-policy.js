import { createHash } from 'node:crypto';
import { abortable, childError, startBoundedChild } from '../host-capabilities.js';
import { tapChildStream } from '../job-output.js';
import { isEffortPreference, reasoningFor, FOLLOW_EFFORT } from '../model-effort.js';
import { effortRoute, plainRoute } from '../reasoning-effort.js';
import { foldSessionUsage, readSessionUsage, totalTokens } from '../token-usage.js';
import { LIMITS } from './limits.js';

/* What a gateway step may ask for: its policy, its labels and the reasoning level it is sent on. Pure validation plus the one level resolution. */

export const failure = code => Object.assign(new Error(code), { code });
/** The abort reason code of a step its owner cut because the model sent nothing for too long: the Call failed ('no-output'); nobody cancelled it. */
export const SILENT_CUT = 'model-silent';
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
export const lightRequest = (request, { requestedEffort }, options = {}) => ({
  ...(['default', 'lowest'].includes(requestedEffort) ? request : { ...request, reasoningEffort: requestedEffort }),
  ...(typeof options.hedge === 'boolean' ? { hedge: options.hedge } : {}),
});

/** Stable job-scoped prompt-cache session id (<= 64 chars) for direct model calls, or undefined. */
export const jobCacheSessionId = id => {
  const raw = typeof id === 'string' ? id.trim() : '';
  return !raw ? undefined : raw.length <= 54 ? `study-job:${raw}` : `study-job:${raw.slice(0, 45)}-${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
};

/** Canonical `provider/model` label for call trace metadata when both fields are present. */
export const modelLabel = route => (route?.provider && route?.model ? `${route.provider}/${route.model}` : undefined);

/** Settle a subagent call's token usage, physical request count, and host sessionStats timing with live-session fallback. */
export async function settleSubagentCall({ ctx, handle, call, live }) {
  const stored = handle?.id ? await readSessionUsage(ctx?.get?.('sessionQuery'), handle.id) : null;
  const usageRead = stored && totalTokens(stored.usage) > 0 ? stored : live;
  const timing = stored?.timing || null;
  const usage = usageRead?.usage || null;
  const usageCalls = usageRead ? Math.max(1, Number(usageRead.requests) || 0) : 0;
  if (usage) { call.tokenUsage = usage; call.tokens = totalTokens(usage); }
  if (usageCalls > 0) call.usageCalls = usageCalls;
  if (timing) call.timing = timing;
  return { usage, usageCalls, timing };
}

/** Run one bounded subagent step, settling usage and DSH sessionStats timing before returning or rethrowing. */
export async function runSubagentStep({ capability, context, host, labels, policy, selected, choice, system, prompt, signal, call, sink, counted }) {
  let handle, untap, live;
  try {
    handle = await startBoundedChild(capability.subagents, { parent: capability.parent, label: `Study ${context.jobId.slice(0, 8)} · ${labels.stage || policy.purpose}`,
      signal, toolFilter: { allow: [] }, agentOptions: { ...selected, ...(policy.budget?.maxOutputTokens ? { maxTokens: policy.budget.maxOutputTokens } : {}) },
      prompt: [{ type: 'text', text: `${system}\n\n${prompt}` }] }, { ...capability, awaitAdmissionCleanup: true });
    call.childId = handle.id; call.parentId = capability.parent.id;
    untap = tapChildStream(host.ctx.root || host.ctx, handle.id, sink);
    const result = await abortable(handle.result, signal);
    if (result.stopReason !== 'completed') throw childError(handle, result);
    const value = result.output.filter(block => block.type === 'text').map(block => block.text).join('');
    if (!value.trim()) throw failure('empty-model-output');
    return counted({ value, childId: handle.id, parentId: capability.parent.id, appliedEffort: choice.id ?? 'default' });
  } finally {
    live = foldSessionUsage(handle?.localAgent?.session);
    untap?.();
    try { await handle?.dispose(); }
    finally { await settleSubagentCall({ ctx: host.ctx, handle, call, live }); }
  }
}

/** The policy of a function that may prefer a host sub-agent behind its own switch: with `on` its calls are `agent-preferred`
 * (the direct call is the fallback, with the reason on the Call). */
export const preferAgent = (policy, on) => (on === true ? Object.freeze({ ...policy, executionMode: 'agent-preferred' }) : policy);

/** Resolve the effective timeout budget in ms, expanding for enabled web-Gemini bridge steps when needed. */
export const stepBudgetMs = ({ light, host, record, policy, options }) => {
  const raw = !light && host?.webGemini?.stepTimeoutMs ? host.webGemini.stepTimeoutMs({ record, policy, options }) : policy.budget?.timeoutMs;
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, LIMITS.maxTimerMs) : 0;
};

/** Build the runtime step entry and composite abort signal, honoring extended web-Gemini timeouts when active. */
export function stepEntry({ state, policy, labels, context, host, light, record, options }) {
  const budgetMs = stepBudgetMs({ light, host, record, policy, options });
  const stepTimeout = budgetMs ? AbortSignal.timeout(budgetMs) : null;
  return { step: state, policy, labels: structuredClone(labels), pending: new Set(), errors: [], closed: false, budgetMs, stepTimeout,
    signal: AbortSignal.any([context.signal, ...(stepTimeout ? [stepTimeout] : []), ...(options.signal ? [options.signal] : [])]) };
}

const GENERIC_CODE = /^(SERVER|SERVER_ERROR|TRANSPORT|UNAVAILABLE|OVERLOADED|TIMEOUT|STALLED|RATE_LIMIT|EMPTY_RESPONSE)$/i;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{1,40}$/;

function safeRequestError(error) {
  const message = String(error?.message ?? ''), own = String(error?.code ?? '');
  if (own === 'MAX_TOKENS') return 'MAX_TOKENS: Model reached its output limit before answering';
  if (error?.name === 'TimeoutError') {
    const secs = /(\d+)\s*s\b/i.exec(message)?.[1];
    return secs ? `Model timed out after ${secs}s` : 'Model timed out';
  }
  if (/Model returned no text/i.test(message) || own === 'empty-model-output') return 'Model returned no text';
  const status = Number(error?.status ?? error?.statusCode) || Number(/^\s*(\d{3})\b/.exec(message)?.[1]) || null;
  const body = /"code"\s*:\s*"([^"]{1,60})"/.exec(message)?.[1];
  const code = body && SAFE_CODE.test(body) ? body : SAFE_CODE.test(own) && !GENERIC_CODE.test(own) ? own : null;
  if (/^(NO_ADAPTER|MISSING_CREDENTIAL)$/i.test(own) || /No API key|Configure a model provider/i.test(message)) return code ? `MISSING_CREDENTIAL ${code}` : 'MISSING_CREDENTIAL';
  if (/^(INVALID_CREDENTIAL|AUTHENTICATION|AUTH)$/i.test(own) || status === 401 || status === 403) return [status || 401, code || 'unauthorized'].join(' ');
  if (/^(QUOTA|ACCOUNT_QUOTA)$/i.test(own) || status === 402) return [status || 402, code || 'ACCOUNT_QUOTA'].join(' ');
  if (status === 429 || /^RATE_LIMIT$/i.test(own)) return [status || 429, code || 'RATE_LIMIT'].join(' ');
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message) || /^TRANSPORT$/i.test(own)) return 'fetch failed';
  if (status || code) return [status || (/^(SERVER|SERVER_ERROR|UNAVAILABLE|OVERLOADED)$/i.test(own) ? 503 : null), code].filter(Boolean).join(' ');
  if (/^(SERVER|SERVER_ERROR|UNAVAILABLE|OVERLOADED)$/i.test(own)) return '503 unavailable';
  return 'Model call failed';
}

/** Classify a thrown step/call error without retaining untrusted provider prose that could echo learner input. */
export function callOutcomeOf(error, entry) {
  const silent = Boolean(entry.signal.aborted && entry.signal.reason?.code === SILENT_CUT);
  const stepTimedOut = Boolean(entry.stepTimeout?.aborted) || (error?.name === 'TimeoutError' && entry.budgetMs > 0);
  if (stepTimedOut) {
    const secs = Math.max(1, Math.round(entry.budgetMs / 1000));
    const errorText = secs >= 60 && secs % 60 === 0
      ? `Call reached its ${secs / 60}-minute single-call time limit`
      : `Call reached its ${secs}-second single-call time limit`;
    return { cancelled: false, reason: 'call-timeout', timeoutSeconds: secs, error: errorText };
  }
  if (silent) {
    const mins = Math.max(1, Math.round((Number(entry.signal.reason?.ms) || 180_000) / 60_000));
    return { cancelled: false, reason: 'no-output', error: `No output for ${mins} minutes` };
  }
  if (entry.signal.aborted) return { cancelled: true, reason: 'aborted' };
  return { cancelled: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'request-failed', error: safeRequestError(error) };
}

/** Observe and run one eligible web-Gemini step, recording call timing, model label, and output stream. */
export function runWebStep({ observe, options, record, webCall, iso, system, prompt }) {
  if (!record.capabilities.executionModes.includes(webCall.runner)) throw failure('execution-mode-unsupported');
  const meta = { boundary: 'host-attempt', sideEffect: false, runner: webCall.runner, model: webCall.toolName, selectedEffort: 'web-gemini' };
  return observe(meta, async (signal, call) => {
    options.output?.open(call.callId);
    try {
      const value = await webCall.ask(system, prompt, signal);
      call.firstOutputAt ??= iso(); options.output?.append(call.callId, value);
      const counts = options.counted?.(value); if (counts) call.counts = counts;
      return { value, tokenUsage: null };
    } finally { options.output?.close(call.callId); }
  });
}
