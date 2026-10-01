import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { isActiveJob } from "./job-visibility.js";

/* The light path for actions that only change a sliver of what is on screen (a finished card, the unread badge).

   App.act is built for heavy work: single-flight, it disables every control while it runs and waits for a full library
   snapshot (about 1 MB with sources) before it lets go. That is the right trade for "start review" or "publish" and a
   bad one for "知道了". A quick action instead
     - patches the view immediately (a pure function over the snapshot; the real snapshot is never mutated),
     - sends the call in the background without any global busy flag and without blocking other actions,
     - keeps the patch until a later snapshot confirms the change (or a hold time passes), so a poll that was already
       in flight cannot bring the card back,
     - on failure drops the patch and keeps a short message under the action's key, shown next to the thing that came back. */

export function createQuickActions({ call, now = Date.now, holdMs = 8000, errorMs = 12000, timers = true } = {}) {
  const entries = new Map();
  const listeners = new Set();
  let failures = {}, current = null, stamp = 0, cache = null;
  const emit = () => { stamp++; cache = null; for (const listener of [...listeners]) listener(); };
  const later = (work, ms) => { if (timers) { const timer = setTimeout(work, ms); timer.unref?.(); } };
  const fail = (key, message) => {
    failures = { ...failures, [key]: message };
    later(() => { if (failures[key] === message) controller.clearFailure(key); }, errorMs);
  };

  const controller = {
    /** Apply every pending patch to a server snapshot. Returns the same object when nothing is pending. */
    view(raw) {
      current = raw;
      if (!entries.size || !raw) return raw;
      if (cache && cache.raw === raw) return cache.out;
      let out = raw;
      for (const entry of entries.values()) out = entry.patch(out);
      cache = { raw, out };
      return out;
    },
    /** The latest server snapshot passed to view(); lets callers choose targets without re-reading props. */
    current: () => current,
    failures: () => failures,
    clearFailure(key) {
      if (!(key in failures)) return;
      const { [key]: dropped, ...rest } = failures;
      void dropped;
      failures = rest;
      emit();
    },
    /** Run `action` in the background. Resolves {ok, result|error}; never rejects, never sets a busy flag. */
    run(action, args, { key = action, patch = (data) => data, confirmed, treatAsDone } = {}) {
      const known = entries.get(key);
      if (known) return known.promise;
      const entry = { patch, confirmed, settledAt: null, promise: null };
      entries.set(key, entry);
      if (key in failures) { const { [key]: dropped, ...rest } = failures; void dropped; failures = rest; }
      emit();
      entry.promise = (async () => {
        let result;
        try { result = await call(action, args); }
        catch (error) {
          if (!treatAsDone?.(error)) {
            entries.delete(key);
            fail(key, error?.message || String(error));
            emit();
            return { ok: false, error };
          }
        }
        entry.settledAt = now();
        later(() => controller.reconcile(current), holdMs + 50);
        return { ok: true, result };
      })();
      return entry.promise;
    },
    /** Drop finished patches that a snapshot confirms (or that have outlived the hold time). */
    reconcile(raw) {
      if (raw) current = raw;
      let changed = false;
      for (const [key, entry] of entries)
        if (entry.settledAt !== null && ((raw && entry.confirmed?.(raw)) || now() - entry.settledAt >= holdMs)) {
          entries.delete(key);
          changed = true;
        }
      if (changed) emit();
    },
    reset() {
      if (!entries.size && !Object.keys(failures).length) return;
      entries.clear();
      failures = {};
      emit();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => stamp,
    /** What components receive through context. */
    snapshot: () => ({ failures, run: controller.run, current: controller.current, clearFailure: controller.clearFailure }),
  };
  return controller;
}

const notFound = (error) => /not found/i.test(error?.message || "");

/** 知道了 on one finished job, or 全部知道了 when `jobId` is omitted. The cards fade out at once. */
export function dismissJobs(quick, jobId) {
  const jobs = quick.current?.()?.jobs || [];
  const ids = new Set(jobId ? [jobId] : jobs.filter((job) => !isActiveJob(job)).map((job) => job.id));
  if (!ids.size) return Promise.resolve({ ok: true });
  return quick.run("job.dismiss", jobId ? { jobId } : { all: true }, {
    key: jobId || "jobs:all",
    patch: (data) => ({ ...data, jobs: (data.jobs || []).map((job) => ids.has(job.id) && !isActiveJob(job) ? { ...job, leaving: true } : job) }),
    confirmed: (data) => !(data.jobs || []).some((job) => ids.has(job.id)),
    treatAsDone: notFound,
  });
}

/** 全部已读: the badge clears at once. */
export function markInboxRead(quick) {
  return quick.run("inbox.read", { all: true }, {
    key: "inbox:read",
    patch: (data) => data.inbox ? { ...data, inbox: { ...data.inbox, unread: 0, items: (data.inbox.items || []).map((item) => item.read ? item : { ...item, read: true }) } } : data,
    confirmed: (data) => !data.inbox?.unread,
  });
}

export const QuickActionsContext = createContext(null);
export const useQuickActions = () => useContext(QuickActionsContext);

/** One controller per App; `view` applies its patches to the server snapshot, `api` goes into the context. */
export function useQuickActionsController(call) {
  const callRef = useRef(call);
  callRef.current = call;
  const controller = useMemo(() => createQuickActions({ call: (action, args) => callRef.current(action, args) }), []);
  const stamp = useSyncExternalStore(controller.subscribe, controller.version);
  const api = useMemo(() => controller.snapshot(), [controller, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => controller.reset(), [controller]);
  return { controller, api, stamp };
}
