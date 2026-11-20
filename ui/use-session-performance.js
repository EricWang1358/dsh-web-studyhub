import { useEffect, useLayoutEffect, useRef } from 'react';
import { sessionPerformance } from './session-performance.js';

/* What feeds the session's performance log (ui/session-performance.js, #893 S4), with the cheapest hooks that are still correct: the call that
   switches the page, one animation frame after the page committed, the browser's own long-task observer, and Event Timing (INP) sampling for real
   interaction latency. No polling, no forced layout, no timer.
   While the page is hidden nothing is timed: browsers hold the animation frame until the learner is back, so a switch that spans a change of visibility
   (the page hid or showed between the commit and the frame) is dropped, not recorded as minutes. */

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const whole = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

export const INTERACTION_LIMIT = 100;
export const INTERACTION_ACTIONS = Object.freeze([
  'review.option',
  'review.submit',
  'review.flip',
  'review.grade',
  'review.other',
  'other',
]);

/** Classify a PerformanceEventTiming target into a fixed, PII-free review action bucket. */
export function classifyInteractionAction(target, page) {
  if (page !== 'review') return 'other';
  const closest = typeof target?.closest === 'function' ? (sel) => target.closest(sel) : () => null;
  if (closest('.option')) return 'review.option';
  if (closest('.grade-btn, .grade-scale')) return 'review.grade';
  if (closest('.flip-card, [data-usage="review.flip"]')) return 'review.flip';
  if (closest('.cloze-blank--input, .cloze-equivalent-btn, [data-usage="review.submit"], button[type="submit"]')) return 'review.submit';
  return 'review.other';
}

function interactionStats(values) {
  if (!values.length) return { count: 0, median: 0, p98: 0, worst: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.ceil(sorted.length / 2) - 1];
  const p98 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.98) - 1)];
  return { count: sorted.length, median, p98, worst: sorted[sorted.length - 1] };
}

/** Pure in-memory Event Timing (INP) tracker. Groups events by interactionId and retains only the worst duration per interaction. */
export function createInteractionTracker({ limit = INTERACTION_LIMIT } = {}) {
  let observed = false;
  const interactions = new Map();
  const order = [];

  function push(id, action, ms) {
    const existing = interactions.get(id);
    if (existing) {
      if (ms > existing.ms) existing.ms = ms;
      if (existing.action === 'review.other' && action !== 'review.other') existing.action = action;
      return;
    }
    interactions.set(id, { action, ms });
    order.push(id);
    while (order.length > limit) {
      const oldest = order.shift();
      interactions.delete(oldest);
    }
  }

  return {
    observe() {
      observed = true;
      interactions.clear();
      order.length = 0;
    },
    recordEvent(entry, page = null) {
      if (!observed || !entry) return null;
      const interactionId = Number(entry.interactionId);
      if (!Number.isFinite(interactionId) || interactionId <= 0) return null;
      const ms = whole(entry.duration);
      if (ms === null) return null;
      const action = classifyInteractionAction(entry.target, page);
      push(interactionId, action, ms);
      return { interactionId, action, ms };
    },
    summary() {
      if (!observed) return null;
      const items = order.map((id) => interactions.get(id)).filter(Boolean);
      const byAction = {};
      for (const action of INTERACTION_ACTIONS) {
        const durations = items.filter((item) => item.action === action).map((item) => item.ms);
        if (durations.length) byAction[action] = interactionStats(durations);
      }
      return {
        all: interactionStats(items.map((item) => item.ms)),
        byAction,
      };
    },
    reset() {
      observed = false;
      interactions.clear();
      order.length = 0;
    },
  };
}

/** In-memory INP tracker for the active session (never persisted or transmitted). */
export const sessionInteractions = createInteractionTracker();
export const getInteractionSummary = () => sessionInteractions.summary();

/** The learner is switching to `page`: the clock starts (the one place pages are set, ui/app/use-navigation.js). */
export function markPageSwitch(page, log = sessionPerformance) {
  log.startSwitch(visible() ? page : null, performance.now());
}

/**
 * The switch ends at the start of the first frame after the new page committed (the layout effect runs in the commit, before paint): that is
 * when the screen can first show it, the same end as "press to next frame" in scripts/qa/page-switch-perf.mjs. A page that is lazily loaded
 * counts to the frame of its loading notice, not to its content.
 */
function usePageSwitchEnd(page, log) {
  useLayoutEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return undefined;
    const frame = requestAnimationFrame(() => { document.removeEventListener('visibilitychange', cancel); if (visible()) log.endSwitch(page, performance.now()); });
    function cancel() { cancelAnimationFrame(frame); }
    document.addEventListener('visibilitychange', cancel, { once: true });
    return () => { document.removeEventListener('visibilitychange', cancel); cancelAnimationFrame(frame); };
  }, [page, log]);
}

/** Long tasks (over 50 ms) where the webview reports them; elsewhere the log keeps "unknown". Disconnected when the page goes. */
function useLongTasks(log) {
  useEffect(() => {
    if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return undefined;
    let observer;
    try {
      observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) log.recordLongTask(entry.duration); });
      // buffered: the tasks that ran before this effect (the start-up of the app) count too. The log restarts its count with the observer.
      observer.observe({ type: 'longtask', buffered: true });
    } catch { observer?.disconnect(); return undefined; }
    log.observeLongTasks();
    return () => observer.disconnect();
  }, [log]);
}

/** Interaction latency (Event Timing / INP, >= 16ms) where the browser reports `event` entries; safely no-ops in unsupported environments. */
export function useInteractionLatency(page, tracker = sessionInteractions, log = null) {
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    if (typeof PerformanceObserver !== 'function' || !PerformanceObserver.supportedEntryTypes?.includes('event')) return undefined;
    let observer;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const sample = tracker.recordEvent(entry, pageRef.current);
          if (sample) log?.recordInteraction?.(sample.action, sample.ms);
        }
      });
      observer.observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch {
      observer?.disconnect();
      return undefined;
    }
    tracker.observe();
    log?.observeInteractions?.();
    return () => observer.disconnect();
  }, [tracker, log]);
}

/** Called once by the page view: times the switch to `page` and watches long tasks + interaction latency while the app is open. */
export function useSessionPerformance(page, log = sessionPerformance) {
  usePageSwitchEnd(page, log);
  useLongTasks(log);
  useInteractionLatency(page, sessionInteractions, log);
}
