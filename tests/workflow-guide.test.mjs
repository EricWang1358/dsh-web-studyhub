import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const quote = "缓存命中要求请求可以使用已保存的结果，且结果没有过期。";
async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-guide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, complete ? { complete } : {});
  await service.store.update((s) => {
    s.sources.push({ id: "source", title: "缓存资料", text: quote + "未命中时仍需访问原始服务。" });
    const card = (id, topic) => ({ id, topic, kind: "flashcard", prompt: `${topic}：如何判断？`, answer: "检查条件",
      explanation: quote, citations: [{ sourceId: "source", quote }] });
    s.decks.push({ id: "cache", title: "缓存设计", folder: "系统设计", cards: [card("c1", "缓存命中"), card("c2", "过期策略")] });
    s.decks.push({ id: "net", title: "网络基础", folder: "计算机网络", cards: [card("n1", "TCP 握手")] });
  });
  return service;
}

test("one sentence starts a guided session on AI-chosen material, past the goal step", async (t) => {
  const service = await setup(t, async (system, prompt) => {
    assert.match(system, /choose study material/);
    const keys = JSON.parse(prompt).topics.filter((x) => x.topic !== "TCP 握手").map((x) => x.key);
    return JSON.stringify({ keys: [...keys, "made-up-key"], title: "缓存怎么复用" });
  });
  const { session, method } = await service.call("workflow.quickstart", { goal: "我想搞懂缓存什么时候能复用", requestId: "go" });
  assert.equal(method, "ai");
  assert.equal(session.topic, "缓存怎么复用");
  assert.deepEqual(session.scope.map((r) => r.deckId), ["cache", "cache"], "unknown keys are dropped, network topics not chosen");
  assert.deepEqual(session.template.steps.map((s) => s.kind), ["overview", "lesson", "recall", "practice", "reflection"],
    "no skeleton step without a skeleton");
  assert.equal(session.currentStepId, session.template.steps[1].id);
  assert.equal(session.records[session.template.steps[0].id].output, "本次目标：我想搞懂缓存什么时候能复用");
  const recall = session.template.steps.find((s) => s.kind === "recall");
  assert.equal(recall.retry, session.template.steps.find((s) => s.kind === "lesson").id, "a weak retelling goes back to the lesson");
  const again = await service.call("workflow.quickstart", { goal: "我想搞懂缓存什么时候能复用", requestId: "go" });
  assert.equal(again.session.id, session.id, "a retried start does not create a second session");
  assert.equal((await service.store.read()).workflowTemplates.length, 0, "no template is saved to start");
});

test("without a model the goal is matched against topic and deck names", async (t) => {
  const service = await setup(t);
  const { session, method } = await service.call("workflow.quickstart", { goal: "TCP 握手", requestId: "go" });
  assert.equal(method, "match");
  assert.deepEqual(session.scope, [{ deckId: "net", topic: "TCP 握手" }]);
});

test("AI reads a retelling and suggests the next move without claiming mastery", async (t) => {
  let seen;
  const service = await setup(t, async (system, prompt) => {
    if (/choose study material/.test(system)) return JSON.stringify({ keys: [], title: "" });
    seen = JSON.parse(prompt);
    return JSON.stringify({ covered: ["说出了要检查有效期"], missing: ["没有说请求本身是否可复用"], question: "什么样的请求不能复用？",
      suggestion: "revisit", note: "方向对了。" });
  });
  let { session } = await service.call("workflow.quickstart", { goal: "缓存", requestId: "go" });
  // Move from the lesson to the retelling and write something.
  session = await service.call("workflow.session.advance", { id: session.id, version: session.version, outcome: "done", requestId: "read" });
  const recall = session.template.steps.find((s) => s.kind === "recall");
  assert.equal(session.currentStepId, recall.id);
  await assert.rejects(service.call("workflow.feedback", { id: session.id, version: session.version, stepId: recall.id }), /先写下/);
  session = await service.call("workflow.session.record", { id: session.id, version: session.version, output: "结果没过期就能用" });
  const result = await service.call("workflow.feedback", { id: session.id, version: session.version, stepId: recall.id });
  const feedback = result.session.records[recall.id].feedback;
  assert.equal(seen.retelling, "结果没过期就能用");
  assert.deepEqual(feedback.missing, ["没有说请求本身是否可复用"]);
  assert.equal(feedback.suggestion, "revisit");
  assert.equal(feedback.forOutput, "结果没过期就能用");
  assert.equal(result.session.currentStepId, recall.id, "feedback never advances the session");
  assert.equal(result.session.history.length, 2, "feedback is not an activity record");
});

const settle = async (service, id) => {
  for (let i = 0; i < 300; i++) {
    const session = (await service.store.read()).workflowSessions.find((s) => s.id === id);
    if (session.skeletonJob?.status !== "running") return session;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("skeleton job never settled");
};
const skeletonReply = (cards) => JSON.stringify({ title: "缓存的主线", overview: "先命中，再过期。",
  nodes: [{ id: "hit", term: "缓存命中", meaning: "请求可以使用已保存的结果。", cards: [cards[0]] },
    { id: "ttl", term: "过期策略", meaning: "结果过期后不能再用。", parent: "hit", cards: [cards[1]] }],
  relations: [{ from: "hit", to: "ttl", type: "prerequisite" }] });

test("a session without a skeleton can have one drafted in the background, repaired once if invalid", async (t) => {
  let skeletonCalls = 0;
  const service = await setup(t, async (system, prompt) => {
    if (/choose study material/.test(system)) return JSON.stringify({ keys: JSON.parse(prompt).topics.filter((x) => x.topic !== "TCP 握手").map((x) => x.key), title: "缓存" });
    assert.match(system, /knowledge skeleton/);
    const data = JSON.parse(prompt);
    if (++skeletonCalls === 1) return JSON.stringify({ title: "坏的", nodes: [{ id: "x", term: "x", meaning: "x", cards: ["nope"] }] });
    assert.match(data.repair, /unknown card nope/, "the rejection is sent back for repair");
    return skeletonReply(data.cards.map((c) => c.cardId));
  });
  const started = await service.call("workflow.quickstart", { goal: "缓存", requestId: "go", skeleton: true });
  assert.equal(started.skeletonJob, true);
  assert.equal(started.session.currentStepId, started.session.template.steps[1].id);
  const session = await settle(service, started.session.id);
  assert.equal(session.skeletonJob.status, "done");
  const state = await service.store.read();
  const skeleton = state.skeletons.find((k) => k.id === session.skeletonId);
  assert.equal(skeleton.title, "缓存的主线");
  assert.deepEqual(skeleton.scope, session.scope);
  assert.match(skeleton.lastChange.summary || JSON.stringify(skeleton.lastChange), /学习流后台生成/);
  assert.ok(!session.template.steps.some((s) => s.kind === "skeleton"), "the running route is not reshaped");
  const view = await service.call("workflow.session.get", { id: session.id });
  assert.equal(view.resources.skeleton.id, skeleton.id);
  await assert.rejects(service.call("workflow.skeleton.generate", { id: session.id }), /已经关联/);
});

test("background skeleton failures are recorded and can be retried; it is off unless asked", async (t) => {
  let fail = true;
  const service = await setup(t, async (system, prompt) => {
    if (/choose study material/.test(system)) return JSON.stringify({ keys: [], title: "" });
    if (fail) return JSON.stringify({ nodes: [] });
    return skeletonReply(JSON.parse(prompt).cards.map((c) => c.cardId));
  });
  const plain = await service.call("workflow.quickstart", { goal: "缓存", requestId: "plain" });
  assert.equal(plain.skeletonJob, false);
  assert.equal(plain.session.skeletonJob, undefined);
  const { session } = await service.call("workflow.quickstart", { goal: "缓存", requestId: "go", skeleton: true });
  let after = await settle(service, session.id);
  assert.equal(after.skeletonJob.status, "failed");
  assert.match(after.skeletonJob.message, /nodes/);
  assert.equal(after.skeletonId, null);
  fail = false;
  await service.call("workflow.skeleton.generate", { id: session.id });
  after = await settle(service, session.id);
  assert.equal(after.skeletonJob.status, "done");
  assert.ok(after.skeletonId);
});
