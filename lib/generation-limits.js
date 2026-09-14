// Real assessment workers can exceed three minutes while checking evidence.
export const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

// Execution time only: queue wait does not consume this budget.
export const GENERATION_JOB_TIMEOUT_MS = 20 * 60 * 1000;
