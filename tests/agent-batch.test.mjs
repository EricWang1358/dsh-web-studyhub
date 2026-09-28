import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-agent-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const quote = "分区发生时，系统只能在一致性和可用性之间取舍。";
  await service.store.update((s) => {
    s.sources.push({ id: "src", title: "CAP 讲义", text: quote + "这是 CAP 定理的核心。" });
    s.decks.push({ id: "d", title: "云", folder: "", cards: ["a", "b", "c"].map((id) => ({ id, kind: "flashcard", topic: "CAP",
      objective: `说清 ${id} 的含义`, prompt: `${id} 是什么？`, answer: `${id} 的答案`, hint: "想想分区时的取舍。",
      explanation: `${id} 原解析：分区时要在一致性和可用性之间取舍。`, misconception: "以为三者可以同时满足。",
      citations: [{ sourceId: "src", quote }] })) });
  });
  return service;
}

test("card.update.batch improves many cards in one call, reports each, and sends one letter", async (t) => {
  const service = await setup(t);
  const inboxBefore = (await service.call("inbox")).items?.length ?? 0;
  const result = await service.call("card.update.batch", { updates: [
    { cardId: "a", patch: { explanation: "a 的新解析：先说条件，再说结论。" }, reason: "补全推理" },
    { cardId: "nope", patch: { explanation: "x" }, reason: "不存在" },
    { cardId: "c", patch: { explanation: "c 的新解析：给出一个反例。" }, reason: "补反例" }] });
  assert.equal(result.updated, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results.map((r) => r.ok), [true, false, true], "a failing item does not stop the rest");
  assert.equal(result.results[0].scheduleReset, false, "an explanation fix keeps the schedule");
  const cards = (await service.store.read()).decks[0].cards;
  assert.match(cards[0].explanation, /新解析/);
  assert.match(cards[2].explanation, /反例/);
  const inbox = await service.call("inbox");
  assert.equal((inbox.items?.length ?? 0) - inboxBefore, 1, "one letter for the whole batch");
  await assert.rejects(service.call("card.update.batch", { updates: [] }), /1–100/);
});

test("card.link.batch links prerequisites in one call and reports refused cycles", async (t) => {
  const service = await setup(t);
  const result = await service.call("card.link.batch", { links: [
    { cardId: "b", requires: { cardId: "a" } },
    { cardId: "c", requires: { cardId: "b" } },
    { cardId: "a", requires: { cardId: "c" } }] });
  assert.equal(result.linked, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.results[2].ok, false, "the cycle is refused");
  const cards = (await service.store.read()).decks[0].cards;
  assert.deepEqual(cards.find((c) => c.id === "c").requires.map((r) => r.cardId), ["b"]);
});
