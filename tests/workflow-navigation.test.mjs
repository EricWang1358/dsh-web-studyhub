import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-nav-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update((s) => {
    s.decks.push({ id: "deck", title: "一致性", folder: "", cards: ["c1", "c2"].map((id) => ({ id, topic: "CAP", kind: "flashcard", prompt: `${id} 问题`, answer: `${id} 答案` })) });
  });
  const template = await service.call("workflow.save", { title: "练习", steps: [
    { id: "goal", kind: "overview", title: "明确目标" }, { id: "lesson", kind: "lesson", title: "概念与例子" },
    { id: "practice", kind: "practice", title: "题目练习", count: 2 }, { id: "wrap", kind: "reflection", title: "总结" }] });
  const session = await service.call("workflow.session.start", { templateId: template.id, topic: "CAP", scope: [{ deckId: "deck" }], requestId: "start" });
  return { service, session };
}
const advance = (service, session, requestId, extra = {}) =>
  service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId, ...extra });

test("the route is two-way: back to a walked step and back to the frontier, recording nothing", async (t) => {
  let { service, session } = await setup(t);
  session = await advance(service, session, "a", { output: "本次目标：说清 CAP" });
  session = await service.call("workflow.session.material", { id: session.id, version: session.version, stepId: "lesson", content: "讲解正文" });
  session = await advance(service, session, "b");
  assert.equal(session.currentStepId, "practice");
  await assert.rejects(service.call("workflow.session.goto", { id: session.id, version: session.version, stepId: "wrap" }), /已经走过/);
  const before = JSON.stringify(session.records);
  session = await service.call("workflow.session.goto", { id: session.id, version: session.version, stepId: "goal" });
  assert.equal(session.currentStepId, "goal");
  assert.equal(session.resumeStepId, "practice", "the frontier is remembered");
  assert.equal(JSON.stringify(session.records), before, "no record changes");
  assert.equal(session.history.length, 2, "moving around is not activity");
  session = await service.call("workflow.session.goto", { id: session.id, version: session.version, stepId: "lesson" });
  assert.equal(session.resumeStepId, "practice", "hopping between walked steps keeps the frontier");
  session = await service.call("workflow.session.goto", { id: session.id, version: session.version, stepId: "practice" });
  assert.equal(session.currentStepId, "practice");
  assert.equal(session.resumeStepId, undefined);
  // Walking forward from an earlier step onto the frontier also clears it.
  session = await service.call("workflow.session.goto", { id: session.id, version: session.version, stepId: "lesson" });
  session = await advance(service, session, "c");
  assert.equal(session.currentStepId, "practice");
  assert.equal(session.resumeStepId, undefined);
  assert.equal(session.records.lesson.content, "讲解正文");
});

test("practice runs as an ordinary review round that knows its learning flow", async (t) => {
  let { service, session } = await setup(t);
  session = await advance(service, session, "a", { output: "目标" });
  session = await advance(service, session, "b");
  const { run } = await service.call("workflow.practice.start", { id: session.id, version: session.version });
  assert.equal(run.title, "学习流 · CAP");
  assert.deepEqual(run.workflow, { sessionId: session.id, topic: "CAP", stepTitle: "题目练习", stepIndex: 2, stepCount: 4, current: true });
  let { resources } = await service.call("workflow.session.get", { id: session.id });
  assert.deepEqual(resources.practice, { runId: run.id, total: 2, answered: 0, correct: 0, complete: false, ended: false });
  // Answer both in the review page, as the learner would.
  let current = await service.call("review.get", { runId: run.id });
  while (!current.complete) {
    const ref = { runId: run.id, cardId: current.card.id, queueVersion: current.queueVersion };
    await service.call("review.reveal", ref);
    current = await service.call("review.answer", { ...ref, grade: 4 });
    if (!current.complete && current.feedback) current = await service.call("review.move", { runId: run.id, direction: 1 });
  }
  ({ session, resources } = await service.call("workflow.session.get", { id: session.id }));
  assert.equal(resources.practice.answered, 2);
  assert.equal(resources.practice.complete, true);
  const again = await service.call("workflow.practice.start", { id: session.id, version: session.version, fresh: true });
  assert.notEqual(again.run.id, run.id, "再练一轮 starts a new round");
  assert.equal((await service.call("workflow.session.get", { id: session.id })).resources.practice.answered, 0);
});
