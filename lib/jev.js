import { JEV_MESSAGES, JEV_MESSAGES_EN, jevMessage } from './jev-messages.js';

export { JEV_MESSAGES, JEV_MESSAGES_EN, jevMessage };

/* EXPERIMENTAL. A small client for Jev, TypeSafe AI's "System One" model (https://docs.typesafe.ai), and the provider seam
   the experimental decision layer is written against.

   What Jev is for here: cheap, fast classification-shaped judgements ("which course", "does the stem reveal the answer")
   that a text-generation model would answer at far higher cost. It is NOT a replacement for the study model, and it never
   writes anything on its own: every caller treats an answer as a SIGNAL and falls back to the existing behaviour when it is
   missing (lib/jev-runtime.js guarantees that).

   Everything the documentation fixes is in JEV, in one place. Endpoint and body, from docs.typesafe.ai/api:
     POST {baseUrl}/v1/systemone    Authorization: Bearer <key>
     { state, model, questions: { <name>: { type: 'noul' | 'choice' | 'score', instructions, criteria? } } }
     -> { model, answers: { <name>: ... }, usage: { input_tokens, output_tokens } }
   noul: probability 0-1 that the answer is yes; choice: one of up to 255 labelled options with the full distribution and a
   confidence; score: a rating on an ordered scale of 2-10 levels. Errors: 401 key, 422 validation, 429 rate limit, 529
   overloaded (exponential backoff on 429/529). The retry defaults follow the vendor's own SDK (2 retries, 0.5 s doubling to
   5 s, jitter that only shortens, 30 s per call).

   The key is only ever put in the Authorization header. No error, message or log contains the key, the state or a response body.

   THE PROVIDER SEAM. The decision features call `provider.decide(state, questions, { signal })` and nothing else, where a
   provider is `{ id, decide }` and decide resolves `{ model, answers, usage: { inputTokens, outputTokens } }` in the shape
   below. Another provider (a model reached through opencode/DSH, a local classifier) plugs in by returning the same shape; see
   docs/jev-experimental.md. */

export const JEV = Object.freeze({
  baseUrl: 'https://api.typesafe.ai',
  path: '/v1/systemone',
  /** An alias the vendor keeps pointing at its current stable model. */
  model: 'jev-latest',
  docsUrl: 'https://docs.typesafe.ai',
  privacyUrl: 'https://docs.typesafe.ai/legal',
  /** Documented limits. */
  maxChoices: 255,
  minScoreLevels: 2,
  maxScoreLevels: 10,
  /** The vendor documents a 64k-token context with a 32k-token budget for the state plus the longest question. Counting
      characters (a Chinese character is about one token) keeps well inside that. */
  maxStateChars: 24_000,
  /** Retries after the first try, backoff, and the budget of one attempt. */
  maxRetries: 2,
  backoffMs: 500,
  backoffCapMs: 5_000,
  /** A Retry-After longer than this is reported to the caller instead of waited for. */
  maxRetryAfterMs: 10_000,
  requestTimeoutMs: 30_000,
});

export class JevError extends Error {
  constructor(code, { retryable = false, retryAfterMs, httpStatus } = {}) {
    super(JEV_MESSAGES[code] ?? JEV_MESSAGES.unexpected);
    this.name = 'JevError'; this.code = code; this.retryable = retryable;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

const RETRYABLE = new Set(['rate-limited', 'overloaded', 'unavailable', 'network', 'timeout']);
const fail = (code, extra) => new JevError(code, { retryable: RETRYABLE.has(code), ...extra });

/** The error for an HTTP status (`retryAfter`: the Retry-After header, in seconds). */
export function mapJevStatus(status, retryAfter) {
  const seconds = Number(retryAfter), extra = { httpStatus: status,
    ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: Math.round(seconds * 1000) } : {}) };
  if (status === 401 || status === 403) return fail('invalid-key', extra);
  if (status === 400 || status === 422) return fail('invalid-request', extra);
  if (status === 429) return fail('rate-limited', extra);
  if (status === 529) return fail('overloaded', extra);
  if (status === 408) return fail('timeout', extra);
  if (status >= 500) return fail('unavailable', extra);
  return fail('unexpected', extra);
}

/* ---- Questions -------------------------------------------------------------------------------------------------------- */

/** A yes/no question. `criteria` is optional: { true: what a yes means, false: what a no means }. */
export const noul = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
/** Pick one of the options; `criteria` maps each option name to a description (at most 255). */
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
/** Rate on an ordered scale; `criteria` lists the levels from lowest to highest (2 to 10). */
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => fail('invalid-request');

/** Throws an `invalid-request` JevError for anything the service would refuse (or that is too long to send). */
export function validateRequest(state, questions) {
  const size = typeof state === 'string' ? state.length : (() => { try { return JSON.stringify(state)?.length ?? 0; } catch { return 0; } })();
  if (state === undefined || state === null || state === '' || !size) throw invalid();
  if (!(typeof state === 'string' || typeof state === 'object')) throw invalid();
  if (size > JEV.maxStateChars) throw fail('too-large');
  if (!isObject(questions) || !Object.keys(questions).length) throw invalid();
  for (const question of Object.values(questions)) {
    if (!isObject(question) || !['noul', 'choice', 'score'].includes(question.type)) throw invalid();
    if (typeof question.instructions !== 'string' ? !question.instructions : !question.instructions.trim()) throw invalid();
    if (question.type === 'choice') {
      const count = isObject(question.criteria) ? Object.keys(question.criteria).length : 0;
      if (!count || count > JEV.maxChoices) throw invalid();
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < JEV.minScoreLevels || question.criteria.length > JEV.maxScoreLevels) throw invalid();
    } else if (question.criteria !== undefined && !isObject(question.criteria)) throw invalid();
  }
}

const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const distribution = value => isObject(value) && Object.values(value).length > 0 && Object.values(value).every(unit);

/** One answer, checked against its question; anything unreadable is a `bad-response`, never a guess. */
function readAnswer(question, answer) {
  const bad = () => fail('bad-response');
  if (!isObject(answer) || answer.type !== question.type) throw bad();
  if (question.type === 'noul') {
    if (!unit(answer.noul)) throw bad();
    return { type: 'noul', noul: answer.noul };
  }
  if (question.type === 'choice') {
    if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice) || !distribution(answer.probabilities) || !unit(answer.confidence)) throw bad();
    if (!Object.keys(answer.probabilities).every(key => Object.hasOwn(question.criteria, key))) throw bad();
    return { type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: { ...answer.probabilities } };
  }
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || !unit(answer.confidence) || !distribution(answer.probabilities)) throw bad();
  return { type: 'score', score: answer.score, confidence: answer.confidence, probabilities: { ...answer.probabilities },
    ...(isObject(answer.legend) ? { legend: { ...answer.legend } } : {}) };
}

const tokens = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** Where the service is, unless JEV_BASE_URL (the fake server of tests and previews) says otherwise. */
export const jevBaseUrl = () => String((typeof process !== 'undefined' && process.env?.JEV_BASE_URL) || '').trim() || JEV.baseUrl;

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * A client for one key. Everything environmental is injectable: `fetch`, `baseUrl`, `sleep(ms, signal)`, `random()` (the
 * jitter), `maxRetries`, `timeoutMs`. It is a provider: `{ id: 'jev', decide, check }`.
 */
export function createJevClient({ apiKey, baseUrl = jevBaseUrl(), model = JEV.model, fetch = globalThis.fetch, sleep = defaultSleep,
  random = Math.random, maxRetries = JEV.maxRetries, timeoutMs = JEV.requestTimeoutMs } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${JEV.path}`;

  async function attempt(body, signal) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response, text;
    try {
      response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: combined });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw fail(timeout.aborted ? 'timeout' : 'network');
    }
    if (!response.ok) throw mapJevStatus(response.status, response.headers?.get?.('retry-after') ?? undefined);
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw fail('bad-response'); }
    return parsed;
  }

  async function decide(state, questions, { signal } = {}) {
    if (!apiKey) throw fail('no-key');
    validateRequest(state, questions);
    const body = JSON.stringify({ state, model, questions });
    for (let tries = 0; ; tries++) {
      try {
        const parsed = await attempt(body, signal);
        if (!isObject(parsed) || !isObject(parsed.answers)) throw fail('bad-response');
        const answers = {};
        for (const [name, question] of Object.entries(questions)) answers[name] = readAnswer(question, parsed.answers[name]);
        const usage = isObject(parsed.usage) ? { inputTokens: tokens(parsed.usage.input_tokens), outputTokens: tokens(parsed.usage.output_tokens) } : { inputTokens: 0, outputTokens: 0 };
        return { model: typeof parsed.model === 'string' ? parsed.model.slice(0, 80) : model, answers, usage };
      } catch (error) {
        if (!(error instanceof JevError) || !error.retryable || tries >= maxRetries) throw error;
        let wait;
        if (error.retryAfterMs !== undefined) {
          if (error.retryAfterMs > JEV.maxRetryAfterMs) throw error;
          wait = error.retryAfterMs;
        } else wait = Math.min(JEV.backoffCapMs, JEV.backoffMs * 2 ** tries) * (1 - 0.25 * random());
        await sleep(Math.round(wait), signal);
      }
    }
  }

  return {
    id: 'jev', model, decide,
    /** One tiny harmless call (no learner text) that proves the key works: resolves { ok: true, model, usage } or rejects with a JevError. */
    async check({ signal } = {}) {
      const result = await decide('Hello.', { greeting: noul('Is this text a greeting?') }, { signal });
      return { ok: true, model: result.model, usage: result.usage };
    },
  };
}
