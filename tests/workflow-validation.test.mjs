import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const flow = (id = "lesson", title = "概念讲解") => ({
  title, steps: [{ id, kind: "lesson", title: "读懂一个例子" }],
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root);
}

test("reserved step IDs cannot create records that disappear after persistence", async (t) => {
  const service = await setup(t);
  for (const id of ["__proto__", "constructor", "toString"])
    await assert.rejects(service.call("workflow.save", flow(id)), /保留/);
  assert.equal((await new StudyService(service.store.root).call("workflow.list")).templates.length, 0);

  const template = await service.call("workflow.save", flow("__proto__1"));
  let session = await service.call("workflow.session.start", { templateId: template.id, topic: "缓存", requestId: "safe-id" });
  session = await service.call("workflow.session.record", { id: session.id, version: session.version, output: "我检查了缓存的有效期。" });
  session = await service.call("workflow.session.material", { id: session.id, version: session.version, stepId: "__proto__1", content: "先核对请求，再检查有效期。" });
  const restored = (await new StudyService(service.store.root).call("workflow.session.get", { id: session.id })).session;
  assert.equal(restored.records.__proto__1.output, "我检查了缓存的有效期。");
  assert.equal(restored.records.__proto__1.content, "先核对请求，再检查有效期。");
  assert.equal(Object.hasOwn(restored.records, "__proto__1"), true);
});

test("a persisted legacy template with a reserved step ID cannot start an unsafe session", async (t) => {
  const service = await setup(t);
  const template = await service.call("workflow.save", flow());
  await service.store.update((state) => { state.workflowTemplates[0].steps[0].id = "__proto__"; });
  const reloaded = new StudyService(service.store.root);
  await assert.rejects(reloaded.call("workflow.session.start", { templateId: template.id, topic: "缓存", requestId: "legacy" }), /保留/);
  assert.equal((await reloaded.store.read()).workflowSessions.length, 0);
});

test("create retries compare normalized original payloads across reload and later edits", async (t) => {
  const service = await setup(t);
  const request = { ...flow(), title: "  概念讲解  ", requestId: "create-once" };
  const original = await service.call("workflow.save", request);
  const normalizedRetry = { ...request, title: "概念讲解", description: "", steps: [{
    ...request.steps[0], instructions: "", content: "", next: "$next", retry: "$stay", count: 10,
  }] };
  const exact = await new StudyService(service.store.root).call("workflow.save", normalizedRetry);
  assert.equal(exact.id, original.id);
  assert.equal(exact.version, original.version);

  await assert.rejects(service.call("workflow.save", { ...request, title: "响应丢失后修改的草稿" }), /创建请求.*内容/);
  const updated = await service.call("workflow.save", { ...original, title: "已保存流程的新名字" });
  const reloaded = new StudyService(service.store.root);
  const repeated = await reloaded.call("workflow.save", normalizedRetry);
  assert.equal(repeated.id, original.id);
  assert.equal(repeated.title, updated.title);
  assert.equal(repeated.version, updated.version);
  await assert.rejects(reloaded.call("workflow.save", { ...request, title: updated.title }), /创建请求.*内容/);
  assert.equal((await reloaded.call("workflow.list")).templates.length, 1);
});

test("changed-body create retries never consume a slot or overwrite an existing flow at the five-flow limit", async (t) => {
  const service = await setup(t);
  const request = { ...flow(), requestId: "first" };
  const original = await service.call("workflow.save", request);
  for (let i = 0; i < 4; i++) await service.call("workflow.save", { ...flow("lesson", "流程 " + i), requestId: "extra-" + i });
  await assert.rejects(service.call("workflow.save", { ...request, description: "尚未保存的修改" }), /创建请求.*内容/);
  const retry = await service.call("workflow.save", request);
  assert.equal(retry.id, original.id);
  assert.equal(retry.description, "");
  await assert.rejects(service.call("workflow.save", { ...flow(), requestId: "sixth" }), /最多保存 5/);
  const listing = await new StudyService(service.store.root).call("workflow.list");
  assert.equal(listing.templates.length, 5);
  assert.equal(listing.templates.find((item) => item.id === original.id).description, "");
});
