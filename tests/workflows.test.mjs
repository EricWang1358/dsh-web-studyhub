import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { defaultWorkflow } from "../lib/workflow-contract.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root);
}
test("workspace and chat share a five-template bound even with concurrent saves", async (t) => {
  const service = await setup(t);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.call("workflow.save", defaultWorkflow())));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal((await service.call("workflow.list")).templates.length, 5);
  const one = results.find((r) => r.status === "fulfilled").value;
  const saved = await service.call("workflow.save", { ...one, title: "我的方法" });
  await assert.rejects(service.call("workflow.save", { ...one, title: "过期修改" }), /已更新/);
  assert.equal(saved.title, "我的方法");
});
test("session snapshot, output, transitions and pause survive reload without changing cards", async (t) => {
  const service = await setup(t);
  const template = await service.call("workflow.save", { title: "复述", steps: [
    { id: "recall", kind: "recall", title: "讲清楚", next: "$next", retry: "$stay" },
    { id: "reflection", kind: "reflection", title: "总结" }] });
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "没有题目的新主题", requestId: "start" });
  assert.equal((await service.call("workflow.session.start", { templateId: template.id, topic: "同一次", requestId: "start" })).id, session.id);
  await service.call("workflow.save", { ...template, title: "新方法" });
  await service.call("workflow.delete", { id: template.id, version: 2 });
  assert.equal((await service.call("workflow.session.get", { id: session.id })).session.template.title, "复述");
  await assert.rejects(service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "a" }), /写下/);
  session = await service.call("workflow.session.record", { id: session.id, version: session.version, output: "我的解释" });
  const first = { id: session.id, version: session.version, outcome: "done", requestId: "a" };
  session = await service.call("workflow.session.advance", first);
  assert.equal((await service.call("workflow.session.advance", first)).version, session.version);
  assert.equal(session.currentStepId, "reflection");
  session = await service.call("workflow.session.status", { id: session.id, version: session.version, status: "paused" });
  const restored = await new StudyService(service.store.root).call("workflow.session.get", { id: session.id });
  assert.equal(restored.session.status, "paused");
  assert.equal(restored.session.records.recall.output, "我的解释");
  await assert.rejects(service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "skipped", requestId: "b" }), /继续/);
  session = await service.call("workflow.session.status", { id: session.id, version: session.version, status: "active" });
  session = await service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "skipped", requestId: "b" });
  assert.equal(session.status, "completed");
  assert.equal(session.history[1].outcome, "skipped");
  assert.deepEqual((await service.store.read()).attempts, []);
});
test("invalid branches fail atomically and a main-session material update cannot write a stale step", async (t) => {
  const service = await setup(t);
  await assert.rejects(service.call("workflow.save", { title: "坏流程", steps: [{ id: "a", kind: "overview", title: "a", next: "missing" }] }), /不存在/);
  const template = await service.call("workflow.save", defaultWorkflow());
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "架构", requestId: "start" });
  const stale = { id: session.id, version: session.version, stepId: session.currentStepId, content: "例子与推导" };
  session = await service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "step" });
  await assert.rejects(service.call("workflow.session.material", stale), /已更新/);
  const context = await service.call("workflow.context", { sessionId: session.id });
  assert.equal(context.session.currentStepId, "step-2");
  assert.equal(context.components.length, 6);
});
