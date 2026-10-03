import test from "node:test";
import assert from "node:assert/strict";
import { createQuickActions, dismissJobs, markInboxRead } from "../ui/quick-actions.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const job = (id, status) => ({ id, status, type: "audio-import" });
const library = () => ({ jobs: [job("a", "complete"), job("b", "failed"), job("c", "running")],
  inbox: { unread: 2, items: [{ id: "m1", read: false }, { id: "m2", read: false }, { id: "m3", read: true }] } });
const flagged = (data) => data.jobs.filter((j) => j.leaving).map((j) => j.id);

function setup(callImpl, options = {}) {
  const calls = [];
  const quick = createQuickActions({ call: (action, args) => { calls.push([action, args]); return callImpl(action, args); }, ...options });
  const raw = library();
  quick.view(raw);
  return { quick, raw, calls };
}

test("a light action patches the view at once, without waiting for the call", async () => {
  const pending = deferred();
  const { quick, raw, calls } = setup(() => pending.promise);
  const done = dismissJobs(quick, "a");
  assert.deepEqual(flagged(quick.view(raw)), ["a"], "the card is marked as leaving before the server answers");
  assert.deepEqual(calls, [["job.dismiss", { jobId: "a" }]]);
  assert.equal(quick.view(raw).jobs[0].leaving, true);
  assert.equal(raw.jobs[0].leaving, undefined, "the server snapshot itself is never mutated");
  pending.resolve({ dismissed: ["a"] });
  assert.equal((await done).ok, true);
});

test("light actions never block each other or anything else (no single flight, no busy flag)", async () => {
  const gates = [deferred(), deferred()];
  const { quick, raw, calls } = setup((action, args) => gates[args.jobId === "a" ? 0 : 1].promise);
  const first = dismissJobs(quick, "a"), second = dismissJobs(quick, "b");
  assert.equal(calls.length, 2, "the second click is sent while the first is still in flight");
  assert.deepEqual(flagged(quick.view(raw)).sort(), ["a", "b"]);
  assert.equal("busy" in quick, false, "the light path has no global busy state");
  gates[1].resolve({}); gates[0].resolve({});
  await Promise.all([first, second]);
});

test("a repeated click on the same card is ignored while its call is in flight", async () => {
  const pending = deferred();
  const { quick, calls } = setup(() => pending.promise);
  const first = dismissJobs(quick, "a"), again = dismissJobs(quick, "a");
  assert.equal(calls.length, 1);
  pending.resolve({});
  await Promise.all([first, again]);
});

test("on failure the card comes back and a short error is kept next to it", async () => {
  const { quick, raw } = setup(async () => { throw new Error("磁盘忙"); });
  const result = await dismissJobs(quick, "a");
  assert.equal(result.ok, false);
  assert.deepEqual(flagged(quick.view(raw)), [], "the card is shown again");
  assert.equal(quick.failures()["a"], "磁盘忙");
  quick.clearFailure("a");
  assert.equal(quick.failures()["a"], undefined);
});

test("a retry after a failure clears the old error and hides the card again", async () => {
  let fail = true;
  const { quick, raw } = setup(async () => { if (fail) throw new Error("x"); return {}; });
  await dismissJobs(quick, "a");
  fail = false;
  const retry = dismissJobs(quick, "a");
  assert.equal(quick.failures()["a"], undefined);
  assert.deepEqual(flagged(quick.view(raw)), ["a"]);
  await retry;
});

test("after success the patch holds until a snapshot confirms the job is gone", async () => {
  const { quick, raw } = setup(async () => ({ dismissed: ["a"] }));
  await dismissJobs(quick, "a");
  assert.deepEqual(flagged(quick.view(raw)), ["a"], "a poll that started earlier cannot bring the card back");
  quick.reconcile(raw);
  assert.deepEqual(flagged(quick.view(raw)), ["a"], "the server still lists it: keep hiding");
  const after = { ...raw, jobs: raw.jobs.filter((j) => j.id !== "a") };
  quick.reconcile(after);
  assert.deepEqual(flagged(quick.view(raw)), [], "confirmed gone: the patch is dropped");
});

test("a patch that is never confirmed expires instead of hiding the card forever", async () => {
  let now = 1000;
  const { quick, raw } = setup(async () => ({}), { now: () => now, holdMs: 5000, timers: false });
  await dismissJobs(quick, "a");
  now += 4000; quick.reconcile(raw);
  assert.deepEqual(flagged(quick.view(raw)), ["a"]);
  now += 2000; quick.reconcile(raw);
  assert.deepEqual(flagged(quick.view(raw)), [], "after the hold time the real list wins");
});

test("dismissing a job the server no longer knows counts as done, not as an error", async () => {
  const { quick, raw } = setup(async () => { throw new Error("Study job not found"); });
  const result = await dismissJobs(quick, "a");
  assert.equal(result.ok, true);
  assert.equal(quick.failures()["a"], undefined);
  assert.deepEqual(flagged(quick.view(raw)), ["a"]);
});

test("dismiss-all flags only finished jobs, once, under one key", async () => {
  const { quick, raw, calls } = setup(async () => ({ dismissed: ["a", "b"] }));
  const done = dismissJobs(quick);
  assert.deepEqual(flagged(quick.view(raw)).sort(), ["a", "b"], "the running job is never hidden");
  assert.deepEqual(calls, [["job.dismiss", { all: true }]]);
  await done;
});

test("a failed dismiss-all reports under the bulk key and restores every card", async () => {
  const { quick, raw } = setup(async () => { throw new Error("网络中断"); });
  await dismissJobs(quick);
  assert.deepEqual(flagged(quick.view(raw)), []);
  assert.equal(quick.failures()["jobs:all"], "网络中断");
});

test("marking the inbox read is optimistic and restores on failure", async () => {
  const pending = deferred();
  const { quick, raw } = setup(() => pending.promise);
  const done = markInboxRead(quick);
  const view = quick.view(raw);
  assert.equal(view.inbox.unread, 0);
  assert.ok(view.inbox.items.every((m) => m.read));
  assert.equal(raw.inbox.unread, 2);
  pending.reject(new Error("offline"));
  assert.equal((await done).ok, false);
  assert.equal(quick.view(raw).inbox.unread, 2);
  assert.equal(quick.failures()["inbox:read"], "offline");
});

test("view is stable between changes and reset forgets everything", async () => {
  const { quick, raw } = setup(async () => ({}));
  assert.equal(quick.view(raw), raw, "no patches: the very same object, so React skips re-rendering");
  await dismissJobs(quick, "a");
  const once = quick.view(raw);
  assert.equal(quick.view(raw), once, "memoised while nothing changed");
  quick.reset();
  assert.equal(quick.view(raw), raw);
});

test("an old library failure after reset cannot remove the new inbox write or its duplicate guard", async () => {
  const old = deferred(), next = deferred();
  const { quick, raw, calls } = setup(() => calls.length === 1 ? old.promise : next.promise, { timers: false });
  const first = markInboxRead(quick);
  quick.reset();
  const newLibrary = { ...raw, root: "new-library" };
  quick.view(newLibrary);
  const second = markInboxRead(quick);
  old.reject(new Error("Old library was disconnected"));
  await first;
  assert.equal(quick.view(newLibrary).inbox.unread, 0, "the new library's read patch still owns its key");
  assert.deepEqual(quick.failures(), {}, "the old error cannot appear in the new library");
  assert.equal(markInboxRead(quick), second, "a repeated click keeps the new request's duplicate guard");
  assert.equal(calls.length, 2);
  next.resolve({});
  await second;
});

test("old success and failure completions after reset cannot change the new library", async () => {
  for (const succeeds of [true, false]) {
    const old = deferred();
    const { quick, raw } = setup(() => old.promise, { timers: false });
    const done = dismissJobs(quick, "a");
    quick.reset();
    const next = { ...raw, root: "new-library" };
    quick.view(next);
    const version = quick.version();
    if (succeeds) old.resolve({}); else old.reject(new Error("Old library was disconnected"));
    await done;
    assert.equal(quick.version(), version, "a stale completion must not emit a visible change");
    assert.equal(quick.view(next), next);
    assert.deepEqual(quick.failures(), {});
  }
});

test("an old failure timer cannot clear an identical error from the new library", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { quick, raw } = setup(async () => { throw new Error("offline"); }, { errorMs: 10000 });
  await dismissJobs(quick, "a");
  t.mock.timers.tick(1000);
  quick.reset();
  quick.view({ ...raw, root: "new-library" });
  await dismissJobs(quick, "a");
  t.mock.timers.tick(9000);
  assert.equal(quick.failures().a, "offline", "the new library gets its complete error lifetime");
  t.mock.timers.tick(1000);
  assert.equal(quick.failures().a, undefined);
});

test("subscribers hear about each visible change", async () => {
  const { quick } = setup(async () => ({}));
  let heard = 0;
  const stop = quick.subscribe(() => { heard++; });
  await dismissJobs(quick, "a");
  assert.ok(heard >= 1);
  stop();
  const before = heard;
  await dismissJobs(quick, "b");
  assert.equal(heard, before);
});
