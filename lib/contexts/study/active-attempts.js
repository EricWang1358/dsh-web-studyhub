/* Centralized active-attempt projection (#885): voided attempts stay in shards/exports with `voidedAt` for audit durability,
   while all mastery, stats, wrong-book, recap, coach, and round views read only active attempts. */

const activeOfFrozen = new WeakMap();

export const isActiveAttempt = (attempt) => Boolean(attempt && typeof attempt === "object" && !attempt.voidedAt);

export function activeAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  if (!attempts.some((item) => item?.voidedAt)) return attempts;
  const frozen = Object.isFrozen(attempts);
  if (frozen && activeOfFrozen.has(attempts)) return activeOfFrozen.get(attempts);
  const filtered = attempts.filter(isActiveAttempt);
  if (frozen) {
    Object.freeze(filtered);
    activeOfFrozen.set(attempts, filtered);
  }
  return filtered;
}

export function withActiveAttempts(state) {
  if (!state || typeof state !== "object" || !Array.isArray(state.attempts)) return state;
  const active = activeAttempts(state.attempts);
  return active === state.attempts ? state : { ...state, attempts: active };
}
