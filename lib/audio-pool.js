/* The pool the text steps of an audio import run on (proofreading and translation, through the DSH model or Gemini text).

   - A finished window is replaced at once: `run()` hands a slot to the next queued job the moment one frees up, so one
     slow window never idles the others (the old wave-by-wave scheme did).
   - The limit is adaptive. When a call is refused for a concurrency or rate reason (429, "too many concurrent
     requests", a host sub-agent limit) the pool lowers its effective limit for the rest of the run, lets that job try
     again after a back-off (the refused window is not failed), and, after a few clean successes in a row, raises the
     limit one step again until it is back at the configured value. The learner's setting is the ceiling.
   - One pool is shared by every file of a batch, so the DSH model is limited as a whole while the files overlap with
     the transcription of the next file. Transcription has its own limit (the audio gate in the host). */

import { AsyncLocalStorage } from 'node:async_hooks';

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
 * @param onWait      ({ phase: 'start' | 'end', id, slot, reason: 'rate-limit', ms, attempt }) around each back-off, so a timeline can draw it
 */
export function createPool({ limit = TEXT_CONCURRENCY.default, floor = 1, probeAfter = 4, backoff = defaultBackoff, refusals = 8, onChange = () => {}, onWait = () => {}, mode = 'window' } = {}) {
  if (!['window', 'permit'].includes(mode)) throw new TypeError('Unknown pool mode');
  const permit = mode === 'permit';
  const invalidCount = count => !Number.isSafeInteger(count) || count < 1;
  if (permit && (invalidCount(limit) || invalidCount(floor) || floor > limit)) throw new TypeError('Invalid permit limit');
  const failure = code => Object.assign(new Error(code), { code, resourceAdmission: true });
  const context = permit ? new AsyncLocalStorage() : null;
  const drained = permit ? Promise.withResolvers() : null;
  let closed = false, cooldownUntil = 0, cooldownTimer;
  limit = Math.max(floor, limit);
  let effective = limit, running = 0, streak = 0, epoch = 0, refused = 0, lowest = limit, waits = 0, paused = false, adaptive = true;
  const waiting = [], slots = new Set(), limitWatchers = new Set();
  /** The lowest free slot, counting from 1: the lane a window is drawn in. */
  const takeSlot = () => { let slot = 1; while (slots.has(slot)) slot++; slots.add(slot); return slot; };
  const state = () => ({ limit, effective, lowered: lowest < limit, lowest, refused, paused });
  const emit = () => onChange(state());
  const pump = () => {
    clearTimeout(cooldownTimer); cooldownTimer = undefined;
    if (closed) { if (!running) drained.resolve(); return; }
    const remaining = cooldownUntil - Date.now();
    if (permit && waiting.length && remaining > 0) {
      cooldownTimer = setTimeout(pump, Math.min(remaining, 2 ** 31 - 1));
      return;
    }
    while (!paused && waiting.length && running < effective) { running++; waiting.shift().start(); }
  };
  const acquire = (signal, queueTimeoutMs) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (closed) return reject(failure('scope-unloaded'));
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const remove = error => {
      const at = waiting.indexOf(entry);
      if (at < 0) return;
      waiting.splice(at, 1); cleanup(); reject(error); pump();
    };
    const entry = { start: () => {
      cleanup();
      // A release can reach this queue before an already-due timeout callback.
      if (entry.deadline !== undefined && Date.now() >= entry.deadline) { running--; reject(failure('queue-timeout')); }
      else resolve();
    }, reject: remove };
    const abort = () => remove(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    waiting.push(entry);
    pump();
    if (permit && waiting.includes(entry)) {
      const deadline = entry.deadline = Date.now() + queueTimeoutMs;
      const expire = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) remove(failure('queue-timeout'));
        else timer = setTimeout(expire, Math.min(remaining, 2 ** 31 - 1));
      };
      expire();
    }
  });
  /** Run `work(attempt, slot)` in a slot. A refused attempt (isLimitError) lowers the pool and is retried after the back-off. */
  async function run(work, { signal, queueTimeoutMs } = {}) {
    if (permit && (typeof queueTimeoutMs !== 'number' || !Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 0)) throw failure('queue-timeout-invalid');
    if (context?.getStore()?.active) throw failure('resource-reentrant');
    for (let attempt = 0; ; attempt++) {
      await acquire(signal, queueTimeoutMs);
      const born = epoch, slot = takeSlot();
      const occupied = { active: true };
      let waitFor = null;
      try {
        if (permit) signal?.throwIfAborted();
        const value = await (permit ? context.run(occupied, () => work(attempt, slot)) : work(attempt, slot));
        if (++streak >= probeAfter && effective < limit) { effective++; streak = 0; emit(); }
        return value;
      } catch (error) {
        if (permit || !isLimitError(error) || signal?.aborted || attempt >= refusals) throw error;
        refused++; streak = 0;
        // Every call refused in the same round saw the same limit: lower once for the round, not once per call.
        if (adaptive && born === epoch && effective > floor) { effective = Math.max(floor, Math.min(effective, running) - 1); lowest = Math.min(lowest, effective); epoch++; }
        emit();
        waitFor = { id: `wait-${++waits}`, slot, reason: 'rate-limit', ms: backoff(attempt), attempt };
      } finally { occupied.active = false; slots.delete(slot); running--; pump(); }
      onWait({ phase: 'start', ...waitFor });
      try { await sleepFor(waitFor.ms, signal); } finally { onWait({ phase: 'end', ...waitFor }); }
    }
  }
  return {
    run, get state() { return state(); },
    ...(permit ? {
      /** Observed provider delay, supplied by the request adapter. This never retries work. */
      cooldown(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new TypeError('Invalid cooldown');
        if (closed) return;
        cooldownUntil = Math.max(cooldownUntil, Date.now() + ms); pump();
      },
      /** Revoke admission before rollback/unload; the same promise waits for physical completion. */
      closeAndDrain() {
        closed = true;
        for (const entry of [...waiting]) entry.reject(failure('scope-unloaded'));
        pump(); return drained.promise;
      },
    } : {}),
    /* Live controls (the 任务 console). Each takes effect for the NEXT admission: a call that is running is never stopped or waited for. */
    /** A new ceiling. A pool that was not lowered follows it; one that was lowered by a refusal keeps probing up to it (or down to it, if it is lower). */
    setLimit(count) {
      if (permit && (invalidCount(count) || count < floor)) throw new TypeError('Invalid permit limit');
      const next = Math.max(floor, count);
      if (next === limit) return;
      const lowered = effective < limit;
      limit = next;
      effective = lowered ? Math.min(effective, next) : next;
      lowest = effective;
      emit();
      pump();
      for (const watcher of [...limitWatchers]) watcher(limit);
    },
    /** Be told when the ceiling is moved (by the learner): the runners of a stage use it to start or retire. Returns the function that stops listening. */
    watchLimit(watcher) { limitWatchers.add(watcher); return () => limitWatchers.delete(watcher); },
    /** Paused: nothing new is admitted (the running calls finish); resumed: the waiting ones go on. */
    setPaused(value) { if (paused === !!value) return; paused = !!value; emit(); pump(); },
    /** Automatic back-off off: a refused call still waits and tries again, but the limit stays where it was put. */
    setAdaptive(value) { adaptive = !!value; },
  };
}
