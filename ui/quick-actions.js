import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { isActiveJob } from "./job-visibility.js";
import { failureText } from './failure.js';
import { archivedContract } from '../lib/job-contract.js';

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
    run(action, args, { key = action, patch = (data) => data, confirmed, treatAsDone, groups } = {}) {
      const known = entries.get(key);
      if (known) return known.promise;
      const entry = { action, patch, confirmed, groups, settledAt: null, promise: null };
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
    snapshot: () => ({ failures, run: controller.run, current: controller.current, clearFailure: controller.clearFailure, release: controller.release }),
    /** The patch of a finished action is dropped at once when its inverse has just succeeded for EVERY job it covers (`groups` of run(): one list of names per job):
        撤销 of an 归档 lets that 归档 go, an 归档 lets an earlier 撤销 go (`action`: the one whose patches go). A patch that also covers jobs the inverse did not name stays. */
    release(ids, action) {
      const wanted = new Set(ids);
      let changed = false;
      for (const [key, entry] of entries)
        if (entry.settledAt !== null && entry.action === action && entry.groups?.length && entry.groups.every((names) => names.some((name) => wanted.has(name)))) { entries.delete(key); changed = true; }
      if (changed) emit();
    },
  };
  return controller;
}

const notFound = (error) => /not found/i.test(error?.message || "");

/* A job is named by its own id or, for an audio batch, by what survives a retry (its contract's jobId): the console selects by the second, the cards by the first. */
const namesOf = (job) => [job?.id, job?.contract?.jobId].filter(Boolean);
const named = (ids) => (job) => namesOf(job).some((name) => ids.has(name));
// A day of 为你定制 is a record its own file ages out: the host does not archive it, so it is never marked as archived here either.
const isDay = (job) => job?.type === "coach-daily" || job?.contract?.kind === "coach-daily";
const BATCH = 100;
const parts = (ids) => { const out = []; for (let start = 0; start < ids.length; start += BATCH) out.push(ids.slice(start, start + BATCH)); return out; };
const count = (value) => (Array.isArray(value) ? value.length : 0);

/** One call of job.archive: the finished jobs it names are marked leaving AND already listed under the archived ones (the host's own record replaces ours with the next snapshot). */
function archiveRun(quick, args, ids, key) {
  const at = new Date().toISOString(), is = named(ids);
  // One list of names per job it archives (its own id and what survives a retry), so 撤销 (job.unarchive by either) can release this patch once every one is back.
  const found = (quick.current?.()?.jobs || []).filter(is).map(namesOf);
  const groups = found.length ? found : [...ids].map((id) => [id]);
  // A 撤销 of these jobs still held on screen lets go first: this 归档 is newer, and a later 撤销 must reach the host again.
  quick.release?.(groups.flat(), "job.unarchive");
  return quick.run("job.archive", args, {
    key, groups,
    patch: (data) => {
      const hit = (data.jobs || []).filter((job) => is(job) && !isActiveJob(job) && !isDay(job));
      if (!hit.length) return data;
      const records = hit.filter((job) => job.contract).map((job) => ({ id: job.id, ...(job.type ? { type: job.type } : {}), status: job.status, ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        archived: { at }, contract: archivedContract(job.contract, at) }));
      const have = new Set(records.flatMap(namesOf));
      return { ...data, jobs: data.jobs.map((job) => (hit.includes(job) ? { ...job, leaving: true } : job)),
        ...(records.length ? { archivedJobs: [...records, ...(data.archivedJobs || []).filter((job) => !namesOf(job).some((name) => have.has(name)))] } : {}) };
    },
    confirmed: (data) => !(data.jobs || []).some(is),
    treatAsDone: notFound,
  });
}

/** 知道了 on one finished job, or 全部知道了 when `jobId` is omitted: the job is ARCHIVED (kept, read-only, under 已归档), never deleted. The cards fade out at once. */
export function dismissJobs(quick, jobId, alsoIds = []) {
  const jobs = quick.current?.()?.jobs || [];
  const ids = new Set(jobId ? [jobId, ...alsoIds] : jobs.filter((job) => !isActiveJob(job) && !isDay(job)).flatMap(namesOf));
  if (!ids.size) return Promise.resolve({ ok: true });
  return archiveRun(quick, jobId ? alsoIds.length ? { jobIds: [jobId, ...alsoIds] } : { jobId } : { all: true }, ids, jobId || "jobs:all");
}

const none = () => ({ ok: true, archived: 0, unarchived: 0, deleted: 0, skipped: 0, skippedIds: [] });
const skippedIdsOf = (reply) => (Array.isArray(reply?.skipped) ? reply.skipped.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean) : []);
/** Send `ids` in calls of at most 100, one after the other; stops at the first failure. `each(part)` is one call's promise, `add(reply)` what it says. */
async function inParts(ids, each, add) {
  const total = none();
  for (const part of parts(ids)) {
    const done = await each(part);
    if (!done.ok) return { ...total, ok: false, message: failureText(done.error) };
    add(total, done.result || {});
  }
  return total;
}

/** 归档 for the console's selection (task ids: a job's own id or what survives a retry). Resolves { ok, archived, skipped } (message when it failed). */
export const archiveJobs = (quick, ids) => inParts(ids, (part) => archiveRun(quick, { jobIds: part }, new Set(part), `jobs:archive:${part[0]}:${part.length}`),
  (total, reply) => { total.archived += count(reply.archived) + count(reply.alreadyArchived); total.skipped += count(reply.skipped); total.skippedIds.push(...skippedIdsOf(reply)); });

/** 取消归档: the records leave the archived list at once; the tasks are back in the list with the next snapshot. Every call is its own (a key of its own): a second
    撤销 after a second 归档 is never taken for the first one still held. When it worked, an 归档 still held on screen for exactly these jobs lets go, so they are back at
    once and a second 归档 is really sent. */
let unarchiveSequence = 0;
export const unarchiveJobs = async (quick, ids) => {
  const total = await inParts(ids, (part) => {
    const is = named(new Set(part));
    const found = (quick.current?.()?.archivedJobs || []).filter(is).map(namesOf);
    return quick.run("job.unarchive", { jobIds: part }, { key: `jobs:unarchive:${++unarchiveSequence}`, groups: found.length ? found : part.map((id) => [id]),
      patch: (data) => (data.archivedJobs?.some(is) ? { ...data, archivedJobs: data.archivedJobs.filter((job) => !is(job)) } : data),
      confirmed: (data) => !(data.archivedJobs || []).some(is), treatAsDone: notFound });
  }, (sum, reply) => { sum.unarchived += count(reply.unarchived); });
  if (total.ok !== false) quick.release?.(ids, "job.archive");
  return total;
};

/** 删除 (for good): finished tasks and archived records leave the view at once; a task that is running never does. Resolves { ok, deleted, skipped }. */
export const deleteJobs = (quick, ids) => inParts(ids, (part) => {
  const is = named(new Set(part));
  return quick.run("job.delete", { jobIds: part }, { key: `jobs:delete:${part[0]}:${part.length}`,
    patch: (data) => ({ ...data, jobs: (data.jobs || []).filter((job) => !(is(job) && !isActiveJob(job))), archivedJobs: (data.archivedJobs || []).filter((job) => !is(job)) }),
    confirmed: (data) => ![...(data.jobs || []), ...(data.archivedJobs || [])].some((job) => is(job) && !isActiveJob(job)), treatAsDone: notFound });
}, (total, reply) => { total.deleted += count(reply.deleted); total.skipped += count(reply.skipped); total.skippedIds.push(...skippedIdsOf(reply)); });

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
