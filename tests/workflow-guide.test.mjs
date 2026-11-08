import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { startQuickSession } from "../lib/workflows.js";
import { SWITCH_MODE, switchOptions } from "./helpers/runtime-switch.mjs";

const quote = "缓存命中要求请求可以使用已保存的结果，且结果没有过期。";
async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-guide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, complete ? { complete, ...switchOptions(SWITCH_MODE, { complete, paths: ["workflow"] }) } : {});
  await service.store.update((s) => {
    s.sources.push({ id: "source", title: "缓存资料", text: quote + "未命中时仍需访问原始服务。" });
    const card = (id, topic) => ({ id, topic, kind: "flashcard", prompt: `${topic}：如何判断？`, answer: "检查条件",
      explanation: quote, citations: [{ sourceId: "source", quote }] });
    s.decks.push({ id: "cache", title: "缓存设计", folder: "系统设计", cards: [card("c1", "缓存命中"), card("c2", "过期策略")] });
    s.decks.push({ id: "net", title: "网络基础", folder: "计算机网络", cards: [card("n1", "TCP 握手")] });
  });
  return service;
}

test("workflow.quickstart, workflow.feedback and workflow.skeleton.generate refuse as retired without calling the model", async (t) => {
  let called = 0;
  const service = await setup(t, async () => { called++; return "{}"; });
  await assert.rejects(() => service.call("workflow.quickstart", { goal: "我想搞懂缓存什么时候能复用", requestId: "go" }), { code: "WORKFLOW_RETIRED" });
  await assert.rejects(() => service.call("workflow.feedback", { id: "any", version: 1, stepId: "recall" }), { code: "WORKFLOW_RETIRED" });
  await assert.rejects(() => service.call("workflow.skeleton.generate", { id: "any" }), { code: "WORKFLOW_RETIRED" });
  assert.equal(called, 0);
});

test("historical guided sessions and linked skeletons remain readable via workflow.session.get", async (t) => {
  const service = await setup(t);
  let seeded;
  await service.store.update((s) => {
    s.skeletons.push({
      id: "sk-1", title: "缓存的主线", overview: "先命中，再过期。", deckIds: ["cache"],
      nodes: [{ id: "hit", term: "缓存命中", meaning: "请求可以使用已保存的结果。", cards: ["c1"] }],
      relations: [],
    });
    seeded = startQuickSession(s, {
      goal: "我想搞懂缓存什么时候能复用",
      title: "缓存怎么复用",
      scope: [{ deckId: "cache", topic: "缓存命中" }],
      skeletonId: "sk-1",
      method: "ai",
      requestId: "legacy-go",
    });
  });
  const { session, resources } = await service.call("workflow.session.get", { id: seeded.id });
  assert.equal(session.topic, "缓存怎么复用");
  assert.equal(resources.skeleton.id, "sk-1");
  assert.equal(resources.cardCount, 1);
});
