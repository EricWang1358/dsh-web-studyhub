export const EXAM_LIMIT_MS = 30 * 60 * 1000;

export function examExpired(run, now = Date.now()) {
  const startedAt = Date.parse(run?.startedAt);
  return Number.isFinite(startedAt) && now - startedAt >= EXAM_LIMIT_MS;
}
