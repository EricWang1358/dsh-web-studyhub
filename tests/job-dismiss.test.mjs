import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const text = "容器镜像把应用和它的运行环境打包在一起，交付到服务器上时已经是成型的产物，使用方不必再自行编译安装。".repeat(4);

test("已知与删除 removes a finished job's card and keeps active ones", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-job-dismiss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async () => { throw new Error("model down"); } });
  await service.call("source.add", { id: "s", title: "容器笔记", text });
  const first = await service.call("generate", { sourceIds: ["s"], count: 1, kind: "flashcard" });
  const second = await service.call("generate", { sourceIds: ["s"], count: 1, kind: "flashcard" });
  for (const job of [first, second]) await service.call("job.wait", { jobId: job.jobId });
  const ids = async () => (await service.call("snapshot")).jobs.map((j) => j.id);
  assert.deepEqual((await ids()).sort(), [first.jobId, second.jobId].sort(), "both finished jobs show on the desk");
  assert.deepEqual(await service.call("job.dismiss", { jobId: first.jobId }), { dismissed: [first.jobId] });
  assert.deepEqual(await ids(), [second.jobId]);
  await service.call("job.dismiss", { all: true });
  assert.deepEqual(await ids(), []);
  await assert.rejects(service.call("job.dismiss", {}), /jobId or all/);
  await assert.rejects(service.call("job.dismiss", { jobId: first.jobId }), /not found/i);
});
