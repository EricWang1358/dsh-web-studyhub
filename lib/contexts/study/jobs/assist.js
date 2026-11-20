import { ASSIST } from '../settings.js';
import { addUsage, totalTokens } from '../../../token-usage.js';
import { outsideUsageScope, withUsageSink } from '../../../usage-scope.js';
import { ASSIST_FIELDS, assistLegacyId, presentAssist } from './assist-view.js';
import { ASSIST_MESSAGES } from './messages.js';

export const ASSIST_KIND = 'assist';
/** A model call is the answer (`assist`) or its one repair; a host teacher's turn is observed as the host's own attempt, never as a model request of ours. */
const POLICY = Object.freeze({ feature: 'coach', requestedEffort: 'default', executionMode: 'direct' });
const PURPOSES = Object.freeze({ assist: 'other', repair: 'repair', child: 'other' });

/** One request of the learner's assistant. The task list the panel reads, the validation, the digest guard and the atomic save stay with the assistant
 * (`work`, the domain's own closure over them); the host teacher (child) and its reuse stay with the host service. For `mode: 'terms'`, gateway steps
 * prefer a bounded DSH sub-agent (`agent-preferred`, falling back to direct when unavailable) and stream live output to `work.jobOutputs`.
 * Attempt-local state lives on the admission lease. */
export const assistDefinition = {
  kind: ASSIST_KIND, version: 1, title: ASSIST_MESSAGES.title, legacyFields: ASSIST_FIELDS,
  legacyId: assistLegacyId,
  initialPresentation: input => presentAssist(input, { message: '', stage: 'working' }),
  capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: false, set: false, executionModes: ['direct', 'subagent'] },

  admit(context, input) {
    const state = { message: '', stage: 'working' };
    const reader = presentAssist(input, state);
    context.present(reader);
    return { state, reader };
  },

  async run(context, input, { work, controller, outputs, resultBox }) {
    const { state, reader } = context.admission, { gateway } = context, asked = { assist: 0, repair: 0, child: 0 };
    const isTerms = input.job.mode === 'terms';
    const outputJobId = assistLegacyId(input);
    const output = outputs ? {
      open: callId => outputs.open(outputJobId, callId),
      append: (callId, text) => outputs.append(outputJobId, callId, text),
      reasoning: (callId, size) => outputs.reasoning(outputJobId, callId, size),
      close: callId => outputs.close(outputJobId, callId),
    } : undefined;
    const refresh = () => { try { context.present(reader); } catch { /* the Attempt is over */ } };
    // The assistant's own signal (clear, unload, a stale card) and the Job's are one: either stops the other.
    const stop = () => controller.abort(new Error(ASSIST_MESSAGES.cancelled));
    if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
    const policy = (role, budget) => ({
      ...POLICY,
      ...(isTerms && role !== 'child' ? { executionMode: 'agent-preferred' } : {}),
      purpose: PURPOSES[role],
      budget,
    });
    const key = role => `${role}:${++asked[role]}`;
    const execution = {
      ask: (system, payload, role = 'assist') => {
        if (isTerms) {
          state.stage = role === 'repair' ? 'repair' : 'working';
          refresh();
        }
        const labels = isTerms ? { stage: role === 'repair' ? 'terms-repair' : 'terms' } : {};
        return gateway.step(
          key(role),
          policy(role, { timeoutMs: ASSIST.timeoutMs, maxOutputTokens: ASSIST.maxTokens }),
          { labels, ...(output ? { output } : {}) },
        ).complete(system, payload);
      },
      child: (run, attribution) => {
        const turn = gateway.step(key('child'), policy('child', null));
        return turn.run(() => turn.observe({ boundary: 'host-attempt', runner: 'subagent' }, async (_signal, call) => {
          let usage = null, usageCalls = 0;
          const capture = { key: 'assist-child', sink: (reported, meta) => {
            const { calls: _calls, ...buckets } = addUsage(usage || {}, reported);
            usage = buckets;
            const n = Number(meta?.calls);
            usageCalls += Number.isSafeInteger(n) && n > 0 ? n : 1;
          } };
          try {
            const value = await withUsageSink(capture, () => run(), { feature: POLICY.feature });
            return { value, ...attribution(), ...(usage ? { tokenUsage: usage, usageCalls } : {}) };
          } finally {
            if (usage) { call.tokenUsage = usage; call.tokens = totalTokens(usage); if (usageCalls > 0) call.usageCalls = usageCalls; }
          }
        }));
      },
    };
    try {
      const result = await outsideUsageScope(() => work(execution));
      state.message = result.message;
      if (resultBox && result && typeof result === 'object') {
        if (result.outcome) resultBox.outcome = result.outcome;
        if (result.cardId) resultBox.cardId = result.cardId;
      }
      return { refs: [{ kind: 'card', id: input.job.cardId }], completeness: 'complete' };
    } finally {
      outputs?.endJob?.(outputJobId);
    }
  },
};
