/* How often the panel asks the host for a snapshot. While anything may be moving (a job runs, the learner just did
   something) it asks every 2.5 s as before; after the host has answered "unchanged" many times in a row it slows down,
   and the first change, or any activity in the panel, brings the quick rhythm back. A hidden panel does not ask at all
   (App.jsx skips the tick). An unchanged answer is one stat on the host, so this saves requests, not CPU. */

export const POLL_FAST_MS = 2500;
/** [unchanged answers in a row, delay]: the first row that matches wins. */
export const POLL_BACKOFF = Object.freeze([[48, 10000], [12, 5000]]);

/** The same table for a poll that does not run at POLL_FAST_MS: the base interval scaled by the row's delay (usePolling's `backoff`). */
export function backoffDelay(intervalMs, { unchanged = 0, running = false } = {}) {
  if (running) return intervalMs;
  for (const [streak, delay] of POLL_BACKOFF) if (unchanged >= streak) return Math.round(intervalMs * delay / POLL_FAST_MS);
  return intervalMs;
}

/** Delay before the next poll. `running`: a job or coach task is in progress; `unchanged`: consecutive unchanged answers. */
export function pollDelay({ unchanged = 0, running = false } = {}) {
  if (running) return POLL_FAST_MS;
  for (const [streak, delay] of POLL_BACKOFF) if (unchanged >= streak) return delay;
  return POLL_FAST_MS;
}
