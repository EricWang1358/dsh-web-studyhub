import test from "node:test";
import assert from "node:assert/strict";
import { visibleGenerationJobs, supplementJobLabel } from "../ui/job-visibility.js";

test('supplement task labels report persisted additions rather than a generated draft', () => {
  const job = { status: 'complete', requestedTotal: 2, savedCount: 2,
    publication: { deckId: 'target', added: 2, total: 92, rejected: 0 } };
  assert.deepEqual(supplementJobLabel(job), { text: '已补入 {0} 题 · 共 {1} 题', args: [2, 92] });
  assert.equal(supplementJobLabel({ ...job, savedCount: 1 }).text, '部分补入 {0} 题 · 共 {1} 题');
  assert.equal(supplementJobLabel({ ...job, publication: undefined }).text, '补题未完成');
  assert.equal(supplementJobLabel({ ...job, status: 'cancelled' }).text, '补题已取消');
});

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
