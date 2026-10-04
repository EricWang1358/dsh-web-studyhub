import { useEffect, useRef } from 'react';
import { backoffDelay } from './poll-schedule.js';

/* One polling loop for the panel (see poll-schedule.js for the rhythm). It asks, waits for the answer, then waits the
   interval, so calls never overlap; it is silent while the page is hidden and asks at once when the page returns.
   `fn` may answer { unchanged, running } so `backoff(intervalMs, { unchanged, running, result })` can slow down while
   nothing moves (pass backoffDelay from poll-schedule.js for the standard table). */

const browserEnv = () => ({
  hidden: () => typeof document !== 'undefined' && document?.hidden === true,
  onVisibility(callback) {
    if (typeof document?.addEventListener !== 'function') return () => {};
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
  // unref: in Node (tests, build scripts) a poll must never be what keeps the process alive; browsers have no unref.
  setTimer: (callback, ms) => { const id = globalThis.setTimeout(callback, ms); id?.unref?.(); return id; },
  clearTimer: id => globalThis.clearTimeout(id),
});

/** The loop itself, without React: `start()`, `stop()`, `refresh()` (ask now). `env` swaps the timers and the visibility source. */
export function createPoller({ run, intervalMs, backoff, pauseWhenHidden = true, immediate = false, onError, env = browserEnv() }) {
  let started = false, busy = false, timer = null, unsubscribe = null, unchanged = 0;
  const hidden = () => pauseWhenHidden && env.hidden();
  const clear = () => { if (timer !== null) { env.clearTimer(timer); timer = null; } };
  const schedule = (result) => {
    clear();
    if (!started || hidden()) return;
    const delay = backoff ? backoff(intervalMs, { unchanged, running: !!result?.running, result }) : intervalMs;
    timer = env.setTimer(tick, Number.isFinite(delay) && delay > 0 ? delay : intervalMs);
  };
  async function tick() {
    timer = null;
    if (!started || busy || hidden()) return;
    busy = true;
    let result;
    try { result = await run(); } catch (error) { onError?.(error); }
    busy = false;
    unchanged = result?.unchanged === true ? unchanged + 1 : 0;
    schedule(result);
  }
  return {
    start() {
      if (started) return;
      started = true;
      if (pauseWhenHidden) unsubscribe = env.onVisibility(() => {
        if (!started) return;
        if (hidden()) clear();
        else if (!busy) { clear(); void tick(); }
      });
      if (hidden()) return;
      if (immediate) void tick(); else schedule();
    },
    stop() {
      started = false;
      clear();
      unsubscribe?.();
      unsubscribe = null;
    },
    /** Ask now and restart the wait; a call already in flight is not doubled. */
    refresh() { clear(); return tick(); },
  };
}

/**
 * Call `fn` every `intervalMs` while `enabled`. Returns `{ refresh }` to ask outside the rhythm.
 * `immediate` also asks once when polling starts. `backoff: true` is the standard table. `fn` and `backoff` may change between renders without restarting the loop.
 */
export function usePolling(fn, { intervalMs, enabled = true, pauseWhenHidden = true, immediate = false, backoff, onError } = {}) {
  const latest = useRef({ fn, backoff, onError });
  const poller = useRef(null);
  useEffect(() => { latest.current = { fn, backoff, onError }; });
  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return undefined;
    const loop = createPoller({ run: () => latest.current.fn(), intervalMs, pauseWhenHidden, immediate,
      backoff: (base, state) => { const rule = latest.current.backoff; return rule ? (rule === true ? backoffDelay : rule)(base, state) : base; },
      onError: error => latest.current.onError?.(error) });
    poller.current = loop;
    loop.start();
    return () => { loop.stop(); if (poller.current === loop) poller.current = null; };
  }, [enabled, intervalMs, pauseWhenHidden, immediate]);
  return { refresh: () => poller.current?.refresh() };
}
