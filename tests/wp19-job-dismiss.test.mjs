import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperations } from "../lib/contexts/jobs/operations.js";
import { createJobCleanup } from "../lib/job-cleanup.js";
import { listAudioBatches, retireAudioBatch, sweepRetiredAudioBatches } from "../lib/audio-batch.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const ACTIVE = new Set(["queued", "running", "cancelling"]);

async function batchOn(root, batchId, extra = {}) {
  const dir = join(root, "audio-batches", batchId);
  await mkdir(join(dir, "inputs"), { recursive: true });
  await writeFile(join(dir, "inputs", "lecture.mp3"), Buffer.alloc(1024));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ id: batchId, kind: "batch",
    job: { id: `job-${batchId}`, type: "audio-import", status: "complete", batchId, filename: "lecture.mp3", ...extra } }));
  return dir;
}
const names = (root) => readdir(join(root, "audio-batches")).catch(() => []);

function operationsWith({ root = "/lib", jobs = [], cleanup, update } = {}) {
  const map = new Map(jobs.map((job) => [job.id, { root, ...job }]));
  const ports = {
    state: { root, update: update || (async () => {}) },
    work: { jobs: map, settled: new Map(), generationMessengers: new Map(), generationControllers: new Map() },
    jobServices: { activeJob: (job) => ACTIVE.has(job.status), publicJob: (job) => job, dropRetry: () => {} },
  };
  return { map, handlers: createOperations(ports, { cleanup }).handlers };
}

test("job.dismiss replies before the slow batch cleanup finishes", async () => {
  const release = deferred(), started = [];
  const cleanup = createJobCleanup({ retire: async (root, batchId) => `${root}/${batchId}.retired-x`,
    purge: async (dir) => { started.push(dir); await release.promise; } });
  const { map, handlers } = operationsWith({ cleanup,
    jobs: [{ id: "a", status: "complete", batchId: "batch-aaaaaaaa" }] });
  const reply = await Promise.race([handlers["job.dismiss"]({ jobId: "a" }), tick(200).then(() => "TIMEOUT")]);
  assert.deepEqual(reply, { dismissed: ["a"] }, "the reply must not wait for file deletion");
  assert.equal(map.has("a"), false, "the job leaves the list immediately");
  assert.equal(cleanup.pending(), 1, "the slow deletion is still running in the background");
  assert.deepEqual(started, ["/lib/batch-aaaaaaaa.retired-x"]);
  release.resolve();
  await cleanup.idle();
});

test("job.dismiss all removes finished jobs and keeps running ones", async () => {
  const cleaned = [];
  const cleanup = { dismissBatch: async (root, id) => { cleaned.push(id); } };
  const { map, handlers } = operationsWith({ cleanup, jobs: [
    { id: "a", status: "complete", batchId: "batch-aaaaaaaa" }, { id: "b", status: "failed", singleId: "single-bbbbbbb" },
    { id: "c", status: "running", batchId: "batch-cccccccc" }] });
  assert.deepEqual((await handlers["job.dismiss"]({ all: true })).dismissed.sort(), ["a", "b"]);
  assert.deepEqual([...map.keys()], ["c"]);
  assert.deepEqual(cleaned.sort(), ["batch-aaaaaaaa", "single-bbbbbbb"]);
  await assert.rejects(handlers["job.dismiss"]({ jobId: "c" }), /任务还在进行/);
});

test("a legacy job's inbox letter is pruned before the reply so it cannot reappear", async () => {
  const state = { inbox: [{ kind: "audio-failed", jobId: "L" }, { kind: "audio-failed", jobId: "other" }] };
  const { handlers } = operationsWith({ cleanup: { dismissBatch: async () => {} },
    update: async (mutate) => { mutate(state); }, jobs: [{ id: "L", status: "failed", legacy: true }] });
  await handlers["job.dismiss"]({ jobId: "L" });
  assert.deepEqual(state.inbox.map((item) => item.jobId), ["other"]);
});

test("cleanup runs in the background, is tracked, and a failure is logged not thrown", async () => {
  const release = deferred(), logged = [], purged = [];
  const cleanup = createJobCleanup({
    retire: async (root, id) => `${root}/${id}.retired-x`,
    purge: async (dir) => { purged.push(dir); await release.promise; throw new Error("EBUSY"); },
    log: (error) => logged.push(error.message) });
  await cleanup.dismissBatch("/lib", "batch-aaaaaaaa");
  assert.equal(cleanup.pending(), 1, "deletion is still running after dismissBatch resolved");
  release.resolve();
  await cleanup.idle();
  assert.equal(cleanup.pending(), 0);
  assert.deepEqual(purged, ["/lib/batch-aaaaaaaa.retired-x"]);
  assert.deepEqual(logged, ["EBUSY"]);
});

test("if the batch cannot be renamed away, dismissal waits for the real removal", async () => {
  const removed = [];
  const cleanup = createJobCleanup({ retire: async () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); },
    remove: async (root, id) => { removed.push(id); }, purge: async () => {}, log: () => {} });
  await cleanup.dismissBatch("/lib", "batch-aaaaaaaa");
  assert.deepEqual(removed, ["batch-aaaaaaaa"], "the persisted dismissal is never skipped");
});

test("dismissing the same batch twice is harmless and a retired batch is never resumed after a restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wp19-dismiss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await batchOn(root, "batch-aaaaaaaa");
  await batchOn(root, "batch-keepkeep");
  assert.equal((await listAudioBatches(root)).length, 2);
  // A purge that never finishes models the app being killed mid-cleanup.
  const crashing = createJobCleanup({ purge: () => new Promise(() => {}), log: () => {} });
  await crashing.dismissBatch(root, "batch-aaaaaaaa");
  assert.deepEqual((await listAudioBatches(root)).map((batch) => batch.id), ["batch-keepkeep"],
    "the dismissed job is not restored by the next start");
  assert.ok((await names(root)).some((name) => name.includes(".retired-")), "leftover files wait for the sweep");
  // The next start finishes the cleanup; running it twice (or over a missing batch) must not throw.
  await sweepRetiredAudioBatches(root);
  await sweepRetiredAudioBatches(root);
  assert.deepEqual(await names(root), ["batch-keepkeep"]);
  assert.equal(await retireAudioBatch(root, "batch-aaaaaaaa"), null, "an already-removed batch is a no-op");
  const real = createJobCleanup({ log: (error) => assert.fail(error) });
  await real.dismissBatch(root, "batch-aaaaaaaa");
  await real.dismissBatch(root, "batch-aaaaaaaa");
  await real.idle();
});

test("a real dismissal leaves the batch folder gone once the background removal settles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wp19-dismiss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await batchOn(root, "batch-dddddddd");
  const cleanup = createJobCleanup({ log: (error) => assert.fail(error) });
  await cleanup.dismissBatch(root, "batch-dddddddd");
  assert.deepEqual((await names(root)).filter((name) => name === "batch-dddddddd"), [], "original folder is renamed away at once");
  await cleanup.idle();
  assert.deepEqual(await names(root), []);
});
