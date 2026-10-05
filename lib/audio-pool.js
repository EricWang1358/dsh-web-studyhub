/* The pool the text steps of an audio import run on (proofreading and translation, through the DSH model or Gemini text).

   - A finished window is replaced at once: `run()` hands a slot to the next queued job the moment one frees up, so one
     slow window never idles the others (the old wave-by-wave scheme did).
   - The limit is adaptive. When a call is refused for a concurrency or rate reason (429, "too many concurrent
     requests", a host sub-agent limit) the pool lowers its effective limit for the rest of the run, lets that job try
     again after a back-off (the refused window is not failed), and, after a few clean successes in a row, raises the
     limit one step again until it is back at the configured value. The learner's setting is the ceiling.
   - One pool is shared by every file of a batch, so the DSH model is limited as a whole while the files overlap with
     the transcription of the next file. Transcription has its own limit (the audio gate in the host). */

export const TEXT_CONCURRENCY = Object.freeze({ min: 1, max: 6, default: 3 });
export const TRANSCRIBE_CONCURRENCY = Object.freeze({ min: 1, max: 3, default: 1 });
/** A configured count, or the default when it is missing or outside the limits. */
export const clampCount = (value, { min, max, default: fallback }) => {
  const count = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(count) && count >= min && count <= max ? count : fallback;
};

const LIMIT_CODES = /^(RATE_LIMIT(ED)?|TOO_MANY_REQUESTS|CONCURRENCY(_LIMIT)?|OVERLOADED|RESOURCE_EXHAUSTED|SUBAGENT_LIMIT|CHILD_LIMIT)$/i;
const LIMIT_TEXT = /too many (concurrent )?(requests|calls|agents|children)|concurren(t|cy) (request|limit|call)|rate.?limit|overloaded|resource.?exhausted|(sub-?agents?|children|child agents?|background (agents?|assistants?)).{0,40}(limit|too many|maximum|max\b)|(limit|maximum|max\b).{0,40}(sub-?agents?|children|child agents?)/i;
/** Whether a model call was refused because too many were running (or asked too fast): fewer at once can succeed. */
export const isLimitError = error => !!error && error.name !== 'AbortError' && error.name !== 'TimeoutError' &&
  (Number(error.status) === 429 || Number(error.status) === 529 || LIMIT_CODES.test(String(error.code || '')) || LIMIT_TEXT.test(String(error.message || '')));

const sleepFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});
/** 1 s, 2 s, 4 s … at most 8 s: long enough for a provider's concurrent-request window to drain. */
export const defaultBackoff = attempt => Math.min(8000, 1000 * 2 ** attempt);

/**
 * @param limit       the configured concurrency (the ceiling)
 * @param floor       the effective limit never goes below this
 * @param probeAfter  clean successes in a row before the effective limit is raised by one
 * @param backoff     (refusals so far) → ms to wait before the refused job tries again
 * @param refusals    how many times one job may be refused before its error is thrown
 * @param onChange    ({ limit, effective, lowered, refused }) whenever the effective limit moves
 */
export function createPool({ limit = TEXT_CONCURRENCY.default, floor = 1, probeAfter = 4, backoff = defaultBackoff, refusals = 8, onChange = () => {} } = {}) {
  limit = Math.max(floor, limit);
  let effective = limit, running = 0, streak = 0, epoch = 0, refused = 0, lowest = limit;
  const waiting = [];
  const state = () => ({ limit, effective, lowered: lowest < limit, lowest, refused });
  const emit = () => onChange(state());
  const pump = () => { while (waiting.length && running < effective) { running++; waiting.shift().start(); } };
  const acquire = signal => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const entry = { start: () => { signal?.removeEventListener('abort', abort); resolve(); } };
    const abort = () => { const at = waiting.indexOf(entry); if (at >= 0) { waiting.splice(at, 1); reject(signal.reason); } };
    signal?.addEventListener('abort', abort, { once: true });
    waiting.push(entry);
    pump();
  });
  /** Run `work` in a slot. A refused attempt (isLimitError) lowers the pool and is retried after the back-off. */
  async function run(work, { signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      await acquire(signal);
      const born = epoch;
      try {
        const value = await work(attempt);
        if (++streak >= probeAfter && effective < limit) { effective++; streak = 0; emit(); }
        return value;
      } catch (error) {
        if (!isLimitError(error) || signal?.aborted || attempt >= refusals) throw error;
        refused++; streak = 0;
        // Every call refused in the same round saw the same limit: lower once for the round, not once per call.
        if (born === epoch && effective > floor) { effective = Math.max(floor, Math.min(effective, running) - 1); lowest = Math.min(lowest, effective); epoch++; }
        emit();
      } finally { running--; pump(); }
      await sleepFor(backoff(attempt), signal);
    }
  }
  return { run, get state() { return state(); } };
}
