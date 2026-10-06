/* The numbers the learner's assistant has always used, in one place (they were literals in lib/assist.js and lib/assist-child.js). */
export const ASSIST = Object.freeze({
  /** Tasks the panel keeps per library, and the time one task may take (ms). */
  taskLimit: 20, timeoutMs: 8 * 60 * 1000,
  /** The reply a task may ask the model for (tokens), and the longest reply it accepts (characters). */
  maxTokens: 10000, maxReplyChars: 60000,
  /** Reusable host teachers (children): how many are kept, how long idle (ms), and how many turns each answers. */
  teachers: 4, teacherIdleMs: 120000, teacherTurns: 8,
});
