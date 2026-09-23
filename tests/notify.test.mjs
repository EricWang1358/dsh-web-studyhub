import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const job = (over) => ({ id: "j1", status: "complete", stage: "Draft ready for review", count: 20, ...over });

async function service(t, notify) {
  const root = await mkdtemp(join(tmpdir(), "study-notify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root, { notify });
}

test("a finished generation tells the session what happened, without being asked", async (t) => {
  const sent = [];
  const s = await service(t, (message) => sent.push(message));
  s.announceJob(job({ deckTitle: "Design for Performance", draftId: "d9", savedCount: 18 }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].summary, "「Design for Performance」生成完成 · 18 题草稿待发布");
  assert.match(sent[0].text, /草稿 d9 已保存，18\/20 题通过审核/);
  assert.match(sent[0].text, /不要因此重新发起生成，也不要轮询任务状态/);

  s.announceJob(job({ deckTitle: "HA", status: "failed", stage: "Assessment plan is not usable", draftId: undefined }));
  assert.equal(sent[1].summary, "「HA」生成未完成：Assessment plan is not usable");
  assert.match(sent[1].text, /没有产出草稿/);

  s.announceJob(job({ status: "cancelled", stage: "Cancelled by the learner", draftId: undefined }));
  assert.match(sent[2].summary, /「题组」生成已取消/);
});

test("without a host inbox the plugin stays silent instead of failing", async (t) => {
  const s = await service(t, undefined);
  assert.equal(s.notify, null);
  assert.doesNotThrow(() => s.announceJob(job({})));
  const broken = await service(t, () => {
    throw new Error("session ended");
  });
  // announceJob runs in the job's finally: a dead session must not disturb it.
  assert.doesNotThrow(() => broken.announceJob(job({})));
});
