import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { saveWorkflow, startSession, saveSessionRecord, saveSessionMaterial } from "../lib/workflows.js";

const flow = (id = "lesson", title = "概念讲解") => ({
  title, steps: [{ id, kind: "lesson", title: "读懂一个例子" }],
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new StudyService(root);
}

test("reserved step IDs are rejected by domain helpers while safe historical step IDs survive reload read-only", async (t) => {
  const service = await setup(t);
  await assert.rejects(() => service.call("workflow.save", flow()), { code: "WORKFLOW_RETIRED" });
  let session;
  await service.store.update((state) => {
    for (const id of ["__proto__", "constructor", "toString"])
      assert.throws(() => saveWorkflow(state, flow(id)), /保留/);
    const template = saveWorkflow(state, flow("__proto__1"));
    session = startSession(state, { templateId: template.id, topic: "缓存", requestId: "safe-id" });
    session = saveSessionRecord(state, { id: session.id, version: session.version, output: "我检查了缓存的有效期。" });
    session = saveSessionMaterial(state, { id: session.id, version: session.version, stepId: "__proto__1", content: "先核对请求，再检查有效期。" });
  });
  const restored = (await new StudyService(service.store.root).call("workflow.session.get", { id: session.id })).session;
  assert.equal(restored.records.__proto__1.output, "我检查了缓存的有效期。");
  assert.equal(restored.records.__proto__1.content, "先核对请求，再检查有效期。");
  assert.equal(Object.hasOwn(restored.records, "__proto__1"), true);
});

test("a persisted legacy template with a reserved step ID cannot start an unsafe session in domain helpers", async (t) => {
  const service = await setup(t);
  let template;
  await service.store.update((state) => {
    template = saveWorkflow(state, flow());
    state.workflowTemplates[0].steps[0].id = "__proto__";
  });
  const reloaded = new StudyService(service.store.root);
  await assert.rejects(() => reloaded.call("workflow.session.start", { templateId: template.id, topic: "缓存", requestId: "legacy" }), { code: "WORKFLOW_RETIRED" });
  const raw = await reloaded.store.read();
  assert.throws(() => startSession(raw, { templateId: template.id, topic: "缓存", requestId: "legacy" }), /保留/);
});

test("domain workflow save idempotency and five-flow bound stay intact while public workflow.list marks retirement", async (t) => {
  const service = await setup(t);
  let original;
  await service.store.update((state) => {
    const request = { ...flow(), title: "  概念讲解  ", requestId: "create-once" };
    original = saveWorkflow(state, request);
    const normalizedRetry = { ...request, title: "概念讲解", description: "", steps: [{
      ...request.steps[0], instructions: "", content: "", next: "$next", retry: "$stay", count: 10,
    }] };
    assert.equal(saveWorkflow(state, normalizedRetry).id, original.id);
    for (let i = 0; i < 4; i++) saveWorkflow(state, { ...flow("lesson", "流程 " + i), requestId: "extra-" + i });
    assert.throws(() => saveWorkflow(state, { ...flow(), requestId: "sixth" }), /最多保存 5/);
  });
  const listing = await new StudyService(service.store.root).call("workflow.list");
  assert.equal(listing.retired, true);
  assert.equal(listing.templates.length, 5);
});
