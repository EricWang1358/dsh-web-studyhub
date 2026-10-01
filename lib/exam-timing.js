export const EXAM_LIMIT_MS = 30 * 60 * 1000;

/** A case paper (WP12) carries its own limit (reading + writing); paper practice has none on the server. */
export const examLimitMs = (run) => run?.paper ? run.paper.limitMs || null : EXAM_LIMIT_MS;

export function examExpired(run, now = Date.now()) {
  const startedAt = Date.parse(run?.startedAt), limit = examLimitMs(run);
  return !!limit && Number.isFinite(startedAt) && now - startedAt >= limit;
}
