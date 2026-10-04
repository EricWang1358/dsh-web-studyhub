import { failureText } from '../failure.js';
/* The lifecycle every exam format shares (#132): setup -> running -> report, restoring a run from the host, submitting
   it, opening a saved report, and the clock. The written exam, the case paper and the oral exam keep only their
   answering UI and talk to this controller. It has no React and no DOM: ui/exam/useExamRun.js binds it to a page and
   tests/wpx-exam-run.test.mjs drives it directly.

   `read()` returns the latest options: { kind, call, submitAction?, reportAction?, retryMs? } (see EXAM_KINDS). */

/** What each format sends to the host and tells the app about where the learner is. */
export const EXAM_KINDS = Object.freeze({
  exam: { submitAction: 'exam.submit', reportAction: 'exam.report', location: 'exam', locateWithoutRun: true },
  case: { submitAction: 'exam.submit', reportAction: 'exam.report', location: 'exam', locateWithoutRun: true },
  // The oral exam always asks the host for an active run first, so its first paint is "restoring", not the setup card.
  oral: { submitAction: 'oral.submit', reportAction: 'oral.report', location: 'oral', locateWithoutRun: false, startsLoading: true },
});

const INITIAL = Object.freeze({ phase: 'setup', run: null, report: null, error: '', busy: false, loading: false });
const messageOf = (error) => failureText(error);

/**
 * Where the clock stands for a run: `startMs` (null without a valid startedAt), whole `elapsedMs` since then and whether
 * `limitMs` has passed. Pure: the page passes the shared clock's `now`.
 */
export function examTiming(run, now, limitMs = Infinity) {
  const value = new Date(run?.startedAt).getTime();
  const startMs = Number.isFinite(value) ? value : null;
  const elapsedMs = startMs === null ? 0 : Math.max(0, now - startMs);
  return { startMs, elapsedMs, expired: startMs !== null && elapsedMs >= limitMs };
}

export function createExamRun(read) {
  const options = () => { const given = read(); return { ...EXAM_KINDS[given.kind || 'exam'], ...given }; };
  let state = { ...INITIAL, loading: !!options().startsLoading }, epoch = 0, flying = false, retryAt = 0;
  const listeners = new Set();
  const set = (patch) => { state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); };
  const identity = () => { const mine = epoch; return () => epoch === mine; };

  const controller = {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isBusy: () => flying,

    /** A new identity (the page opened another run): results of earlier work are ignored and the page is free to act. */
    begin() { epoch += 1; flying = false; if (state.busy) set({ busy: false }); },
    /** The page left: whatever is still in flight is ignored. */
    end() { epoch += 1; flying = false; },

    enter(run) { retryAt = 0; set({ run, phase: 'running' }); },
    setRun(run) { set({ run }); },
    showReport(report, { run } = {}) { retryAt = 0; set({ report, phase: 'report', ...(run !== undefined ? { run } : {}) }); },
    setReport(report) { set({ report }); },
    setError(error) { set({ error: error ? String(error) : '' }); },
    leave({ clear = true } = {}) { set({ phase: 'setup', ...(clear ? { run: null, report: null } : {}) }); },

    /**
     * Run one action at a time: busy while it works, the old message cleared first, a failure shown as the message
     * (`describeError` words it). Resolves whether it succeeded; a result that arrives after begin()/end() changes nothing.
     * `work(alive)` can ask `alive()` before it writes state of its own.
     */
    async perform(work, { describeError, onFail } = {}) {
      if (flying) return false;
      const alive = identity();
      flying = true;
      set({ busy: true, error: '' });
      try { await work(alive); return true; }
      catch (error) {
        onFail?.(error);
        if (alive()) set({ error: describeError ? describeError(error) : messageOf(error) });
        return false;
      } finally { if (alive()) { flying = false; set({ busy: false }); } }
    },

    /**
     * Find the run to restore: ask `load(id)` for each id in turn. It answers null (not this one, try the next),
     * { stop: true } (nothing to restore), { phase: 'running', run } or { phase: 'report', run, report }.
     * A failure goes to `onError(error, id)`; answering 'continue' tries the next id, anything else stops with the message shown.
     * `onFound(found)` runs just before the page changes phase, once the answer is known to still be wanted: the place for
     * the page to set up its own state from the run.
     */
    async restore({ ids, load, onError, onFound }) {
      const alive = identity();
      set({ loading: true });
      try {
        for (const id of ids) {
          let found;
          try { found = await load(id); }
          catch (error) {
            if (!alive()) return;
            if (onError?.(error, id) === 'continue') continue;
            set({ error: messageOf(error) });
            return;
          }
          if (!alive()) return;
          if (!found) continue;
          if (found.phase) onFound?.(found);
          if (found.phase === 'running') controller.enter(found.run);
          else if (found.phase === 'report') controller.showReport(found.report, { run: found.run });
          return;
        }
      } finally { if (alive()) set({ loading: false }); }
    },

    /**
     * Hand the run in. `before()` saves what is pending and may return a context for `args(context)` (extra submit
     * arguments, e.g. timings) and `after(report, context)` (what follows the report, e.g. starting the grading).
     * Shows the report on success; `clearRun` drops the run with it (the oral report has no run to go back to).
     * A failure keeps the run and holds the automatic retry back for `retryMs` (never, when there is none).
     */
    async submit({ before, args, after, describeError, clearRun = false } = {}) {
      const run = state.run;
      if (!run || flying) return false;
      const { call, submitAction, retryMs = 0 } = options();
      return controller.perform(async (alive) => {
        const context = await before?.();
        const extra = await args?.(context);
        const report = await call(submitAction, { runId: run.id, ...extra });
        if (!alive()) return;
        controller.showReport(report, clearRun ? { run: null } : undefined);
        await after?.(report, context);
      }, { describeError, onFail: () => { retryAt = retryMs > 0 ? Date.now() + retryMs : Infinity; } });
    },

    /** Show the saved report of a finished run. */
    openReport(runId) {
      const { call, reportAction } = options();
      return controller.perform(async (alive) => {
        const report = await call(reportAction, { runId });
        if (alive()) controller.showReport(report);
      });
    },

    /** Read the report again (it is still being graded in the background); a failed read is simply tried again later. */
    async refreshReport() {
      const current = state.report;
      if (!current) return;
      const { call, reportAction } = options();
      try {
        const next = await call(reportAction, { runId: current.runId });
        if (state.report?.runId === current.runId) set({ report: next });
      } catch { /* the next poll asks again */ }
    },

    /** Whether a running page whose time is up may submit by itself now (not while one is in flight or waiting to retry). */
    autoSubmitReady: (at = Date.now()) => state.phase === 'running' && !flying && at >= retryAt,
  };
  return controller;
}
