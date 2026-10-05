import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { isActiveJob } from "./job-visibility.js";
import { failureText } from './failure.js';

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
  const failureTokens = new Map();
  const listeners = new Set();
  let failures = {}, current = null, stamp = 0, cache = null;
  const emit = () => { stamp++; cache = null; for (const listener of [...listeners]) listener(); };
  const later = (work, ms) => { if (timers) { const timer = setTimeout(work, ms); timer.unref?.(); } };
  const fail = (key, message) => {
    const token = {};
    failureTokens.set(key, token);
    failures = { ...failures, [key]: message };
    later(() => { if (failureTokens.get(key) === token) controller.clearFailure(key); }, errorMs);
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
      failureTokens.delete(key);
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
      if (key in failures) { const { [key]: dropped, ...rest } = failures; void dropped; failures = rest; failureTokens.delete(key); }
      emit();
      entry.promise = (async () => {
        let result;
        try { result = await call(action, args); }
        catch (error) {
          if (entries.get(key) !== entry) return { ok: false, error };
          if (!treatAsDone?.(error)) {
            entries.delete(key);
            fail(key, failureText(error));
            emit();
            return { ok: false, error };
          }
        }
        if (entries.get(key) !== entry) return { ok: true, result };
        entry.settledAt = now();
        later(() => { if (entries.get(key) === entry) controller.reconcile(current); }, holdMs + 50);
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
      failureTokens.clear();
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
export function dismissJobs(quick, jobId, alsoIds = []) {
  const jobs = quick.current?.()?.jobs || [];
  const ids = new Set(jobId ? [jobId, ...alsoIds] : jobs.filter((job) => !isActiveJob(job)).map((job) => job.id));
  if (!ids.size) return Promise.resolve({ ok: true });
  return quick.run("job.dismiss", jobId ? alsoIds.length ? { jobIds: [jobId, ...alsoIds] } : { jobId } : { all: true }, {
    key: jobId || "jobs:all",
    patch: (data) => ({ ...data, jobs: (data.jobs || []).map((job) => ids.has(job.id) && !isActiveJob(job) ? { ...job, leaving: true } : job) }),
    confirmed: (data) => !(data.jobs || []).some((job) => ids.has(job.id)),
    treatAsDone: notFound,
  });
}

/** 全部已读: the badge clears at once. With `ids`: those letters were seen on screen, so they read at once and the others stay unread. */
export function markInboxRead(quick, { ids } = {}) {
  if (ids) {
    const wanted = new Set(ids);
    return quick.run("inbox.read", { ids }, {
      key: `inbox:read:${ids.join(",")}`,
      patch: (data) => {
        let flipped = 0;
        const items = (data.inbox?.items || []).map((item) => wanted.has(item.id) && !item.read ? (flipped++, { ...item, read: true }) : item);
        return flipped ? { ...data, inbox: { ...data.inbox, unread: Math.max(0, (data.inbox.unread || 0) - flipped), items } } : data;
      },
      confirmed: (data) => !(data.inbox?.items || []).some((item) => wanted.has(item.id) && !item.read),
    });
  }
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
  const stamp = useSyncExternalStore(controller.subscribe, controller.version, controller.version);
  const api = useMemo(() => controller.snapshot(), [controller, stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => controller.reset(), [controller]);
  return { controller, api, stamp };
}
