import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { until } from "./helpers/wait.mjs";
import { SWITCH_MODE, switchOptions } from "./helpers/runtime-switch.mjs";

const article = "## 从一次请求开始\n\n" + "这是根据缓存复用条件构造的例子：先检查请求是否能使用保存的结果，再检查结果是否仍然有效。两项条件都满足时可以复用；否则回到原始服务取得结果。".repeat(5) +
  "\n\n## 一步一步推演\n\n" + "假设有效期是六十秒，这是为说明机制而设定的演示条件。十秒后的相同请求可以按这个策略复用，七十秒后的请求则需要回源。检查每一步的条件，而不是看到缓存就直接返回。".repeat(3) +
  "\n\n## 边界与易错点\n\n" + "有效期是业务选择的策略，并不能保证结果在所有场景里绝对最新。这里的例子是补充演示，资料本身仅给出复用和有效性的条件。".repeat(3);
const quote = "缓存命中要求请求可以使用已保存的结果，且结果没有过期。";
const generated = (markdown = article) => JSON.stringify({ markdown, citations: [{ sourceId: "source", quote }] });
const approved = JSON.stringify({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] });
async function setup(t, complete) {
  const root = await mkdtemp(join(tmpdir(), "study-workflow-teaching-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const service = new StudyService(root, { complete, ...switchOptions(SWITCH_MODE, { complete, paths: ['workflow'] }) });
  await service.store.update(s => {
    s.sources.push({ id: "source", title: "缓存资料", text: quote + "未命中时仍需访问原始服务。" });
    s.decks.push({ id: "deck", title: "缓存", cards: [{ id: "card", topic: "缓存", kind: "flashcard", prompt: "如何判断可复用？", answer: "检查请求和有效期", explanation: quote, citations: [{ sourceId: "source", quote }] }] });
  });
  const template = await service.call("workflow.save", { title: "讲解与复述", steps: [{ id: "lesson", kind: "lesson", title: "概念与例子" }, { id: "recall", kind: "recall", title: "复述" }] });
  const session = await service.call("workflow.session.start", { templateId: template.id, topic: "缓存", scope: [{ deckId: "deck" }], requestId: "start" });
  return { service, session };
}
const settled = (service, id) => until(async () => {
  const result = await service.call("workflow.session.get", { id });
  return result.session.records.lesson?.teaching?.status !== "running" && result;
}, "the teaching to settle");
// The detached worker has retired its job once it has made (or skipped) its guarded write.
const workerDone = service => until(() => service.runtime.work.workflowTeachingJobs.size === 0, "the teaching worker to finish");

test("background teaching preserves learner notes and progress after leaving its originating step", async t => {
  let release, called = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, session } = await setup(t, async (_system, prompt) => {
    called++;
    if (called === 1) { assert.match(prompt, /缓存资料/); await gate; return generated(); }
    return approved;
  });
  const started = await service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson", mode: "lesson" });
  assert.equal(started.session.records.lesson.teaching.status, "running");
  assert.equal(started.resources.teachingActive, true);
  const saved = await service.call("workflow.session.record", { id: session.id, version: started.session.version, output: "我的问题" });
  await service.call("workflow.session.advance", { id: session.id, version: saved.version, outcome: "skipped", requestId: "move" });
  release();
  const { session: done } = await settled(service, session.id);
  assert.equal(done.currentStepId, "recall");
  assert.equal(done.records.lesson.output, "我的问题");
  assert.equal(done.records.lesson.content, article);
  assert.equal(done.history.length, 1);
  assert.equal((await service.store.read()).attempts.length, 0);
});

test("a delayed teaching result does not overwrite material edited elsewhere", async t => {
  let release, called = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, session } = await setup(t, async () => { if (++called === 1) { await gate; return generated(); } return approved; });
  const started = await service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson", mode: "lesson" });
  await service.call("workflow.session.material", { id: session.id, version: started.session.version, stepId: "lesson", content: "主对话刚保存的新讲解" });
  release();
  const { session: done } = await settled(service, session.id);
  assert.equal(done.records.lesson.content, "主对话刚保存的新讲解");
  assert.equal(done.records.lesson.teaching.status, "failed");
});

test("fabricated teaching citations fail without replacing existing content", async t => {
  let calls = 0;
  const { service, session } = await setup(t, async () => { calls++; return JSON.stringify({ markdown: article, citations: [{ sourceId: "source", quote: "This sentence is fabricated and is not in the source." }] }); });
  await service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson", mode: "lesson" });
  const { session: done } = await settled(service, session.id);
  assert.equal(done.records.lesson.teaching.status, "failed");
  assert.equal(done.records.lesson.content, undefined);
  assert.equal(calls, 2);
});

test("help is additive and an improved article can be undone without changing notes", async t => {
  const requests = [];
  const { service, session } = await setup(t, async (system, prompt) => {
    if (system.startsWith("Independently")) return approved;
    const input = JSON.parse(prompt); requests.push(input.mode);
    return generated(input.mode === "improve" ? article + "\n\n改进后的例子。" : article);
  });
  let current = await service.call("workflow.session.material", { id: session.id, version: session.version, stepId: "lesson", content: "原有讲解" });
  current = await service.call("workflow.session.record", { id: session.id, version: current.version, output: "我的疑问仍需保留" });
  await service.call("workflow.teaching.start", { id: session.id, version: current.version, stepId: "lesson", mode: "example" });
  current = (await settled(service, session.id)).session;
  assert.equal(current.records.lesson.content, "原有讲解");
  assert.equal(current.records.lesson.help[0].content, article);
  await service.call("workflow.teaching.start", { id: session.id, version: current.version, stepId: "lesson", mode: "improve", request: "步骤跳跃" });
  current = (await settled(service, session.id)).session;
  assert.equal(current.records.lesson.previousContent, "原有讲解");
  assert.equal(current.records.lesson.teaching.request, "步骤跳跃");
  assert.equal(current.records.lesson.content, article + "\n\n改进后的例子。");
  const undone = await service.call("workflow.teaching.undo", { id: session.id, version: current.version, stepId: "lesson" });
  assert.equal(undone.session.records.lesson.content, "原有讲解");
  assert.equal(undone.session.records.lesson.output, "我的疑问仍需保留");
  assert.equal(undone.session.records.lesson.help.length, 1);
  assert.equal(undone.session.records.lesson.previousContent, undefined);
  assert.deepEqual(requests, ["example", "improve"]);
  assert.equal(undone.session.history.length, 0);
});

test("concurrent clicks share one job and deleting the session prevents a late resurrection", async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, session } = await setup(t, async (system) => {
    if (system.startsWith("Independently")) return approved;
    calls++; await gate; return generated();
  });
  const args = { id: session.id, version: session.version, stepId: "lesson", mode: "lesson" };
  const [a, b] = await Promise.all([service.call("workflow.teaching.start", args), service.call("workflow.teaching.start", args)]);
  assert.equal(a.session.records.lesson.teaching.id, b.session.records.lesson.teaching.id);
  await until(() => calls === 1, "the one lesson call");
  await service.call("workflow.session.delete", { id: session.id, version: a.session.version });
  release();
  await workerDone(service); // the detached worker has reached its guarded persistence write
  assert.equal((await service.store.read()).workflowSessions.length, 0);
});

test("a negative independent review cannot pass merely by returning an empty issues list", async t => {
  let reviews = 0;
  const { service, session } = await setup(t, async system => {
    if (!system.startsWith("Independently")) return generated();
    reviews++;
    return JSON.stringify({ ...JSON.parse(approved), explained: false });
  });
  await service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson" });
  const { session: done } = await settled(service, session.id);
  assert.equal(done.records.lesson.teaching.status, "failed");
  assert.equal(done.records.lesson.content, undefined);
  assert.equal(reviews, 2);
});

test("interrupted work can retry explicitly; missing models and invalid modes do not start jobs", async t => {
  const { service, session } = await setup(t, async system => system.startsWith("Independently") ? approved : generated());
  await service.store.update(s => {
    s.workflowSessions[0].records.lesson = { teaching: { id: "interrupted", mode: "lesson", status: "running" } };
  });
  assert.equal((await service.call("workflow.session.get", { id: session.id })).resources.teachingActive, false);
  const withoutModel = new StudyService(service.store.root);
  assert.equal((await withoutModel.call("workflow.session.get", { id: session.id })).resources.modelReady, false);
  await assert.rejects(withoutModel.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson" }), /模型/);
  await assert.rejects(service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson", mode: "invalid" }), /未知/);
  await service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson" });
  assert.equal((await settled(service, session.id)).session.records.lesson.teaching.status, "done");
});

test("a failed start-result read releases the job so the persisted interruption can retry", async t => {
  let calls = 0;
  const { service, session } = await setup(t, async system => { calls++; return system.startsWith("Independently") ? approved : generated(); });
  const read = service.store.read.bind(service.store);
  service.store.read = async () => { throw new Error("读取暂时失败"); };
  await assert.rejects(service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson" }), /读取暂时失败/);
  service.store.read = read;
  const interrupted = await service.call("workflow.session.get", { id: session.id });
  assert.equal(interrupted.resources.teachingActive, false);
  assert.equal(calls, 0);
  await service.call("workflow.teaching.start", { id: session.id, version: interrupted.session.version, stepId: "lesson" });
  assert.equal((await settled(service, session.id)).session.records.lesson.teaching.status, "done");
});

test("a timed-out model call cannot trigger review or repair after it eventually returns", async t => {
  const setTimeoutOriginal = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => setTimeoutOriginal(callback, ms === 240000 ? 20 : ms, ...args));
  let release, calls = 0, returned = false;
  const gate = new Promise(resolve => { release = resolve; });
  // The request ends however it likes; a model that is stopped (the runtime hands it the Job's signal) answers with the stop.
  const { service, session } = await setup(t, async (_system, _prompt, options) => {
    calls++;
    const stopped = new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    try { await Promise.race([gate, stopped]); returned = true; return generated(); } catch (error) { returned = true; throw error; }
  });
  await service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson" });
  const failed = await settled(service, session.id);
  assert.equal(failed.session.records.lesson.teaching.status, "failed");
  assert.match(failed.session.records.lesson.teaching.message, /超时/);
  release();
  await until(() => returned, "the late model call to return");
  for (let turn = 0; turn < 25; turn++) await new Promise(resolve => setImmediate(resolve)); // a review or repair would have been requested by now
  assert.equal(calls, 1);
  assert.equal((await service.call("workflow.session.get", { id: session.id })).session.records.lesson.content, undefined);
});

test("a first article has nothing to undo, so undo never blanks the lesson", async t => {
  const { service, session } = await setup(t, async (system) => system.startsWith("Independently") ? approved : generated());
  await service.call("workflow.teaching.start", { id: session.id, version: session.version, stepId: "lesson", mode: "lesson" });
  const { session: done } = await settled(service, session.id);
  assert.equal(done.records.lesson.content, article);
  assert.equal("previousContent" in done.records.lesson, false);
  await assert.rejects(service.call("workflow.teaching.undo", { id: session.id, version: done.version, stepId: "lesson" }), /没有可撤销/);
});

test("a remedy re-teaches the retelling's gaps as a help section that keeps the request", async t => {
  const requests = [];
  const { service, session } = await setup(t, async (system, prompt) => {
    if (system.startsWith("Independently")) return approved;
    const input = JSON.parse(prompt); requests.push([input.mode, input.request]);
    return generated(input.mode === "remedy" ? article + "\n\n针对缺口的补讲。" : article);
  });
  let current = await service.call("workflow.session.material", { id: session.id, version: session.version, stepId: "lesson", content: "原有讲解" });
  await service.call("workflow.teaching.start", { id: session.id, version: current.version, stepId: "lesson", mode: "remedy", request: "没有说明过期条件；缺少例子" });
  current = (await settled(service, session.id)).session;
  assert.deepEqual(requests, [["remedy", "没有说明过期条件；缺少例子"]]);
  assert.equal(current.records.lesson.content, "原有讲解", "the article itself is kept");
  const [help] = current.records.lesson.help;
  assert.equal(help.kind, "remedy");
  assert.equal(help.title, "针对复述补讲");
  assert.equal(help.request, "没有说明过期条件；缺少例子");
  assert.match(help.content, /针对缺口的补讲/);
});
