/** The model the daily recap writes with: every call of the generation is a Step of the Job's gateway (direct; the plain recap path has no effort
 * of its own). The domain asks as it always did, `(system, prompt)`; the Steps are numbered in the order it asks. */
const RECAP_POLICY = Object.freeze({ purpose: 'other', feature: 'other', requestedEffort: 'default', executionMode: 'direct', budget: null });

export function recapModel(gateway) {
  let calls = 0;
  return (system, prompt) => gateway.step(`recap:${++calls}`, RECAP_POLICY).complete(system, prompt);
}
