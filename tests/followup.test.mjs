import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { createFakeModel } from "../scripts/fake-model.mjs";

const card = {
  id: "f1", kind: "flashcard", topic: "队列", objective: "区分队列操作的失败行为",
  prompt: "add 和 offer 失败时有何不同？", answer: "add 抛异常，offer 返回特殊值。",
  hint: "有两条失败路径。", explanation: "方法成对出现，前者失败抛异常，后者返回特殊值。",
  misconception: "以为所有方法失败都会抛异常。",
  citations: [{ sourceId: "s1", quote: "方法成对出现，前者失败抛异常，后者返回特殊值。" }],
};
async function setup(t, model, coach = false) {
  const root = await mkdtemp(join(tmpdir(), "study-followup-"));
  const service = new StudyService(root, { completeLight: model, coach });
  t.after(async () => { await service.flushPrep(); await rm(root, { recursive: true, force: true }); });
  await service.call("source.add", { id: "s1", title: "Queue", text: card.citations[0].quote });
  await service.call("draft.save", { deck: { id: "d1", title: "Java", cards: [card] } });
  await service.call("draft.publish", { id: "d1" });
  return service;
}
const ref = { deckId: "d1", cardId: "f1" };
const reply = { question: "offer 失败时如何处理？", answer: "检查特殊返回值，再决定下一步。" };

test("three suggestions are on demand; polished Q&A persists without resetting review or leaking before reveal", async (t) => {
  const inputs = [];
  const service = await setup(t, async (_system, prompt) => {
    const input = JSON.parse(prompt); inputs.push(input);
    return JSON.stringify(input.question ? reply : { questions: ["为什么成对？", "怎样处理失败？", "能举例吗？"] });
  });
  const run = await service.call("review.start", { mode: "path", scope: [ref] });
  const before = await service.store.read();
  const suggestions = await service.call("card.followup.suggest", ref);
  assert.equal(suggestions.questions.length, 3);
  assert.equal((await service.store.read()).decks[0].cards[0].followups, undefined);
  const first = await service.call("card.followup", { ...ref, question: "offer失败咋办" });
  assert.equal(first.item.originalQuestion, "offer失败咋办");
  assert.equal(first.item.question, reply.question);
  const duplicate = await service.call("card.followup", { ...ref, question: "offer失败咋办" });
  assert.equal(duplicate.item.id, first.item.id);
  assert.equal(inputs.length, 2);
  const hidden = await service.call("review.get", { runId: run.id });
  assert.equal(hidden.card.followups, undefined);
  assert.equal(hidden.solution, undefined);
  assert.equal(hidden.queueVersion, run.queueVersion);
  const revealed = await service.call("review.reveal", { runId: run.id, cardId: "f1" });
  assert.equal(revealed.solution.followups[0].id, first.item.id);
  const reopened = new StudyService(service.store.root);
  assert.equal((await reopened.call("card.get", ref)).card.followups[0].id, first.item.id);
  await service.call("card.followup", { ...ref, question: "刚才的处理能举例吗？" });
  assert.equal(inputs.at(-1).history[0].question, reply.question);
  const updated = await service.call("review.get", { runId: run.id });
  assert.equal(updated.solution.followups.length, 2);
  assert.equal(updated.revealed, true);
  const after = await service.store.read();
  assert.deepEqual(after.decks[0].cards[0].review, before.decks[0].cards[0].review);
  assert.equal(after.decks[0].cards[0].revisions, undefined);
  assert.deepEqual(after.attempts, before.attempts);
});

test("concurrent duplicate questions share one generation and save; distinct questions both append", async (t) => {
  let calls = 0;
  const service = await setup(t, async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return JSON.stringify(reply); });
  const result = await Promise.all([1, 2, 3].map(() => service.call("card.followup", { ...ref, question: "为什么？" })));
  assert.equal(calls, 1);
  assert.equal(new Set(result.map((r) => r.item.id)).size, 1);
  await Promise.all(["举例？", "怎么用？"].map((question) => service.call("card.followup", { ...ref, question })));
  assert.equal((await service.call("card.get", ref)).card.followups.length, 3);
});

test("invalid model responses retry once, never save partial Q&A, and leave retry possible", async (t) => {
  let calls = 0;
  const service = await setup(t, async () => { calls++; return calls <= 2 ? '{}' : JSON.stringify(reply); });
  await assert.rejects(service.call("card.followup", { ...ref, question: "为什么？" }), /不能为空/);
  assert.equal(calls, 2);
  assert.equal((await service.call("card.get", ref)).card.followups, undefined);
  await service.call("card.followup", { ...ref, question: "为什么？" });
  await assert.rejects(service.call("card.followup", { ...ref, question: " " }), /不能为空/);
  await assert.rejects(service.call("card.followup", { ...ref, question: "问".repeat(1001) }), /最多/);
  const noModel = new StudyService(service.store.root);
  await assert.rejects(noModel.call("card.followup.suggest", ref), /模型/);
});

test("a rewrite during generation refuses an outdated answer", async (t) => {
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const service = await setup(t, () => { started(); return new Promise((resolve) => { release = resolve; }); });
  const pending = service.call("card.followup", { ...ref, question: "为什么？" });
  const rejected = assert.rejects(pending, /题目已更新/);
  await began;
  await service.call("card.update", { ...ref, patch: { explanation: "修改后的解释。" } });
  release(JSON.stringify(reply));
  await rejected;
  assert.equal((await service.call("card.get", ref)).card.followups, undefined);
});

test("followups feed opted-in personalized practice with their actual question and answer", async (t) => {
  const log = [];
  const service = await setup(t, createFakeModel({ log }), true);
  await service.call("coach.consent", { prep: true });
  const result = await service.call("card.followup", { ...ref, question: "能举例吗？" });
  await service.flushPrep();
  const request = log.map((item) => JSON.parse(item.prompt)).find((item) => item.targets);
  assert.equal(request.targets[0].followup.question, result.item.question);
  assert.equal(request.targets[0].followup.answer, result.item.answer);
  const state = await service.store.read();
  assert.equal(state.prepared.length, 1);
  assert.equal(state.prepared[0].reason, "followup");
  assert.equal(state.prepared[0].followupId, result.item.id);
  await service.call("card.followup", { ...ref, question: "能举例吗？" });
  await service.flushPrep();
  assert.equal((await service.store.read()).prepared.length, 1);
  await service.call("card.followup", { ...ref, question: "和其他方法有什么不同？" });
  await service.flushPrep();
  assert.equal((await service.store.read()).prepared.length, 2);
  const practice = await service.call("coach.practice");
  assert.equal(practice.origin.reason, "followup");
});

test("followups do not turn on disabled automatic preparation", async (t) => {
  const service = await setup(t, createFakeModel(), true);
  await service.call("coach.consent", { prep: false });
  await service.call("card.followup", { ...ref, question: "为什么？" });
  await service.flushPrep();
  assert.equal((await service.store.read()).prepared.length, 0);
});

test("suggestions share concurrent calls, persist across services, and invalidate after a new Q&A", async (t) => {
  let calls = 0;
  const service = await setup(t, async (_system, prompt, options) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const input = JSON.parse(prompt);
    assert.ok(options.maxTokens > 0);
    return JSON.stringify(input.question ? reply : { questions: ["为什么？", "怎么用？", "能举例吗？"] });
  });
  const results = await Promise.all([1, 2, 3].map(() => service.call("card.followup.suggest", ref)));
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[2]);
  const reopened = new StudyService(service.store.root);
  assert.deepEqual(await reopened.call("card.followup.suggest", ref), results[0]);
  assert.equal(calls, 1);
  await service.call("card.followup", { ...ref, question: "为什么？" });
  await service.call("card.followup.suggest", ref);
  assert.equal(calls, 3, "one answer plus one refreshed recommendation");
  await service.call("card.update", { ...ref, patch: { explanation: "新的解释内容。" } });
  await service.call("card.followup.suggest", ref);
  assert.equal(calls, 4);
});

test("malformed recommendation JSON has only one corrective retry and failures never cache", async (t) => {
  let calls = 0;
  const service = await setup(t, async () => { calls++; return "invalid JSON"; });
  await assert.rejects(service.call("card.followup.suggest", ref));
  assert.equal(calls, 2);
  await assert.rejects(service.call("card.followup.suggest", ref));
  assert.equal(calls, 4);
});

test("double-escaped model answers are saved with real line breaks; ordinary backslashes survive", async (t) => {
  const { unescapeModelText } = await import("../lib/model-text.js");
  // String.raw keeps the backslashes literal, exactly as a double-escaped model reply stores them.
  const escaped = String.raw`简单说：异步队列。\n\n## 对应本题\n\n1. 生成消息\n2. 放入队列\n- 选项 \"e\" 是误解`;
  assert.equal(
    unescapeModelText(escaped),
    '简单说：异步队列。\n\n## 对应本题\n\n1. 生成消息\n2. 放入队列\n- 选项 "e" 是误解',
  );
  for (const untouched of [
    String.raw`用 printf("\n") 输出换行`,
    String.raw`路径 C:\new\test`,
    "第一行\n第二行 " + String.raw`\n\n 保留`,
    "",
  ])
    assert.equal(unescapeModelText(untouched), untouched);
  assert.equal(unescapeModelText(undefined), undefined);

  const service = await setup(t, async () => JSON.stringify({ question: reply.question, answer: escaped }));
  const saved = await service.call("card.followup", { ...ref, question: "什么意思？" });
  assert.match(saved.item.answer, /^简单说：异步队列。\n\n## 对应本题\n/);
});

test("improving a card keeps the learner's earlier Q&A, flagged when the question itself changed", async (t) => {
  const service = await setup(t, async () => JSON.stringify(reply));
  const saved = await service.call("card.followup", { ...ref, question: "offer 为什么返回特殊值？" });
  assert.equal((await service.call("card.get", ref)).card.followups.length, 1);

  // Wording-only fix: the Q&A stays, unflagged, and still shows on the card.
  await service.call("card.update", { ...ref, patch: { explanation: "方法成对出现：前者失败抛异常，后者返回特殊值，便于调用方选择。" }, reason: "讲解更清楚" });
  let card = (await service.call("card.get", ref)).card;
  assert.equal(card.followups.length, 1, "the follow-up survives the edit");
  assert.equal(card.followups[0].id, saved.item.id);
  assert.equal(card.followups[0].staleFrom, undefined);

  // The stem changed: the Q&A is kept but marked as asked about the old version.
  await service.call("card.update", { ...ref, patch: { prompt: "add 与 offer 在队列满时分别怎么表现？" }, reason: "题干更具体" });
  card = (await service.call("card.get", ref)).card;
  assert.equal(card.followups.length, 1);
  assert.ok(card.followups[0].staleFrom, "carried over from the previous version");
  assert.equal(card.followupSuggestions, undefined, "stale suggestions are dropped");

  // Reverting keeps them too, and asking again still works on the new content.
  await service.call("card.revert", ref);
  assert.equal((await service.call("card.get", ref)).card.followups.length, 1);
  await service.call("card.followup", { ...ref, question: "那 add 呢" });
  assert.equal((await service.call("card.get", ref)).card.followups.length, 2);
});
