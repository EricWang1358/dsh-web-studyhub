import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { saveWorkflow, startSession, advanceSession, goToStep, saveSessionMaterial } from "../lib/workflows.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-nav-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  let session;
  await service.store.update((s) => {
    s.decks.push({ id: "deck", title: "一致性", folder: "", cards: ["c1", "c2"].map((id) => ({ id, topic: "CAP", kind: "flashcard", prompt: `${id} 问题`, answer: `${id} 答案` })) });
    const template = saveWorkflow(s, { title: "练习", steps: [
      { id: "goal", kind: "overview", title: "明确目标" }, { id: "lesson", kind: "lesson", title: "概念与例子" },
      { id: "practice", kind: "practice", title: "题目练习", count: 2 }, { id: "wrap", kind: "reflection", title: "总结" }] });
    session = startSession(s, { templateId: template.id, topic: "CAP", scope: [{ deckId: "deck" }], requestId: "start" });
  });
  return { service, session };
}

test("historical walked steps and frontier state remain readable while public navigation RPCs refuse as retired", async (t) => {
  let { service, session } = await setup(t);
  await service.store.update((s) => {
    session = advanceSession(s, { id: session.id, version: session.version, outcome: "done", requestId: "a", output: "本次目标：说清 CAP" });
    session = saveSessionMaterial(s, { id: session.id, version: session.version, stepId: "lesson", content: "讲解正文" });
    session = advanceSession(s, { id: session.id, version: session.version, outcome: "done", requestId: "b" });
    session = goToStep(s, { id: session.id, version: session.version, stepId: "goal" });
  });
  const { session: loaded } = await service.call("workflow.session.get", { id: session.id });
  assert.equal(loaded.currentStepId, "goal");
  assert.equal(loaded.resumeStepId, "practice");
  assert.equal(loaded.records.lesson.content, "讲解正文");
  await assert.rejects(() => service.call("workflow.session.goto", { id: session.id, version: loaded.version, stepId: "practice" }), { code: "WORKFLOW_RETIRED" });
  await assert.rejects(() => service.call("workflow.session.advance", { id: session.id, version: loaded.version, outcome: "done", requestId: "c" }), { code: "WORKFLOW_RETIRED" });
  await assert.rejects(() => service.call("workflow.practice.start", { id: session.id, version: loaded.version }), { code: "WORKFLOW_RETIRED" });
});
