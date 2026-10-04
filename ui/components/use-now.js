import { useEffect, useState } from 'react';

/**
 * One clock for every "elapsed" readout. Subscribers of the same interval share
 * a single timer, the timer stops while the page is hidden, and it stops when
 * the last subscriber leaves, so a screen of job rows runs one timer, not one
 * per row. The browser pieces are injected so the logic is testable.
 */
export function createClock({
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = id => clearInterval(id),
  isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  watchVisibility = fn => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', fn);
    return () => document.removeEventListener('visibilitychange', fn);
  },
} = {}) {
  const groups = new Map(); // interval -> { listeners, timer }
  let stopWatching = null;
  const tick = group => { for (const listener of [...group.listeners]) listener(); };
  const start = (ms, group) => { group.timer ??= setTimer(() => tick(group), ms); };
  const stop = group => { if (group.timer != null) { clearTimer(group.timer); group.timer = null; } };
  const onVisibility = () => {
    for (const [ms, group] of groups) {
      if (isVisible()) { start(ms, group); tick(group); } else stop(group);
    }
  };
  return {
    subscribe(ms, listener) {
      let group = groups.get(ms);
      if (!group) { group = { listeners: new Set(), timer: null }; groups.set(ms, group); }
      group.listeners.add(listener);
      if (isVisible()) start(ms, group);
      stopWatching ??= watchVisibility(onVisibility);
      return () => {
        group.listeners.delete(listener);
        if (group.listeners.size) return;
        stop(group);
        groups.delete(ms);
        if (!groups.size) { stopWatching?.(); stopWatching = null; }
      };
    },
  };
}

const shared = createClock();

/**
 * The current time, refreshed every `intervalMs` while `enabled` and the page
 * is visible. Pass enabled: false for finished jobs or collapsed panels: the
 * component then neither subscribes nor re-renders.
 */
export function useNow(intervalMs = 1000, { enabled = true } = {}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    return shared.subscribe(intervalMs, () => setNow(Date.now()));
  }, [intervalMs, enabled]);
  return now;
}
