/* The order in which the panel takes what the conversation asks it to show (#537). lib/panel-bridge.js numbers each intent per session and stamps when it was issued; an
   intent that arrives after a newer one has been taken is stale and must not take the question off the screen. The number alone cannot say this: a host that restarted
   counts from 1 again while this page stays open, so the time issued comes first and the number only separates two of the same millisecond. */
export function createIntentGuard() {
  const newest = new Map();
  return {
    /** Should this intent be shown? An intent without a number (an older host) has no order to check. */
    accept(sessionId, intent) {
      if (!Number.isSafeInteger(intent?.intentSeq)) return true;
      const seen = newest.get(sessionId), issuedAt = intent.issuedAt ?? 0;
      if (seen && (issuedAt < seen.issuedAt || (issuedAt === seen.issuedAt && intent.intentSeq <= seen.intentSeq))) return false;
      newest.set(sessionId, { issuedAt, intentSeq: intent.intentSeq });
      return true;
    },
  };
}
