import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { seedLibrary } from "../scripts/qa/perf-seed.mjs";
import { shareUnchanged, mergePartial } from "../ui/snapshot-share.js";
import { readLiveJobs, LIVE_JOBS } from "../ui/app/live-jobs.js";
import { taskBadge } from "../ui/tasks/task-model.js";
import { goldenRuntimeContracts } from "./fixtures/unified-runtime-contract.mjs";
import { fingerprintDiff } from "./helpers/fingerprint-diff.mjs";
import { assistantRefusal } from "../lib/assistant-boundary.js";
import { capabilityIndex } from "../lib/runtime/tools.js";

/* #886: while a job runs, its progress, stage, usage, calls and streamed output no longer move the library snapshot's fingerprint. The panel polls the
   snapshot every 2.5 s (ui/poll-schedule.js); a running job used to make every one of those polls a whole snapshot (1.96 MB on a 1 012-material library,
   docs/performance.md). Now a poll answers { unchanged } (or, once a minute, the clock's parts) until something structural changes, and the job's live
   part comes from the small read job.live.list (ui/app/live-jobs.js merges it over the snapshot's jobs). */

const NOON = new Date(2026, 9, 6, 12, 0, 10).getTime();
const POLL_MS = 2500, TEN_MINUTES = (10 * 60_000) / POLL_MS;

async function fixture(t) {
  t.mock.timers.enable({ apis: ["Date"], now: NOON });
  const root = await mkdtemp(join(tmpdir(), "study-job-live-"));
  await seedLibrary(root, { sources: 20, decks: 3, cardsPerDeck: 5, runs: 1, attempts: 10, courses: 2, largeSources: 0 });
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const work = service.runtime.work;
  // What the panel holds and what it was sent: the same steps ui/app/use-library-connection.js takes (full -> shareUnchanged, partial -> mergePartial,
  // anything but a full answer -> the live read while a job of it is active).
  const panel = { held: null, texts: {}, full: 0, partial: 0, unchanged: 0, bytes: 0, liveCalls: 0, liveBytes: 0 };
  const call = async (action, args) => {
    const value = await service.call(action, args);
    if (action === LIVE_JOBS) { panel.liveCalls++; panel.liveBytes += Buffer.byteLength(JSON.stringify(value)); }
    return value;
  };
  const poll = async () => {
    const since = panel.held?.fingerprint;
    const answer = await service.call("snapshot", since ? { since, partial: true } : {});
    panel.bytes += Buffer.byteLength(JSON.stringify(answer));
    let shared;
    if (answer.unchanged) { panel.unchanged++; shared = null; }
    else if (answer.partial) { panel.partial++; shared = mergePartial(panel.held, answer, panel.texts); }
    else { panel.full++; shared = shareUnchanged(panel.held, answer, panel.texts); }
    if (shared) { panel.held = shared.value; panel.texts = shared.texts; }
    if (!answer.unchanged && !answer.partial) return answer;
    const live = await readLiveJobs(call, panel.held, panel.texts);
    if (live) { panel.held = live.value; panel.texts = live.texts; }
    return answer;
  };
  const tick = () => t.mock.timers.tick(POLL_MS);
  return { service, root: service.store.root, work, panel, poll, tick };
}

const iso = () => new Date(Date.now()).toISOString();

/** A question run that writes nothing to the library: every tick moves its stage, its count, its calls, its tokens and the output of its running call. */
function questionRun(root) {
  const job = { id: "job-live-run", root, status: "running", deckTitle: "Fake run", kind: "quiz", requestedTotal: 40, savedCount: 0, parts: 4, batchSize: 10,
    stage: "Planning", startedAt: iso(), steps: [], tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, calls: 0 }, messages: [] };
  return {
    job,
    tick(work, i) {
      job.stage = `Writing part ${(i % 4) + 1}`;
      job.savedCount = Math.min(39, Math.floor(i / 6));
      job.tokenUsage = { uncachedInputTokens: 1000 * i, outputTokens: 120 * i, calls: i };
      const id = `author-${Math.floor(i / 10)}`;
      let step = job.steps.find((item) => item.id === id);
      if (!step) {
        for (const done of job.steps) if (done.status === "running") Object.assign(done, { status: "complete", finishedAt: iso() });
        step = { id, kind: "author", stage: "authoring", runtime: "direct", startedAt: iso(), status: "running", part: (Math.floor(i / 10) % 4) + 1, parts: 4 };
        job.steps.push(step);
        work.jobOutputs.open(job.id, id);
      }
      step.firstOutputAt ??= iso();
      work.jobOutputs.append(job.id, id, `chunk ${i} `);
    },
    end() {
      for (const done of job.steps) if (done.status === "running") Object.assign(done, { status: "complete", finishedAt: iso() });
      Object.assign(job, { status: "complete", stage: "Done", savedCount: 40, finishedAt: iso() });
    },
  };
}

/** A job of the unified runtime: its contract is its record, and every streamed chunk of its call changes the call's output preview. */
function runtimeJob(root) {
  const contract = structuredClone(goldenRuntimeContracts.running);
  const job = { id: contract.runtime.legacyId, root, type: contract.kind, status: "running", startedAt: iso(), contract };
  const callId = contract.calls[0].callId;
  return {
    job,
    tick(work, i) {
      if (i === 0) work.jobOutputs.open(job.id, callId);
      work.jobOutputs.append(job.id, callId, `streamed ${i} `);
    },
  };
}

const rowOf = (held, id) => held.jobs.find((job) => job.id === id);

test("a job that writes nothing to the library: ten minutes of progress and output cost two whole snapshots, start and end", async (t) => {
  const { work, root, panel, poll, tick } = await fixture(t);
  await poll();
  const baseline = { full: panel.full, bytes: panel.bytes };
  const run = questionRun(root), runtime = runtimeJob(root);
  work.jobs.set(run.job.id, run.job);
  work.jobs.set(runtime.job.id, runtime.job);
  const counted = () => panel.full - baseline.full;
  for (let i = 0; i < TEN_MINUTES; i++) {
    run.tick(work, i); runtime.tick(work, i);
    tick();
    const before = panel.held?.fingerprint, answer = await poll();
    if (i > 0) assert.ok(answer.unchanged || answer.partial, `poll ${i} answered a whole snapshot: ${fingerprintDiff(before, answer.fingerprint)}`);
    if (answer.partial) assert.equal(answer.jobs, undefined, "a clock-only answer carries no jobs");
  }
  assert.equal(counted(), 1, "the job's start is one whole snapshot");
  run.end();
  tick();
  const ended = await poll();
  assert.ok(!ended.unchanged && !ended.partial, "the job's end is a whole snapshot");
  assert.ok(counted() <= 2, `${counted()} whole snapshots for ten minutes of a job that wrote nothing`);
  t.diagnostic(`whole snapshots ${counted()}, partial ${panel.partial}, unchanged ${panel.unchanged}, snapshot bytes ${panel.bytes - baseline.bytes}, live reads ${panel.liveCalls} (${panel.liveBytes} bytes)`);
});

test("a question run that writes its draft N times costs at most N + 2 whole snapshots", async (t) => {
  const { service, work, root, panel, poll, tick } = await fixture(t);
  await poll();
  const start = panel.full, writes = 5;
  const run = questionRun(root);
  work.jobs.set(run.job.id, run.job);
  for (let i = 0; i < 60; i++) {
    run.tick(work, i);
    if (i % 12 === 11) {
      await service.store.update((state) => {
        let draft = state.drafts.find((item) => item.id === "draft-live");
        if (!draft) state.drafts.push(draft = { id: "draft-live", title: "Fake run", cards: [], draftVersion: 1 });
        draft.cards.push({ id: `q${i}`, kind: "flashcard", topic: "t", prompt: `p${i}`, answer: "a", citations: [] });
        draft.draftVersion += 1;
      });
      run.job.draftId = "draft-live";
    }
    tick();
    await poll();
  }
  run.end();
  tick();
  await poll();
  assert.ok(panel.full - start <= writes + 2, `${panel.full - start} whole snapshots for ${writes} draft writes`);
  assert.equal(panel.held.drafts.find((draft) => draft.id === "draft-live").cards.length, writes, "every write reached the panel");
});

test("the panel shows the live progress within one poll, and the end (status, actions, badge) within one poll", async (t) => {
  const { work, root, panel, poll, tick, service } = await fixture(t);
  await poll();
  assert.equal(panel.liveCalls, 0, "no job, no live read");
  const run = questionRun(root);
  work.jobs.set(run.job.id, run.job);
  for (let i = 0; i < 30; i++) {
    run.tick(work, i);
    tick();
    await poll();
    const shown = rowOf(panel.held, run.job.id), now = (await service.call(LIVE_JOBS)).jobs.find((job) => job.id === run.job.id);
    assert.equal(shown.savedCount, run.job.savedCount, `poll ${i}: the card's count`);
    assert.equal(shown.stage, run.job.stage, `poll ${i}: the card's stage`);
    assert.deepEqual(shown.contract.progress, now.contract.progress, `poll ${i}: the progress the task card draws is the live read's`);
    assert.deepEqual(shown.contract.usage, now.contract.usage, `poll ${i}: the usage`);
    assert.equal(shown.contract.calls.length, now.contract.calls.length, `poll ${i}: the calls of the console`);
  }
  const live = panel.liveCalls;
  assert.ok(live >= 29, `the live read ran on every poll after the start (${live})`);
  assert.equal(taskBadge(panel.held, 0).running, 1);
  run.end();
  tick();
  await poll();
  const shown = rowOf(panel.held, run.job.id);
  assert.equal(shown.status, "complete");
  assert.equal(shown.contract.status, "complete");
  assert.equal(shown.contract.actions.cancel.available, false, "nothing left to stop");
  assert.equal(shown.contract.actions.cancel.reason.code, "job-ended");
  assert.deepEqual(taskBadge(panel.held, 0), { running: 0, unseen: 1, failed: 0, total: 1 }, "the badge says it ended");
  for (let i = 0; i < 5; i++) { tick(); await poll(); }
  assert.equal(panel.liveCalls, live, "with no active job the live read is not asked");
});

test("a change of what the pages allow while the job runs (a pause asked) is a whole snapshot at the next poll", async (t) => {
  const { work, root, panel, poll, tick } = await fixture(t);
  await poll();
  const run = questionRun(root);
  work.jobs.set(run.job.id, run.job);
  run.tick(work, 0);
  tick(); await poll();
  const start = panel.full;
  Object.assign(run.job, { paused: true });
  tick();
  const answer = await poll();
  assert.ok(!answer.unchanged && !answer.partial, "the pause is in the fingerprint");
  assert.equal(panel.full, start + 1);
  assert.equal(rowOf(panel.held, run.job.id).contract.status, "pausing", "the console says it is pausing");
});

test("job.live.list answers the library's active jobs as the snapshot shows them, and nothing else", async (t) => {
  const { service, work, root, tick } = await fixture(t);
  assert.deepEqual(await service.call(LIVE_JOBS), { jobs: [] });
  const run = questionRun(root), runtime = runtimeJob(root);
  const ended = { id: "job-ended", root, status: "complete", deckTitle: "Old", startedAt: iso(), finishedAt: iso(), steps: [] };
  const elsewhere = { ...questionRun(join(root, "..", "other-library")).job, id: "job-elsewhere" };
  const part = { ...questionRun(root).job, id: "job-part", listedIn: "coach-daily-x" };
  for (const job of [run.job, runtime.job, ended, elsewhere, part]) work.jobs.set(job.id, job);
  run.tick(work, 3); runtime.tick(work, 0); runtime.tick(work, 1);
  tick();
  const snapshot = await service.call("snapshot"), live = await service.call(LIVE_JOBS);
  assert.deepEqual(live.jobs.map((job) => job.id).sort(), [run.job.id, runtime.job.id].sort(), "the active rows of this library only");
  for (const row of live.jobs) assert.deepEqual(row, rowOf(snapshot, row.id), `${row.id}: the same row the snapshot sends`);
  assert.equal(rowOf(live, runtime.job.id).contract.calls[0].outputPreview, "streamed 0 streamed 1", "the runtime call's output preview");
});

test("job.live.list asked first, before any snapshot, answers the same rows, the newest status and stage lines of the log included", async (t) => {
  const { service, work, root, tick } = await fixture(t);
  const run = questionRun(root), runtime = runtimeJob(root);
  for (const job of [run.job, runtime.job]) work.jobs.set(job.id, job);
  const same = async (when) => {
    const live = await service.call(LIVE_JOBS), snapshot = await service.call("snapshot");
    assert.equal(live.jobs.length, 2, when);
    for (const row of live.jobs) assert.deepEqual(row, rowOf(snapshot, row.id), `${when}: ${row.id} is the row the snapshot sends`);
    return rowOf(live, run.job.id);
  };
  run.tick(work, 0); runtime.tick(work, 0);
  tick();
  const first = await same("the first read");
  assert.ok(first.contract.events.some((event) => event.code === "status"), "the status line of the log is there on the first read");
  run.tick(work, 7);
  tick();
  const moved = await same("after the stage moved");
  assert.equal(moved.contract.events.at(-1).code, "stage");
  assert.equal(moved.contract.events.at(-1).text, run.job.stage, "the stage line is the newest one");
});

test("the real capability index of a library lists job.status and not job.live.list", async (t) => {
  const { service } = await fixture(t);
  const jobs = capabilityIndex(service.runtime.capabilities()).contexts.find((context) => context.id === "jobs");
  assert.match(jobs.operations, /(^| )job\.[a-z/]*\bstatus\b/, "job.status, written in the index's group form (job.message/status/wait)");
  assert.doesNotMatch(jobs.operations, /live/);
});

test("job.live.list is the panel's: the main chat is refused it and the capability index does not list it, job.status stays", () => {
  assert.match(assistantRefusal(LIVE_JOBS) || "", /not available to the assistant/);
  assert.equal(assistantRefusal("job.status"), null, "the main chat keeps its own read of a job");
  const index = JSON.stringify(capabilityIndex([{ id: "jobs", api: "jobs.v1", operations: ["job.status", LIVE_JOBS, "job.wait"].map((name) => ({ name, available: true })) }]));
  assert.doesNotMatch(index, /live/, "not listed to the assistant");
  assert.match(index, /job\.status\/wait/);
});
