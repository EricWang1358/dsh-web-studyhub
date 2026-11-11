import { useEffect, useLayoutEffect } from 'react';
import { sessionPerformance } from './session-performance.js';

/* What feeds the session's performance log (ui/session-performance.js, #893 S4), with the cheapest hooks that are still correct: the call that
   switches the page, one animation frame after the page committed, and the browser's own long-task observer. No polling, no forced layout, no timer.
   While the page is hidden nothing is timed: browsers hold the animation frame until the learner is back, so a switch that spans a change of visibility
   (the page hid or showed between the commit and the frame) is dropped, not recorded as minutes. */

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

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

/** Called once by the page view: times the switch to `page` and watches long tasks while the app is open. */
export function useSessionPerformance(page, log = sessionPerformance) {
  usePageSwitchEnd(page, log);
  useLongTasks(log);
}
