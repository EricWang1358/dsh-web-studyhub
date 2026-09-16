import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { translateSource, normalizeTranslation } from "../lib/translation.js";

/* EN 按钮：翻译存在 card.translation 上，按 digest 缓存；它不是题目内容，
   所以永不重排 SM-2、永不进修订历史，答案侧英文只在揭示后投影。 */

const source = {
  id: "s1",
  title: "并发笔记",
  text: "临界区是进程中访问共享资源的代码段，需要用互斥锁串行化访问以避免竞态条件。",
};
const flashcard = () => ({
  id: "f1",
  kind: "flashcard",
  topic: "并发",
  objective: "回忆临界区的定义",
  prompt: "什么是临界区？",
  answer: "进程中访问共享资源的代码段。",
  hint: "和共享资源有关。",
  explanation: "临界区必须被串行化访问，否则会产生竞态条件。",
  misconception: "把整段进程代码当成临界区。",
  citations: [{ sourceId: "s1", quote: "临界区是进程中访问共享资源的代码段" }],
});
const quiz = () => ({
  id: "q1",
  kind: "quiz",
  topic: "锁",
  objective: "识别互斥锁的作用",
  prompt: "互斥锁用来避免什么？",
  answer: "竞态条件",
  hint: "并发访问共享资源时会出问题。",
  explanation: "互斥锁把对共享资源的访问串行化。",
  misconception: "以为互斥锁能提升性能。",
  citations: [{ sourceId: "s1", quote: "需要用互斥锁串行化访问以避免竞态条件" }],
  options: [
    { id: "a", text: "竞态条件", correct: true, explanation: "串行化访问消除了竞态。" },
    { id: "b", text: "死锁", correct: false, explanation: "锁用得不当反而可能造成死锁。" },
    { id: "c", text: "内存泄漏", correct: false, explanation: "与资源回收无关。" },
  ],
});
const cloze = () => ({
  id: "c1",
  kind: "cloze",
  topic: "同步",
  objective: "填写保护共享数据的机制",
  prompt: "操作系统常用 {{b1}} 保护共享数据。",
  answer: "操作系统常用互斥锁保护共享数据。",
  hint: "一种加锁机制。",
  explanation: "互斥锁保证同一时刻只有一个持有者。",
  misconception: "把信号量当成唯一机制。",
  citations: [{ sourceId: "s1", quote: "临界区是进程中访问共享资源的代码段" }],
  cloze: { text: "操作系统常用 {{b1}} 保护共享数据。", answers: [{ id: "b1", value: "互斥锁" }] },
});
const enFor = (card) => {
  if (card.kind === "cloze")
    return {
      prompt: "Operating systems usually use {{b1}} to protect shared data.",
      clozeText: "Operating systems usually use {{b1}} to protect shared data.",
      answer: "Operating systems usually use mutexes to protect shared data.",
      explanation: "A mutex guarantees a single holder at a time.",
      blanks: [{ id: "b1", value: "mutex" }],
    };
  const base = {
    prompt: "EN stem for " + card.prompt,
    answer: "EN answer for " + card.answer,
    explanation: "EN explanation for " + card.explanation,
  };
  if (card.options)
    base.options = card.options.map((o) => ({
      id: o.id,
      text: "EN " + o.text,
      explanation: "EN why " + o.id,
    }));
  return base;
};

async function library(t, model) {
  const root = await mkdtemp(join(tmpdir(), "study-en-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, model ? { completeLight: model } : {});
  await service.call("source.add", source);
  await service.call("draft.save", {
    deck: { id: "d1", title: "并发", cards: [flashcard(), quiz(), cloze()] },
  });
  await service.call("draft.publish", { id: "d1" });
  return { service, deck: await service.call("deck.get", { id: "d1" }) };
}

test("card.translate caches on the card, costs one model call, and never touches scheduling", async (t) => {
  const calls = [];
  const { service } = await library(t, async (system, prompt) => {
    calls.push(prompt);
    const src = JSON.parse(prompt.split("\n\n")[0].replace(/Your previous.*$/s, "").trim());
    const card = { flashcard: flashcard(), quiz: quiz(), cloze: cloze() }[src.kind];
    return JSON.stringify(enFor(card));
  });
  const before = await service.store.read();
  const f1 = before.decks.find((d) => d.id === "d1").cards.find((c) => c.id === "f1");
  const first = await service.call("card.translate", { deckId: "d1", cardId: "f1" });
  assert.equal(first.cached, false);
  assert.equal(first.translation.prompt, "EN stem for 什么是临界区？");
  assert.equal(calls.length, 1);
  const after = await service.store.read();
  const saved = after.decks.find((d) => d.id === "d1").cards.find((c) => c.id === "f1");
  assert.deepEqual(saved.review, f1.review, "SM-2 state untouched");
  assert.equal(saved.revisions, undefined, "no revision entry");
  assert.deepEqual(after.attempts, before.attempts);
  const again = await service.call("card.translate", { deckId: "d1", cardId: "f1" });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1, "cached translation reuses the stored English");
});

test("a wording change invalidates the digest so the next request re-translates once", async (t) => {
  const calls = [];
  const { service } = await library(t, async (system, prompt) => {
    calls.push(prompt);
    const src = JSON.parse(prompt);
    const card = { flashcard: flashcard(), quiz: quiz(), cloze: cloze() }[src.kind];
    return JSON.stringify(enFor(card));
  });
  await service.call("card.translate", { deckId: "d1", cardId: "f1" });
  await service.call("card.update", {
    deckId: "d1", cardId: "f1", patch: { prompt: "临界区指什么？" }, reason: "rewrite",
  });
  const r = await service.call("card.translate", { deckId: "d1", cardId: "f1" });
  assert.equal(r.cached, false);
  assert.equal(calls.length, 2);
  const state = await service.store.read();
  const card = state.decks.find((d) => d.id === "d1").cards.find((c) => c.id === "f1");
  assert.equal(card.revisions.length, 1, "card.update owns the revision trail");
  assert.equal(card.suspended, undefined);
});

test("open runs sync the English like any other fix: no answer reset, answer side only after reveal", async (t) => {
  const { service } = await library(t, async (system, prompt) => {
    const src = JSON.parse(prompt);
    return JSON.stringify(enFor({ flashcard: flashcard(), quiz: quiz(), cloze: cloze() }[src.kind] || flashcard()));
  });
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "q1" }] });
  assert.equal(run.card.id, "q1");
  assert.equal(run.card.translation, undefined);
  await service.call("card.translate", { deckId: "d1", cardId: run.card.id });
  const healed = await service.call("review.get", { runId: run.id });
  assert.equal(healed.queueVersion, run.queueVersion, "translation is not a content change");
  assert.equal(healed.contentUpdated, false);
  assert.equal(healed.card.translation.prompt, "EN stem for 互斥锁用来避免什么？");
  assert.ok(healed.card.translation.options.every((o) => o.text && o.explanation === undefined));
  assert.equal(healed.solution, undefined, "no answer side before the reveal");
  await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["a"] });
  const graded = await service.call("review.get", { runId: run.id });
  assert.ok(graded.solution.translation.answer.startsWith("EN answer"));
  assert.ok(graded.solution.translation.options.find((o) => o.id === "a").explanation);
});

test("cloze translations must keep every {{id}} marker; a bad reply gets one corrective retry", async (t) => {
  let calls = 0;
  const { service } = await library(t, async () => {
    calls++;
    if (calls === 1)
      return JSON.stringify({ ...enFor(cloze()), clozeText: "Operating systems use locks to protect data." });
    return JSON.stringify(enFor(cloze()));
  });
  const r = await service.call("card.translate", { deckId: "d1", cardId: "c1" });
  assert.equal(calls, 2, "invalid markers trigger exactly one retry");
  assert.equal(r.translation.clozeText.includes("{{b1}}"), true);
  assert.deepEqual(r.translation.blanks, [{ id: "b1", value: "mutex" }]);
});

test("translate refuses a persistent failure, missing ids, and a card that no longer exists", async (t) => {
  const { service } = await library(t, async () => JSON.stringify({ prompt: "x" }));
  await assert.rejects(service.call("card.translate", { deckId: "d1", cardId: "f1" }), /答案/);
  await assert.rejects(service.call("card.translate", { deckId: "d1", cardId: "nope" }), /not found|No/i);
  const noModel = await library(t);
  await assert.rejects(noModel.service.call("card.translate", { deckId: "d1", cardId: "f1" }), /模型/);
});

test("translation helpers key the digest on the translated fields only", () => {
  const card = quiz();
  const a = translateSource(card);
  assert.deepEqual(Object.keys(JSON.parse(a.digest)).sort(), ["answer", "explanation", "kind", "lang", "options", "prompt"]);
  const b = translateSource({ ...card, topic: "别的主题" });
  assert.equal(a.digest, b.digest, "topic is not translated, so it does not change the digest");
  const c = translateSource({ ...card, explanation: "改了" });
  assert.notEqual(a.digest, c.digest);
  assert.throws(() => normalizeTranslation(card, null), /JSON/);
});

test("malformed translation JSON makes at most two model calls", async (t) => {
  let calls = 0;
  const { service } = await library(t, async () => { calls++; return "invalid JSON"; });
  await assert.rejects(service.call("card.translate", { deckId: "d1", cardId: "f1" }));
  assert.equal(calls, 2);
});
