import { JevError, createJevClient, jevMessage } from './jev.js';
import { jevGate, readJevSettings } from './jev-settings.js';
import { jevUsage } from './jev-usage.js';

/* EXPERIMENTAL. The one door every experimental Jev call goes through.

   `run(feature, state, questions)` resolves { ok: true, answers, usage, model } or { ok: false, reason, message }; it does not
   throw for anything the service, the network or the learner's settings can do, so a caller can always carry on with today's
   behaviour (the experimental layer must never break or block an existing flow). The one exception is a cancelled job: an
   aborted signal is rethrown, because a cancel must stop the work.

   Before anything is sent the settings are read again (so the kill switch is immediate) and lib/jev-settings.js `jevGate`
   decides: master switch, the feature's own switch, a key, the confirmation. Tokens are recorded per feature on success. The
   key is read here and handed to the client; it is in no result, message or log, and neither is the state. */

/**
 * `options` are the test and preview seams, all optional: `baseUrl`, `fetch`, `sleep`, `random`, `timeoutMs`, `maxRetries`
 * (for the client), `usage` (the meter), `settings` (an async function returning the settings), `provider(settings)` (a
 * replacement provider `{ id, decide }`: how another provider plugs in; see docs/jev-experimental.md).
 */
export function createJevRuntime(options = {}) {
  const { usage = jevUsage(), settings: readSettings = readJevSettings, provider: makeProvider, ...clientOptions } = options;
  let failure = null;
  const remember = (feature, reason) => { failure = { feature, reason, at: new Date().toISOString() }; };

  async function call(feature, usageFeature, state, questions, { signal, language, check = false } = {}) {
    const settings = await readSettings();
    const gate = jevGate(settings, feature);
    if (!gate.ok) return { ok: false, reason: gate.reason, message: jevMessage(gate.reason, language) };
    try {
      const provider = makeProvider ? makeProvider(settings) : createJevClient({ apiKey: settings.key, ...clientOptions });
      const result = check ? await provider.check({ signal }) : await provider.decide(state, questions, { signal });
      await usage.record({ feature: usageFeature, usage: result.usage }).catch(() => {});
      failure = null;
      return { ok: true, ...result };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const reason = error instanceof JevError ? error.code : 'unexpected';
      remember(usageFeature, reason);
      return { ok: false, reason, message: jevMessage(reason, language), ...(error instanceof JevError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
    }
  }

  return {
    run: (feature, state, questions, extra = {}) => call(feature, feature, state, questions, extra),
    /** One tiny harmless call to prove the key works; needs a key and the confirmation, not a feature switch. */
    test: (extra = {}) => call(null, 'test', undefined, undefined, { ...extra, check: true }),
    /** The last failure since the last success: { feature, reason, at } or null. For the settings page. */
    lastFailure: () => (failure ? { ...failure } : null),
  };
}

/**
 * Map `items` through `work` with at most `limit` in flight, keeping the order. `stop()` is asked before each new item starts;
 * once it says true the rest are left undefined (a circuit breaker for a run that keeps failing).
 */
export async function mapLimit(items, limit, work, { stop = () => false } = {}) {
  const results = new Array(items.length).fill(undefined);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length && !stop()) { const index = cursor++; results[index] = await work(items[index], index); }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** A breaker for a batch: it opens after `limit` failures in a row, or at once on a failure that no retry can fix. */
export function createBreaker({ limit = 3 } = {}) {
  let streak = 0, open = false;
  const fatal = new Set(['off', 'feature-off', 'no-key', 'not-confirmed', 'invalid-key']);
  return {
    note(result) {
      if (result.ok) { streak = 0; return; }
      streak++;
      if (streak >= limit || fatal.has(result.reason)) open = true;
    },
    get open() { return open; },
  };
}
