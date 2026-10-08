/** Every model call of a build is a Step of the gateway: direct, the learner's own model, usage booked under `other`. */
const POLICY = Object.freeze({ purpose: 'plan', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });
const REASK = '\n\nYour previous reply could not be read. Reply with the JSON only, exactly in the shape described.';
const stepKey = (key, tries) => tries === 0 ? key : tries === 1 ? `${key}:r` : `${key}:r${tries}`;

/**
 * The `ask` of one attempt: one model step, answered from `kept.results` when the same call finished before (a resume, or a retry of this Job), else asked.
 * An answer that cannot be read is asked once more; a provider error (a throw) is asked once more too; `settle` turns a readable answer into what is kept.
 * @returns what `settle` made, or null when the model gave no readable answer twice.
 */
export function makeAsk(context, kept, state) {
  return async function ask(key, labels, { system, prompt }, read, settle) {
    if (kept.results.has(key)) { await context.gateway.step(key, POLICY, { labels }).reuse('kept'); state.reused++; return kept.results.get(key); }
    let unreadable = 0, threw = 0, tries = 0;
    while (unreadable < 2) {
      context.signal.throwIfAborted();
      let text;
      try {
        text = await context.gateway.step(stepKey(key, tries++), POLICY, { labels }).complete(system, unreadable ? `${prompt}${REASK}` : prompt);
      } catch (error) {
        // A stop is never asked again; a provider error once.
        if (context.signal.aborted || error?.name === 'AbortError' || threw++ >= 1) throw error;
        continue;
      }
      const parsed = read(text);
      if (parsed) { const settled = await settle(parsed); kept.results.set(key, settled); return settled; }
      unreadable++;
    }
    return null;
  };
}
