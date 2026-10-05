import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { generateBatched } from "../lib/batch.js";
import { authorPrompts } from "../lib/generation.js";
import { cleanDeckTitle } from "../lib/deck-title.js";
import { qualityPlan, qualityReview } from "./helpers/assessment.mjs";

/* #199: a deck's name never carries a number of questions ("架构的语境性、动态性与代价权衡 (4 题)": the 4 was the number of parts the model saw,
   written as questions and frozen into the name). The model is told not to, the program removes such a suffix from what it names, and decks that
   already have one read without it (the count is metadata: 「7 道题」 in the list). */

const source = { id: "s", title: "Notes", text: "Architecture includes the principles guiding a system's design and evolution." };

test("a count of questions at the end of a name is removed, and nothing else is", () => {
  for (const [from, to] of [
    ["架构的语境性、动态性与代价权衡 (4 题)", "架构的语境性、动态性与代价权衡"],
    ["架构的语境性（4题）", "架构的语境性"],
    ["第1步 架构思维与MOD1衔接（共 25 道题）", "第1步 架构思维与MOD1衔接"],
    ["Software architecture basics (12 questions)", "Software architecture basics"],
    ["Context and trade-offs [8 cards]", "Context and trade-offs"],
    ["Context and trade-offs · 8 题", "Context and trade-offs"],
    ["Context and trade-offs - 15 questions", "Context and trade-offs"],
    ["Context (4 题) (7 题)", "Context"],
  ]) assert.equal(cleanDeckTitle(from), to, from);
  for (const same of ["第 4 题的复盘", "Top 10 questions about caching", "Chapter (3)", "第3章 (续)", "Q4 review", "Part 2 (draft)", "(4 题)", "", "Architecture"])
    assert.equal(cleanDeckTitle(same), same, `${same} stays`);
  assert.equal(cleanDeckTitle(undefined), "");
  assert.equal(cleanDeckTitle(42), "42");
});

test("the author is told the name carries no count, and a count the model adds anyway never reaches the draft", async () => {
  const { prompt } = authorPrompts({ count: 4, kind: "quiz", sources: [source] }, { targets: [] }, { items: [] });
  assert.match(prompt, /Deck title[^"]*never[^"]*(?:number|count)/i, "the schema line itself says it");
  const model = async (system, text) => {
    const data = () => JSON.parse(text.split("REQUEST DATA:\n")[1]);
    if (system.startsWith("Plan a source-grounded assessment")) return JSON.stringify(qualityPlan({ ...data(), kind: "flashcard" }));
    if (system.startsWith("Prepare supported answers")) {
      const plan = data().assessmentPlan;
      return JSON.stringify({ items: plan.targets.map((target) => ({ targetId: target.targetId, answer: "Principles guide later choices.", reasoning: "The passage says so.", scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope" })) });
    }
    if (system.startsWith("You author")) {
      const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => ({ id: `q${index + 1}`, targetId: target.targetId, kind: "flashcard", topic: "Architecture", objective: target.objective,
        prompt: `What does the passage establish, point ${index + 1}?`, answer: "Principles guide later choices.", hint: "Think about change over time.", explanation: "The passage says so.", misconception: "Only structure.", citations: target.citations }));
      return JSON.stringify({ deck: { title: "架构的语境性、动态性与代价权衡 (4 题)", cards }, changes: [], checks: qualityReview({ cards }).checks });
    }
    return JSON.stringify(qualityReview(JSON.parse(text).candidate));
  };
  const result = await generateBatched(model, { count: 3, kind: "flashcard", sources: [source] });
  assert.equal(result.title, "架构的语境性、动态性与代价权衡");
  assert.equal(result.cards.length, 3);
});

test("existing decks and drafts read without the count suffix; the count stays a number beside the name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-title-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const card = (n) => ({ id: `q${n}`, kind: "flashcard", topic: "t", objective: `o${n}`, prompt: `Question ${n}?`, answer: "a", hint: "h", explanation: "e", misconception: "m",
    citations: [{ sourceId: "s", quote: source.text }] });
  await service.store.update((state) => {
    state.decks.push({ id: "d1", title: "架构的语境性、动态性与代价权衡 (4 题)", course: "c", cards: [card(1), card(2), card(3), card(4), card(5), card(6), card(7)], createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z" });
  });
  const draft = await service.call("draft.save", { deck: { id: "dr", title: "第1步 (25 题)", cards: [card(1)] } });
  assert.equal(draft.title, "第1步", "a saved draft is named without the count");
  await service.store.update((state) => { state.drafts.find((item) => item.id === "dr").title = "旧草稿 (9 题)"; });
  const snapshot = await service.call("snapshot");
  const deck = snapshot.decks.find((item) => item.id === "d1");
  assert.equal(deck.title, "架构的语境性、动态性与代价权衡");
  assert.equal(deck.count, 7, "the number of questions is still there, as data");
  assert.equal(snapshot.drafts.find((item) => item.id === "dr").title, "旧草稿");
  const stored = (await service.call("export")).decks.find((item) => item.id === "d1");
  assert.equal(stored.title, "架构的语境性、动态性与代价权衡 (4 题)", "the stored name is not rewritten behind the learner's back");
});

test("adding questions later does not touch the name (a continuation keeps the draft's title)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-title-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "dr", title: "架构的语境性", cards: [{ id: "q1", kind: "flashcard", topic: "t", objective: "o1", prompt: "Question 1?", answer: "a", hint: "h", explanation: "e", misconception: "m",
    citations: [{ sourceId: "s", quote: source.text }] }], editorial: { requested: 3, generated: 1, parts: 1, completedParts: 1, failures: [], generation: { sourceIds: ["s"], kind: "flashcard", language: "English" } } } });
  assert.equal(saved.title, "架构的语境性");
  assert.doesNotMatch(saved.title, /题\)|题）/);
});
