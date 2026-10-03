import test from "node:test";
import assert from "node:assert/strict";
import { createActRunner } from "../ui/act-runner.js";

/* "有时候下一题点了会卡住": act() used to hold the single-flight lock and `busy`
   across the full library snapshot refresh (about 1MB, seconds on a big library),
   so 下一题 / 继续学习 / 回到之前的第 N 题 stayed disabled until it returned. */

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((done) => setImmediate(done));

function harness(overrides = {}) {
  const log = { busy: [], errors: [], calls: [], refreshes: 0, epoch: 0, navigation: 0 };
  const calls = new Map();
  const deps = {
    call: (action, args) => { log.calls.push(action); return (calls.get(action)?.(args)) ?? Promise.resolve({ action }); },
    refresh: async () => { log.refreshes++; },
    epoch: () => log.epoch,
    navigation: () => log.navigation,
    setBusy: (value) => log.busy.push(value),
    setError: (value) => log.errors.push(value),
    holdMs: 30,
    ...overrides,
  };
  const runner = createActRunner(() => deps);
  return { runner, log, deps, handle: (action, fn) => calls.set(action, fn) };
}

test("a slow library refresh does not keep the lock or busy past the hold window", async () => {
  const slow = deferred();
  const { runner, log } = harness({ refresh: () => slow.promise, holdMs: 20 });
  const result = await runner.act("review.start", {}, undefined, { refreshAfter: true });
  assert.deepEqual(result, { action: "review.start" });
  assert.equal(runner.busy(), false, "released while the snapshot is still in flight");
  assert.equal(log.busy.at(-1), false);
  // The next navigation is accepted, not silently dropped.
  const next = await runner.act("review.move", { direction: 1 }, undefined, { refreshAfter: false });
  assert.deepEqual(next, { action: "review.move" });
  assert.deepEqual(log.calls, ["review.start", "review.move"]);
  slow.resolve();
});

test("a fast refresh is still awaited, so list-changing actions finish with fresh data", async () => {
  const order = [];
  const { runner } = harness({ refresh: async () => { await tick(); order.push("refreshed"); }, holdMs: 500 });
  await runner.act("deck.merge", {}, async () => { order.push("after"); });
  order.push("returned");
  assert.deepEqual(order, ["after", "refreshed", "returned"]);
});

test("refreshAfter can depend on the result (only a finished round reloads the library)", async () => {
  const { runner, log, handle } = harness();
  handle("review.move", ({ direction }) => Promise.resolve({ complete: direction === 99 }));
  await runner.act("review.move", { direction: 1 }, undefined, { refreshAfter: (r) => r.complete });
  assert.equal(log.refreshes, 0);
  await runner.act("review.move", { direction: 99 }, undefined, { refreshAfter: (r) => r.complete });
  assert.equal(log.refreshes, 1);
});

test("single flight stays: a second act while a write is in flight is dropped, never run twice", async () => {
  const gate = deferred();
  const { runner, log, handle } = harness();
  handle("review.answer", () => gate.promise);
  const first = runner.act("review.answer", { grade: 4 }, undefined, { refreshAfter: false });
  await tick();
  assert.equal(runner.busy(), true);
  assert.equal(await runner.act("review.answer", { grade: 4 }, undefined, { refreshAfter: false }), undefined);
  assert.equal(await runner.act("review.move", { direction: 1 }, undefined, { refreshAfter: false }), undefined);
  gate.resolve({ feedback: true });
  assert.deepEqual(await first, { feedback: true });
  assert.deepEqual(log.calls, ["review.answer"], "one answer reached the server");
  assert.equal(runner.busy(), false);
  assert.deepEqual(log.busy, [true, false]);
});

test("a rejected call surfaces its message, releases the lock and returns undefined", async () => {
  const { runner, log, handle } = harness();
  handle("review.move", () => Promise.reject(new Error("Answer this question before continuing")));
  assert.equal(await runner.act("review.move", { direction: 1 }, undefined, { refreshAfter: false }), undefined);
  assert.deepEqual(log.errors, ["", "Answer this question before continuing"]);
  assert.equal(runner.busy(), false);
  assert.equal((await runner.act("review.move", {}, undefined, { refreshAfter: false })) === undefined, true, "still rejects");
});

test("rethrow hands the failure to the caller instead of the toast", async () => {
  const { runner, log, handle } = harness();
  handle("deck.merge", () => Promise.reject(new Error("nope")));
  await assert.rejects(runner.act("deck.merge", {}, null, { rethrow: true }), /nope/);
  assert.deepEqual(log.errors, [""]);
  assert.equal(runner.busy(), false);
});

test("a failed refresh after a successful action reports the sync problem but keeps the result", async () => {
  const { runner, log } = harness({ refresh: () => Promise.reject(new Error("snapshot timed out")) });
  const result = await runner.act("review.start", {}, undefined);
  assert.deepEqual(result, { action: "review.start" });
  assert.equal(log.errors.at(-1), "snapshot timed out");
  assert.equal(runner.busy(), false);
});

test("a refresh that never settles cannot wedge the lock", async () => {
  const { runner } = harness({ refresh: () => new Promise(() => {}), holdMs: 10 });
  await runner.act("slay", {});
  assert.equal(runner.busy(), false);
  assert.ok(await runner.act("review.move", {}, undefined, { refreshAfter: false }));
});

test("a library switch mid-call discards the result and frees the lock for the new library", async () => {
  const gate = deferred();
  const { runner, log, handle } = harness();
  handle("review.start", () => gate.promise);
  let afterRan = false;
  const first = runner.act("review.start", {}, () => { afterRan = true; });
  await tick();
  log.epoch++;
  runner.reset();
  const second = await runner.act("review.get", {}, undefined, { refreshAfter: false });
  assert.deepEqual(second, { action: "review.get" });
  gate.resolve({});
  assert.equal(await first, undefined);
  assert.equal(afterRan, false);
  assert.equal(runner.busy(), false);
});

test("navigation during a pending action keeps the chosen page while refreshing its successful write", async () => {
  const gate = deferred();
  const { runner, log, handle } = harness();
  handle("review.start", () => gate.promise);
  let page = "library";
  const started = runner.act("review.start", {}, () => { page = "review"; });
  await tick();
  log.navigation++;
  page = "sources";
  const result = { id: "saved-run" };
  gate.resolve(result);
  assert.equal(await started, result, "the server action still succeeded");
  assert.equal(page, "sources", "the old result cannot override later navigation");
  assert.equal(log.refreshes, 1, "the saved run still reaches the library snapshot");
  assert.equal(runner.busy(), false);
});

test("an action callback runs while its navigation is current and receives a guard for later awaits", async () => {
  const { runner, log } = harness();
  let afterRan = false;
  await runner.act("draft.save", {}, async (_result, { isCurrent }) => {
    afterRan = true;
    assert.equal(isCurrent(), true);
    await tick();
    log.navigation++;
    assert.equal(isCurrent(), false, "callbacks can fence their own later asynchronous UI work");
  });
  assert.equal(afterRan, true);
});

test("an essential callback can run after navigation while library isolation still applies", async () => {
  const gate = deferred();
  const { runner, log, handle } = harness();
  handle("restore", () => gate.promise);
  let clearedOldState = false;
  const restored = runner.act("restore", {}, (_result, { isCurrent }) => {
    clearedOldState = true;
    assert.equal(isCurrent(), false, "essential work does not relax the UI guard");
  }, { afterNavigation: true });
  await tick();
  log.navigation++;
  gate.resolve({ restored: true });
  await restored;
  assert.equal(clearedOldState, true, "restore must clear old state on every page");
  assert.equal(log.refreshes, 1);
});

test("an essential publication chain completes after navigation without reopening its practice page", async () => {
  const publish = deferred(), save = deferred();
  const { runner, log, handle } = harness();
  handle("draft.save", () => save.promise);
  let page = "draft", published = false, started = false;
  const finished = runner.act("draft.save", {}, async (_saved, { isCurrent }) => {
    if (isCurrent()) page = "draft"; // an asynchronous commit does not create a user navigation intent
    await publish.promise;
    published = true;
    started = true;
    if (isCurrent()) page = "review";
  }, { afterNavigation: true });
  await tick();
  log.navigation++;
  page = "sources";
  save.resolve({ id: "draft" });
  await tick();
  publish.resolve({ id: "deck" });
  await finished;
  assert.equal(published, true);
  assert.equal(started, true);
  assert.equal(page, "sources");
  assert.equal(log.refreshes, 1);
});

test("a pending action's failure does not appear on the page selected afterward", async () => {
  const gate = deferred();
  const { runner, log, handle } = harness();
  handle("review.start", () => gate.promise);
  const started = runner.act("review.start");
  await tick();
  log.navigation++;
  gate.reject(new Error("Old page could not start practice"));
  await started;
  assert.deepEqual(log.errors, [""], "the old page no longer owns the global error");
  assert.equal(runner.busy(), false);
});

test("a stale operation finishing after reset does not unlock the operation that replaced it", async () => {
  const oldGate = deferred(), newGate = deferred();
  const { runner, handle } = harness();
  handle("old", () => oldGate.promise);
  handle("new", () => newGate.promise);
  const old = runner.act("old", {}, undefined, { refreshAfter: false });
  await tick();
  runner.reset();
  const replacement = runner.act("new", {}, undefined, { refreshAfter: false });
  await tick();
  oldGate.resolve({});
  await old;
  assert.equal(runner.busy(), true, "the replacement is still in flight");
  newGate.resolve({});
  await replacement;
  assert.equal(runner.busy(), false);
});

test("App wires act() through the runner and never refreshes inside the 下一题 lock", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../ui/App.jsx", import.meta.url), "utf8");
  assert.match(source, /createActRunner/);
  assert.doesNotMatch(source, /acting\.current/, "no second, hand-rolled lock");
  const reviewAct = source.slice(source.indexOf("const reviewAct ="), source.indexOf("const reviewActRef"));
  assert.doesNotMatch(reviewAct, /await refresh\(\)/, "a finished round must not hold busy for the library snapshot");
  assert.match(reviewAct, /refreshAfter/);
});
