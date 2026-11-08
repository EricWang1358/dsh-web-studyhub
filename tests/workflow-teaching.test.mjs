import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { saveWorkflow, startSession } from "../lib/workflows.js";
import { SWITCH_MODE, switchOptions } from "./helpers/runtime-switch.mjs";

const article = "## 从一次请求开始\n\n" + "这是根据缓存复用条件构造的例子：先检查请求是否能使用保存的结果，再检查结果是否仍然有效。".repeat(3);
const quote = "缓存命中要求请求可以使用已保存的结果，且结果没有过期。";

async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-teaching-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const service = new StudyService(root, { complete, ...switchOptions(SWITCH_MODE, { complete, paths: ["workflow"] }) });
  let session;
  await service.store.update((s) => {
    s.sources.push({ id: "source", title: "缓存资料", text: quote + "未命中时仍需访问原始服务。" });
    s.decks.push({ id: "deck", title: "缓存", cards: [{ id: "card", topic: "缓存", kind: "flashcard", prompt: "如何判断可复用？", answer: "检查请求和有效期", explanation: quote, citations: [{ sourceId: "source", quote }] }] });
    const template = saveWorkflow(s, { title: "讲解与复述", steps: [{ id: "lesson", kind: "lesson", title: "概念与例子" }, { id: "recall", kind: "recall", title: "复述" }] });
    session = startSession(s, { templateId: template.id, topic: "缓存", scope: [{ deckId: "deck" }], requestId: "start" });
  });
  return { service, session };
}

test("workflow.teaching.start and workflow.teaching.undo refuse as retired without calling the model", async (t) => {
  let called = 0;
  const { service, session } = await setup(t, async () => { called++; return "{}"; });
  await assert.rejects(() => service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson", mode: "lesson" }), { code: "WORKFLOW_RETIRED" });
  await assert.rejects(() => service.call("workflow.teaching.undo", { id: session.id, version: session.version, stepId: "lesson" }), { code: "WORKFLOW_RETIRED" });
  assert.equal(called, 0);
});

test("historical teaching articles, citations, help entries and estimates remain readable via read-only endpoints", async (t) => {
  let called = 0;
  const { service, session } = await setup(t, async () => { called++; return "{}"; });
  await service.store.update((s) => {
    const live = s.workflowSessions.find((item) => item.id === session.id);
    live.records.lesson = {
      content: article,
      citations: [{ sourceId: "source", quote }],
      help: [{ mode: "example", content: "补充例子", citations: [{ sourceId: "source", quote }] }],
      output: "我的疑问仍需保留",
      teaching: { status: "done", mode: "lesson" },
    };
  });
  const loaded = await service.call("workflow.session.get", { id: session.id });
  assert.equal(loaded.retired, true);
  assert.equal(loaded.session.records.lesson.content, article);
  assert.equal(loaded.session.records.lesson.help.length, 1);
  assert.equal(loaded.session.records.lesson.output, "我的疑问仍需保留");
  const estimate = await service.call("workflow.teaching.estimate", { id: session.id, stepId: "lesson", mode: "lesson" });
  assert.equal(estimate.feature, "flow");
  assert.equal(called, 0);
});
