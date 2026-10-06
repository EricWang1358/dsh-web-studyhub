/* The numbers 学习流's background units have always used, in one place (they were literals in the units). What a unit reads (cards, evidence, lengths) is
   the domain's own rule and stays where it is read. */
export const WORKFLOW = Object.freeze({
  /** Teachings of one library that may be written at once, and model calls of a teaching in flight at once. */
  maxTeachings: 3, maxModelCalls: 3,
  /** Time one teaching and one skeleton may take before they are given up (ms). */
  teachingTimeoutMs: 240000, skeletonTimeoutMs: 300000,
  /** Cards a skeleton is asked about: small enough to finish within one model call on a large scope. */
  skeletonCards: 80,
});
