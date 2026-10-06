/** Kernel bounds in one place. These are contract limits, not tuning knobs:
 * changing one changes what stored records and callers may contain. */
export const LIMITS = Object.freeze({
  stepKeyLength: 200,
  reuseReasonLength: 200,
  domainEventsKept: 300,
  callLabelLength: 160,
  stepLabelLength: 400,
  policyWordLength: 100,
  maxTimerMs: 2 ** 31 - 1,
});
