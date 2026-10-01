import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { JOB_STAGE_CODES, GENERATION_STAGE_TEXT, stageCodeOf, stepStageCode } from "../lib/contexts/jobs/contracts.js";

// P29: the backend reports a stable stage code next to its (English or
// Chinese) stage prose, so the UI can say where a job is in plain words of the
// learner's language instead of showing "Writing and self-checking questions".

const text = "数据库索引用额外的数据结构加快查找，但每次写入都要同步维护索引，所以写多读少的表不宜建太多索引。".repeat(6);

test("every job state maps to one of the published stage codes", () => {
  assert.deepEqual([...JOB_STAGE_CODES].sort(), ["authoring", "cancelled", "cancelling", "done", "failed", "partial",
    "planning", "publishing", "queued", "repairing", "reviewing"].sort());
  const cases = [
    [{ status: "queued", stage: "Waiting for the previous generation" }, "queued"],
    [{ status: "running", stage: "Planning evidence and learning targets · Group 1/2" }, "planning"],
    [{ status: "running", stage: "Writing source-grounded questions" }, "authoring"],
    [{ status: "running", stage: "Parallel generation · up to 3 batches" }, "authoring"],
    [{ status: "running", type: "supplement", stage: "Publishing reviewed questions into the requested deck" }, "publishing"],
    [{ status: "running", type: "draft-publish", stage: "发布前逐题复审 2/5" }, "publishing"],
    [{ status: "running", type: "draft-repair", stage: "修复第 1/3 题" }, "repairing"],
    [{ status: "cancelling", stage: "Stopping generation workers; keeping approved draft" }, "cancelling"],
    [{ status: "cancelled", stage: "Generation cancelled; approved questions were retained" }, "cancelled"],
    [{ status: "failed", stage: "Study subagent error: llm-deepseek: no API key for provider route" }, "failed"],
    [{ status: "complete", stage: "Draft ready for review", savedCount: 4, requestedTotal: 4 }, "done"],
    [{ status: "complete", stage: "Draft ready with 3/5 questions; 1 part(s) failed", savedCount: 3, requestedTotal: 5 }, "partial"],
    [{ status: "complete", type: "draft-publish", stage: "已发布 4 题" }, "done"],
    [{ status: "partial", type: "draft-repair", stage: "已修好 1/2 题；其余题留在草稿，请查看待处理问题" }, "partial"],
  ];
  for (const [job, code] of cases) assert.equal(stageCodeOf(job), code, JSON.stringify(job));
  assert.equal(stageCodeOf({ type: "audio-import", status: "running", stage: "转写 1/3" }), undefined, "audio jobs keep their own phases");
  assert.equal(stageCodeOf(null), undefined);
});

test("the stage prose the generator emits is the prose the codes are read from", () => {
  for (const [code, prose] of Object.entries(GENERATION_STAGE_TEXT)) {
    assert.equal(stepStageCode({ stage: prose }), code, prose);
    assert.equal(stepStageCode({ stage: `Part 2/3 · ${prose}` }), code, "batch prefixes keep the code");
  }
  assert.equal(stepStageCode({ stage: "独立复审 q3" }), "reviewing");
  assert.equal(stepStageCode({ stage: "修复第 1/2 题 · 第 2 次" }), "repairing");
  assert.equal(stepStageCode({ stage: "Something new" }), undefined, "unknown prose has no code; the UI falls back to the text");
});

test("snapshot jobs and their steps carry stage codes, including the requested deck name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-wp4-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: createFakeModel() });
  await service.call("source.add", { id: "s", title: "索引笔记", text });
  const started = await service.call("generate", { sourceIds: ["s"], count: 2, kind: "flashcard", title: "索引小测" });
  const running = (await service.call("snapshot")).jobs.find((job) => job.id === started.jobId);
  assert.ok(JOB_STAGE_CODES.includes(running.stageCode), running.stageCode);
  assert.equal(running.deckTitle, "索引小测", "the card can name the deck before the first draft is saved");
  await service.call("job.wait", { jobId: started.jobId, timeoutSeconds: 30 });
  const done = (await service.call("snapshot")).jobs.find((job) => job.id === started.jobId);
  assert.equal(done.status, "complete", done.stage);
  assert.equal(done.stageCode, "done");
  assert.ok(done.steps.length >= 2);
  // Steps keep their prose untouched; the same contract classifies them.
  for (const step of done.steps) assert.ok(["planning", "authoring", "reviewing"].includes(stepStageCode(step)), `${step.stage} → ${stepStageCode(step)}`);
  assert.ok(done.steps.some((step) => stepStageCode(step) === "reviewing"));
});

test("a stopped generation says what was kept without claiming approved questions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-wp4-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: createFakeModel({ latencyMs: 200 }) });
  await service.call("source.add", { id: "s", title: "索引笔记", text });
  const first = await service.call("generate", { sourceIds: ["s"], count: 2, kind: "flashcard" });
  const queued = await service.call("generate", { sourceIds: ["s"], count: 2, kind: "flashcard" });
  const cancelled = await service.call("job.cancel", { jobId: queued.jobId });
  assert.equal(cancelled.jobs[0].status, "cancelled");
  assert.equal(cancelled.jobs[0].stageCode, "cancelled");
  const stopping = await service.call("job.cancel", { jobId: first.jobId });
  assert.equal(stopping.jobs[0].stageCode, "cancelling");
  await service.call("job.wait", { jobId: first.jobId, timeoutSeconds: 30 });
  const final = (await service.call("snapshot")).jobs.find((job) => job.id === first.jobId);
  assert.equal(final.status, "cancelled");
  assert.equal(final.stageCode, "cancelled");
  assert.doesNotMatch(final.stage, /approved questions were retained/, "nothing was approved when nothing was saved");
});
