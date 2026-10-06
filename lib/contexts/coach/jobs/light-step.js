/** One batch is one model call on the host's light lane (hedged, one transient retry, its own time limit). The effort is the day's setting (lowest unless
 * the learner raised it) and the reply cap is the one the variants asked for; every call is its own Step run of the same key. */
export const lightStep = (gateway, stepKey) => (system, prompt, { reasoningEffort = 'lowest', maxTokens } = {}) => gateway.step(stepKey,
  { purpose: 'prep', feature: 'coach', requestedEffort: reasoningEffort, executionMode: 'direct', budget: maxTokens ? { maxOutputTokens: maxTokens } : null },
  { model: 'light' }).complete(system, prompt);
