import { capEffortDownward } from '../../inventory/policy.js';

/** Every model call of a build is a Step of the gateway: direct, the learner's own model, usage booked under `other`. */
const POLICY = Object.freeze({ purpose: 'plan', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });
const REASK = '\n\nYour previous reply could not be read. Reply with the JSON only, exactly in the shape described.';
const stepKey = (key, tries) => tries === 0 ? key : tries === 1 ? `${key}:r` : `${key}:r${tries}`;

/**
 * The `ask` of one attempt: one model step, answered from `kept.results` when the same call finished before (a resume, or a retry of this Job), else asked.
 * An answer that cannot be read is asked once more; a provider error (a throw) is asked once more too; `settle` turns a readable answer into what is kept.
 * @returns what `settle` made, or null when the model gave no readable answer twice.
 * `feature`: the usage feature its calls are booked under (the outline and the review book book `book`, the answer card of a case question `case`), else `other`.
 * `requestedEffort` / `lightRoute`: optional defaults (and per-call downward-only overrides via 6th arg) for mechanical extraction/merge steps.
 */
export function makeAsk(context, kept, state, { feature, requestedEffort, lightRoute, callTimeoutSeconds = 0 } = {}) {
  const budget = callTimeoutSeconds > 0 ? { timeoutMs: callTimeoutSeconds * 1000 } : null;
  const basePolicy = feature || requestedEffort || budget
    ? Object.freeze({ ...POLICY, ...(feature ? { feature } : {}), ...(requestedEffort ? { requestedEffort } : {}), ...(budget ? { budget } : {}) })
    : POLICY;
  return async function ask(key, labels, { system, prompt }, read, settle, callOptions = {}) {
    const nextEffort = callOptions?.requestedEffort ? capEffortDownward(basePolicy.requestedEffort, callOptions.requestedEffort) : basePolicy.requestedEffort;
    const policy = nextEffort !== basePolicy.requestedEffort ? Object.freeze({ ...basePolicy, requestedEffort: nextEffort }) : basePolicy;
    const route = callOptions?.lightRoute ?? lightRoute;
    const stepOptions = route ? { labels, lightRoute: route } : { labels };
    if (kept.results.has(key)) { await context.gateway.step(key, policy, { labels }).reuse('kept'); state.reused++; return kept.results.get(key); }
    let unreadable = 0, threw = 0, tries = 0;
    while (unreadable < 2) {
      context.signal.throwIfAborted();
      let text;
      try {
        text = await context.gateway.step(stepKey(key, tries++), policy, stepOptions).complete(system, unreadable ? `${prompt}${REASK}` : prompt);
      } catch (error) {
        // A stop or a spent per-call timeout is never asked again; a transient provider error once.
        if (context.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'call-timeout' || threw++ >= 1) throw error;
        continue;
      }
      const parsed = read(text);
      if (parsed) { const settled = await settle(parsed); kept.results.set(key, settled); return settled; }
      unreadable++;
    }
    return null;
  };
}
