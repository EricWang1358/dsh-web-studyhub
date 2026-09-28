import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-material-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update((s) => {
    s.decks.push({ id: "deck", title: "分布式", folder: "", cards: [{ id: "c1", topic: "CAP", kind: "flashcard", prompt: "C 指什么？", answer: "线性一致性" }] });
  });
  const template = await service.call("workflow.save", { title: "目标", steps: [{ id: "goal", kind: "overview", title: "明确目标" }, { id: "recall", kind: "recall", title: "复述" }] });
  const session = await service.call("workflow.session.start", { templateId: template.id, topic: "CAP", scope: [{ deckId: "deck" }], requestId: "start" });
  return { service, session };
}
const material = (service, session, extra) => service.call("workflow.session.material", { id: session.id, version: session.version, stepId: "goal", ...extra });

test("the main chat's material is appended and edited, never silently overwritten", async (t) => {
  let { service, session } = await setup(t);
  session = await material(service, session, { content: "## 第一次回答\n\nC 是线性一致性。" });
  assert.equal(session.records.goal.materialBy, "chat");
  session = await material(service, session, { content: "## 第二次回答\n\nA 是可用性。" });
  assert.match(session.records.goal.content, /第一次回答[\s\S]*第二次回答/, "a second save adds below the first");
  session = await material(service, session, { mode: "edit", edits: [{ find: "A 是可用性。", replace: "A 是未故障节点必有响应。" }] });
  assert.match(session.records.goal.content, /第一次回答[\s\S]*未故障节点必有响应/);
  assert.equal(session.records.goal.materialHistory.length, 2, "each earlier version is kept");
  await assert.rejects(material(service, session, { mode: "edit", edits: [{ find: "不存在的原文", replace: "x" }] }), /找不到原文/);
  await assert.rejects(material(service, session, { mode: "edit", edits: [{ find: "回答", replace: "x" }] }), /出现了 2 次/);
  session = await material(service, session, { mode: "replace", content: "只剩重写后的内容" });
  assert.equal(session.records.goal.content, "只剩重写后的内容");
  assert.equal(session.records.goal.materialHistory.length, 3);
  // Restoring the version before the rewrite keeps the rewrite as history too.
  session = await service.call("workflow.session.material.restore", { id: session.id, version: session.version, stepId: "goal", index: 2 });
  assert.match(session.records.goal.content, /第一次回答[\s\S]*未故障节点必有响应/);
  assert.ok(session.records.goal.materialHistory.some((h) => h.content === "只剩重写后的内容"));
  assert.equal(session.history.length, 0, "material never counts as learner activity");
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
