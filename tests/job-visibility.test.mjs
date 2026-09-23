import test from "node:test";
import assert from "node:assert/strict";
import { visibleGenerationJobs } from "../ui/job-visibility.js";

test("all active jobs remain visible alongside the three latest finished jobs", () => {
  const jobs = [
    { id: "running", status: "running" },
    { id: "old-finished", status: "complete" },
    { id: "queued", status: "queued" },
    { id: "finished-1", status: "failed" },
    { id: "finished-2", status: "complete" },
    { id: "cancelling", status: "cancelling" },
    { id: "finished-3", status: "cancelled" },
  ];
  assert.deepEqual(visibleGenerationJobs(jobs).map((job) => job.id), [
    "running", "queued", "finished-1", "finished-2", "cancelling", "finished-3",
  ]);
});
