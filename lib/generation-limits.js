// Real assessment workers can exceed three minutes while checking evidence.
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

// The one call that weighs the importance of a coverage run's sections (lib/section-weights.js); it falls back to length weights when it fails.
export const SECTION_WEIGHT_TIMEOUT_MS = 45 * 1000;

// Execution time only: queue wait does not consume this budget.
export const GENERATION_JOB_TIMEOUT_MS = 20 * 60 * 1000;
