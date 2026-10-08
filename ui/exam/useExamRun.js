import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useNow } from '../components/use-now.js';
import { usePolling } from '../use-polling.js';
import { createExamRun, examTiming, EXAM_KINDS } from './exam-run.js';

/* One exam lifecycle for the written exam, the case paper and the oral exam (#132). The page keeps its answering UI;
   this owns phase (setup, running, report), the run and its report, restoring, submitting, polling a report that is
   still being graded, the clock and the location the app returns to.

   Clocks everywhere read through formatClock (ui/format.js): whole seconds rounded DOWN, so a countdown shows 0:00 for
   its last second instead of the written exam and the case paper rounding differently. */

const REPORT_POLL_MS = 4000;

/**
 * kind: 'exam' | 'case' | 'oral'. `call` is the host call. `onLocation({ kind, runId })` tells the app which run is on screen
 * (`locate: false` stays quiet, for a shell that only sometimes shows this format). `limitMs` makes `expired` true that long
 * after the run started (a number, or `run => number` when the run carries its own limit); `retryMs` is the pause before an
 * automatic submit is tried again after a failure.
 * `autoSubmit` is { when(timing), run }: while running, `run()` fires as soon as `when(timing)` is true (it is asked at every tick of the
 * clock) and no submit is in flight or waiting to retry.
 * `pollReport(report)` says a report is still being filled in (the case grading): it is re-read every few seconds, not while the page is hidden.
 * Returns the controller state (phase, run, report, error, busy, loading), the clock ({ now, startMs, elapsedMs, expired })
 * and the controller verbs: enter, setRun, showReport, setReport, setError, leave, perform, restore, submit, openReport, begin, isBusy.
 */
export function useExamRun({ kind, call, initialRunId, onLocation, submitAction, reportAction, limitMs, retryMs, locate = true, autoSubmit, pollReport }) {
  const latest = useRef(null);
  latest.current = { kind, call, initialRunId, onLocation, ...(submitAction ? { submitAction } : {}), ...(reportAction ? { reportAction } : {}), retryMs };
  const controller = useMemo(() => createExamRun(() => latest.current), []);
  useEffect(() => { controller.begin(); return () => controller.end(); }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const { phase, run, report } = state;

  const now = useNow(1000, { enabled: phase === 'running' && !!run?.startedAt });
  const timing = examTiming(run, now, typeof limitMs === 'function' ? limitMs(run) : limitMs);

  const place = EXAM_KINDS[kind] || EXAM_KINDS.exam;
  const runId = phase === 'report' ? report?.runId ?? run?.id : run?.id;
  useEffect(() => {
    if (!locate || (!runId && !place.locateWithoutRun)) return;
    onLocation?.({ kind: place.location, runId });
  }, [locate, onLocation, place.location, place.locateWithoutRun, runId]);

  // The page's clock ticks once a second; each tick is a chance to submit a run whose time is up.
  useEffect(() => {
    if (autoSubmit && autoSubmit.when(timing) && controller.autoSubmitReady()) autoSubmit.run();
  }, [controller, state.busy, phase, timing.elapsedMs]); // eslint-disable-line react-hooks/exhaustive-deps

  usePolling(() => controller.refreshReport(), { intervalMs: REPORT_POLL_MS, enabled: phase === 'report' && !!report && !!pollReport?.(report) });

  return { ...state, ...timing, now, enter: controller.enter, setRun: controller.setRun, showReport: controller.showReport,
    setReport: controller.setReport, setError: controller.setError, leave: controller.leave, perform: controller.perform,
    restore: controller.restore, submit: controller.submit, openReport: controller.openReport, refreshReport: controller.refreshReport,
    begin: controller.begin, isBusy: controller.isBusy };
}
