import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyService } from "../lib/service.js";
import { createAssistService } from "../lib/assist.js";
import { languageSystem } from "../lib/language.js";
import { TITLE_SYSTEM, PROOFREAD_SYSTEM, TRANSLATE_SYSTEM, TRANSLATE_TO_ENGLISH_SYSTEM, normalizeTranslation } from "../lib/transcript.js";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { sampleMaterial } from "../scripts/qa/fixtures.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));

async function library(t, model) {
  const base = join(repo, "output", "test-wp0");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fake-model-"));
  const service = new StudyService(root, { complete: model, completeLight: model, coach: false });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return service;
}

async function generate(service, source, args) {
  const { jobId } = await service.call("generate", { sourceIds: [source.id], title: "WP0", ...args });
  const job = await service.call("job.wait", { jobId, timeoutSeconds: 60 });
  assert.equal(job.status, "complete", job.stage);
  const draft = (await service.call("snapshot", {})).drafts.find((item) => item.id === job.draft.id);
  return { job, draft };
}

const unhandled = (log) => log.filter((entry) => !entry.handler).map((entry) => entry.system.slice(0, 80));

for (const [kind, count] of [["quiz", 3], ["multi", 3], ["cloze", 3], ["flashcard", 3], ["open", 2], ["mixed", 4]]) {
  test(`fake model drives the real generation pipeline for ${kind} cards`, async (t) => {
    const log = [];
    const service = await library(t, createFakeModel({ log }));
    const source = await service.call("source.add", sampleMaterial("zh"));
    const { job, draft } = await generate(service, source, { count, kind });
    assert.equal(job.draft.cards, count, JSON.stringify(job.draft.failures));
    assert.deepEqual(job.draft.failures, []);
    const kinds = draft.cards.map((card) => card.kind);
    if (kind === "mixed") assert.deepEqual([...new Set(kinds)].sort(), ["flashcard", "quiz"]);
    else assert.ok(kinds.every((value) => value === kind), kinds.join());
    assert.deepEqual(unhandled(log), [], "every model call of the pipeline was understood");
  });
}

test("English material gets English cards, including cloze blanks on whole words", async (t) => {
  const service = await library(t, createFakeModel());
  const source = await service.call("source.add", sampleMaterial("en"));
  const { draft } = await generate(service, source, { count: 3, kind: "cloze", language: "English" });
  assert.equal(draft.cards.length, 3);
  for (const card of draft.cards) {
    assert.doesNotMatch(card.prompt + card.explanation, /[一-鿿]/);
    const blank = card.cloze.answers[0].value;
    assert.match(blank, /^[A-Za-z]+$/);
    assert.ok(source.text.includes(card.cloze.text.replace("{{b1}}", blank)));
  }
});

test("repeated generations from the same material never collide, even with a fresh fake", async (t) => {
  const service = await library(t, createFakeModel());
  const source = await service.call("source.add", sampleMaterial("zh"));
  const first = await generate(service, source, { count: 5, kind: "quiz" });
  await service.call("draft.publish", { id: first.draft.id, draftVersion: first.draft.draftVersion });
  const second = await generate(service, source, { count: 5, kind: "quiz" });
  assert.equal(second.draft.cards.length, 5);
  // A restarted preview has a new fake whose counter starts again.
  service.complete = createFakeModel();
  const third = await generate(service, source, { count: 5, kind: "quiz" });
  assert.equal(third.draft.cards.length, 5);
  const objectives = [first, second, third].flatMap(({ draft }) => draft.cards.map((card) => card.objective));
  assert.equal(new Set(objectives).size, 15);
});

test("oral mock: the follow-up is a real question and the assessment grades every answer", async (t) => {
  const service = await library(t, createFakeModel());
  const source = await service.call("source.add", sampleMaterial("zh"));
  const { draft } = await generate(service, source, { count: 2, kind: "flashcard" });
  await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  let run = await service.call("oral.start", { count: 2 });
  await service.call("oral.answer", { runId: run.id, cardId: run.entry.cardId, answer: "下一次复习的间隔会变长，因为回忆成功说明记得更牢。" });
  run = await service.call("oral.followup", { runId: run.id, cardId: run.entry.cardId });
  assert.notEqual(run.entry.followup.trim(), "{}");
  assert.match(run.entry.followup, /[？?]$/);
  assert.doesNotMatch(run.entry.followup, /^请补充一个适用边界/, "not the no-model fallback");
  const report = await service.call("oral.submit", { runId: run.id });
  assert.equal(report.assessed, 1);
});

test("card translation, assist answers and improvements are valid for their savers", async (t) => {
  const service = await library(t, createFakeModel());
  const source = await service.call("source.add", sampleMaterial("zh"));
  const { draft } = await generate(service, source, { count: 2, kind: "cloze" });
  const { deckId } = await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  const card = (await service.call("deck.get", { id: deckId })).cards[0];
  const translated = await service.call("card.translate", { deckId, cardId: card.id });
  assert.match(JSON.stringify(translated), /\{\{b1\}\}/);

  const assist = createAssistService();
  t.after(() => assist.dispose());
  const start = (mode, text) => assist.startAssist({}, { root: service.store.root, service, sessionId: "s", mode,
    ref: { deckId, cardId: card.id }, text, helpChoices: [], card, deckTitle: "WP0", route: null, language: "zh" });
  for (const mode of ["ask", "improve"]) {
    const task = await start(mode, mode === "ask" ? "为什么间隔会变长？" : "解析再具体一点");
    let view;
    for (let i = 0; i < 100; i++) {
      view = assist.assistView(service.store.root).tasks.find((item) => item.id === task.id);
      if (view.status !== "running") break;
      await new Promise((done) => setTimeout(done, 20));
    }
    assert.equal(view.status, "done", `${mode}: ${view.message}`);
  }
});

test("every prompt family has a valid fake answer, in Chinese and English sessions", async () => {
  const log = [];
  const fake = createFakeModel({ log });
  const both = (system) => [system, languageSystem(system, "en")];
  const json = async (system, prompt) => JSON.parse(await fake(system, prompt));
  for (const system of both("You are a careful Chinese tutor writing a private StudyHub learning article, not flashcards.")) {
    const value = await json(system, JSON.stringify({ topic: "间隔重复", mode: "lesson", cards: [], evidence: [{ sourceId: "s1", text: "遗忘曲线描述了新学的内容在没有复习时会随着时间迅速变得难以回忆。" }] }));
    assert.ok(value.markdown.length >= 600);
    assert.equal(value.citations[0].sourceId, "s1");
  }
  for (const system of both("Independently review this Chinese learning article against the supplied evidence and requested mode."))
    assert.equal((await json(system, "{}")).grounded, true);
  for (const system of both("You are a warm, precise Chinese tutor reading a learner's retelling of what they just studied."))
    assert.ok((await json(system, JSON.stringify({ retelling: "短" }))).question);
  assert.ok((await json(TITLE_SYSTEM, JSON.stringify({ text: "lecture" }))).titleEn);
  assert.deepEqual((await json(PROOFREAD_SYSTEM, JSON.stringify({ transcript: "x" }))).corrections, []);
  const paragraphs = [{ n: 1, text: "First paragraph." }, { n: 2, text: "Second paragraph." }];
  assert.equal(normalizeTranslation(await json(TRANSLATE_SYSTEM, JSON.stringify({ paragraphs })), 2, "zh").paragraphs.length, 2);
  assert.equal(normalizeTranslation(await json(TRANSLATE_TO_ENGLISH_SYSTEM, JSON.stringify({ paragraphs })), 2, "en").paragraphs.length, 2);
  assert.deepEqual(unhandled(log), []);
});
