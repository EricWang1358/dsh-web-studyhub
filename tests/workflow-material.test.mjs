import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { saveWorkflow, startSession, saveSessionMaterial, restoreSessionMaterial } from "../lib/workflows.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  let session;
  await service.store.update((s) => {
    s.decks.push({ id: "deck", title: "分布式", folder: "", cards: [{ id: "c1", topic: "CAP", kind: "flashcard", prompt: "C 指什么？", answer: "线性一致性" }] });
    const template = saveWorkflow(s, { title: "目标", steps: [{ id: "goal", kind: "overview", title: "明确目标" }, { id: "recall", kind: "recall", title: "复述" }] });
    session = startSession(s, { templateId: template.id, topic: "CAP", scope: [{ deckId: "deck" }], requestId: "start" });
  });
  return { service, session };
}

test("historical step material and history stay readable while public material write RPCs refuse as retired", async (t) => {
  let { service, session } = await setup(t);
  await service.store.update((s) => {
    session = saveSessionMaterial(s, { id: session.id, version: session.version, stepId: "goal", content: "## 第一次回答\n\nC 是线性一致性。" });
    session = saveSessionMaterial(s, { id: session.id, version: session.version, stepId: "goal", content: "## 第二次回答\n\nA 是可用性。" });
    session = saveSessionMaterial(s, { id: session.id, version: session.version, stepId: "goal", mode: "edit", edits: [{ find: "A 是可用性。", replace: "A 是未故障节点必有响应。" }] });
    session = saveSessionMaterial(s, { id: session.id, version: session.version, stepId: "goal", mode: "replace", content: "只剩重写后的内容" });
    session = restoreSessionMaterial(s, { id: session.id, version: session.version, stepId: "goal", index: 2 });
  });
  const { session: loaded } = await service.call("workflow.session.get", { id: session.id });
  assert.match(loaded.records.goal.content, /第一次回答[\s\S]*未故障节点必有响应/);
  assert.ok(loaded.records.goal.materialHistory.some((h) => h.content === "只剩重写后的内容"));
  await assert.rejects(() => service.call("workflow.session.material", { id: session.id, version: loaded.version, stepId: "goal", content: "新增" }), { code: "WORKFLOW_RETIRED" });
  await assert.rejects(() => service.call("workflow.session.material.restore", { id: session.id, version: loaded.version, stepId: "goal", index: 0 }), { code: "WORKFLOW_RETIRED" });
});

test("the dashboard counts topics still outside a topic group", async (t) => {
  const { service } = await setup(t);
  let dashboard = await service.call("snapshot", {});
  assert.deepEqual(dashboard.topicGrouping, { topics: 1, groups: 0, ungrouped: 1 });
  const { topics } = await service.call("skeleton.topics", {});
  await service.call("topic.groups.save", { groups: [{ title: "一致性", topics: [topics[0].key] }] });
  dashboard = await service.call("snapshot", {});
  assert.deepEqual(dashboard.topicGrouping, { topics: 1, groups: 1, ungrouped: 0 });
});
