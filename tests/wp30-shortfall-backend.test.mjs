import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeck } from "../lib/generation.js";
import { generateBatched } from "../lib/batch.js";
import { StudyService } from "../lib/service.js";
import { estimateFromState } from "../lib/token-estimate.js";
import { missingQuestions, canContinueDraft, continuationKindCounts } from "../lib/draft-continuation.js";
import { authored, qualityPlan, qualityBlueprint, qualityReview, withQualityStages } from "./helpers/assessment.mjs";

/* A real run asked for 20 questions and kept 10. The other ten were dropped by
   the review and the local checks and the learner was only told "少了 10 题".
   The draft now records which question was dropped and why. */

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const card = (n, extra = {}) => ({ id: `q${n}`, kind: "flashcard", topic: "Architecture decisions", objective: `Target ${n}`,
  prompt: `Question ${n}: why does architecture contain principles guiding design and evolution?`, answer: `Principles guide later choices ${n}.`,
  hint: "Compare a description of today with a rule about permitted change.", explanation: "The quoted definition includes principles governing design and evolution.",
  misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }], ...extra });

test("a dropped candidate is kept on the draft with its prompt and the reasons it failed", async () => {
  const deck = { title: "Architecture", cards: [card(1), card(2), card(3)] };
  const review = qualityReview(deck, ["q2 的提示直接给出了答案的核心区分，与正确选项几乎同义。"]);
  review.checks[1].answerLeak = "fail";
  const request = { count: 3, kind: 'flashcard', sources: [source] }, plan = qualityPlan(request);
  plan.targets.forEach((target, index) => { target.objective = deck.cards[index].objective; });
  const replies = [plan, qualityBlueprint(request, plan, deck), authored(deck, [], plan), review];
  const result = await generateDeck(async () => JSON.stringify(replies.shift()), { count: 3, kind: "flashcard", sources: [source] });
  assert.equal(result.cards.length, 2);
  assert.equal(result.editorial.omitted.length, 1);
  const [omitted] = result.editorial.omitted;
  assert.equal(omitted.kind, "flashcard");
  assert.equal(omitted.objective, "Target 2");
  assert.match(omitted.prompt, /^Question 2/);
  assert.ok(omitted.reasons.some((reason) => /answerLeak failed/.test(reason)), JSON.stringify(omitted.reasons));
  assert.ok(omitted.reasons.every((reason) => !/^q[13]\b/.test(reason)), "only this card's reasons are attached to it");
});

test("an extra candidate without a planned knowledge point is omitted with its binding defect", async () => {
  const deck = { title: "Architecture", cards: [card(1), card(2)] };
  const request = { count: 1, kind: 'flashcard', sources: [source] }, plan = qualityPlan(request);
  const replies = [plan, qualityBlueprint(request, plan, deck), authored(deck, [], plan), qualityReview(deck)];
  const result = await generateDeck(async () => JSON.stringify(replies.shift()), { count: 1, kind: "flashcard", sources: [source] });
  assert.equal(result.cards.length, 1);
  assert.equal(result.editorial.omitted.length, 1);
  assert.match(result.editorial.omitted[0].reasons.join(' '), /unknown.*targetId|targetId.*verified knowledge/);
});

test("the batched draft collects every part's dropped questions with their part number", async () => {
  const model = async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment")) return JSON.stringify(qualityPlan(JSON.parse(prompt.split("REQUEST DATA:\n")[1])));
    if (system.startsWith("Act as a strict assessment editor")) {
      const candidate = JSON.parse(prompt).candidate, review = qualityReview(candidate);
      // The reserve target the part now tops up from (lib/generation-yield.js) is rejected too: this test is about what a dropped candidate reports.
      review.checks.forEach((check) => { if (check.cardId === "q2" || check.cardId.startsWith("reserve-")) check.optionQuality = "na", check.sourceSupport = "fail"; });
      return JSON.stringify(review);
    }
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    const deck = { title: "D", cards: Array.from({ length: request.count }, (_, i) => card(i + 1, { objective: `Part ${request.alreadyCovered.length} target ${i}`, prompt: `Question ${request.alreadyCovered.length} ${i}?` })) };
    if (system.startsWith('Prepare supported answers')) return JSON.stringify(qualityBlueprint(request, request.assessmentPlan, deck));
    return JSON.stringify(authored(deck, [], request.assessmentPlan));
  };
  const result = await generateBatched(model, { count: 3, kind: "flashcard", sources: [source] });
  assert.equal(result.cards.length, 2);
  assert.equal(result.editorial.omitted.length, 1);
  assert.equal(result.editorial.omitted[0].part, 1);
  assert.ok(result.editorial.omitted[0].reasons.some((reason) => /sourceSupport failed/.test(reason)));
});

test("a top-up keeps what the earlier run dropped next to what it drops itself", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-topup-omitted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const earlier = [{ part: 1, kind: "flashcard", objective: "Old target", prompt: "Old question?", reasons: ["q2: answerLeak failed or was not checked"] }];
  const saved = await service.call("draft.save", { deck: { id: "partial", title: "Architecture", cards: [card(1)],
    editorial: { requested: 2, generated: 1, parts: 1, completedParts: 1, failures: [], omitted: earlier,
      generation: { sourceIds: [source.id], kind: "flashcard" } } } });
  service.complete = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "More", cards: [card(2, { id: "n1", objective: "New target", prompt: "New question?" })].slice(0, request.count) });
  });
  const started = await service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion });
  assert.equal((await service.call("job.wait", { jobId: started.jobId })).status, "complete");
  const draft = (await service.call("export")).drafts[0];
  assert.equal(draft.cards.length, 2);
  assert.deepEqual(draft.editorial.omitted, earlier, "the history of what was dropped is not lost when the draft is topped up");
});

test("the continuation rules are one set of functions", () => {
  const draft = { cards: [{ kind: "quiz", id: "a" }, { kind: "quiz", id: "b" }], editorial: { requested: 5, generation: { sourceIds: ["s"], kind: "mixed" } } };
  assert.equal(missingQuestions(draft), 3);
  assert.equal(canContinueDraft(draft), true);
  assert.deepEqual(continuationKindCounts(draft), { quiz: 1, flashcard: 2 });
  assert.equal(canContinueDraft({ ...draft, editingDeckId: "d" }), false);
  assert.equal(canContinueDraft({ ...draft, editorial: { ...draft.editorial, generation: { sourceIds: ["s"], kind: "case" } } }), false);
  assert.equal(canContinueDraft({ ...draft, editorial: { ...draft.editorial, rejectedIssues: { a: ["x"] } } }), false);
  assert.equal(missingQuestions({ cards: [], editorial: {} }), 0);
});

test("the estimate before a top-up prices only the missing questions", () => {
  const long = (n) => `Section ${n}. ${"Architecture includes the principles guiding a system's design and evolution. ".repeat(40)}`;
  const state = { sources: [{ id: "s", title: "Notes", text: long(1) }], decks: [], courses: [], settings: {}, attempts: [], runs: [],
    drafts: [{ id: "d", title: "T", cards: [card(1)], editorial: { requested: 6, parts: 2, completedParts: 1,
      generation: { sourceIds: ["s"], kind: "flashcard", language: "English" } } }] };
  const topUp = estimateFromState("generate", { resumeDraftId: "d" }, state, {});
  const whole = estimateFromState("generate", { sourceIds: ["s"], count: 6, kind: "flashcard", language: "English" }, state, {});
  assert.ok(topUp.calls.low >= 4, "evidence, concrete answers, author and review of the missing batch");
  const authorStage = (estimate) => estimate.stages.find((stage) => stage.id === "author");
  assert.ok(authorStage(topUp).outputTokens.high < authorStage(whole).outputTokens.high, "five missing questions are written, not six");
  const none = estimateFromState("generate", { resumeDraftId: "d" }, { ...state, drafts: [{ ...state.drafts[0], editorial: { ...state.drafts[0].editorial, requested: 1 } }] }, {});
  assert.equal(none.calls.high, 0, "nothing missing, nothing to estimate");
  assert.throws(() => estimateFromState("generate", { resumeDraftId: "missing" }, state, {}), /Draft|草稿/);
});

test("a generation in a big library tells the model only about targets its materials could repeat, and the job's estimate says the same", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-scoped-existing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  await service.store.update((state) => {
    state.decks.push({ id: "baking", title: "Baking", course: "Baking", createdAt: "2026-01-01T00:00:00.000Z", cards: Array.from({ length: 400 }, (_, i) => ({
      id: `b${i}`, kind: "flashcard", topic: "t", objective: `Knead the dough ${i} minutes, then proof it`, prompt: `Dough ${i}?`, answer: "a", citations: [] })) });
    state.decks.push({ id: "arch", title: "Arch", course: "Arch", createdAt: "2026-01-01T00:00:00.000Z", cards: [{ id: "a1", kind: "flashcard", topic: "t",
      objective: "Explain how architecture holds principles guiding design and evolution", prompt: "Arch?", answer: "a", citations: [] }] });
  });
  const requests = [];
  service.complete = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    requests.push(request.alreadyCovered);
    return JSON.stringify({ title: "T", cards: [card(9)] });
  });
  const started = await service.call("generate", { sourceIds: [source.id], count: 1, kind: "flashcard" });
  const done = await service.call("job.wait", { jobId: started.jobId });
  assert.equal(done.status, "complete", done.stage);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], ["Explain how architecture holds principles guiding design and evolution"], "400 baking targets are not sent");
  const withBaking = estimateFromState("generate", { sourceIds: [source.id], count: 1, kind: "flashcard" }, await service.store.read(), {});
  const withoutBaking = estimateFromState("generate", { sourceIds: [source.id], count: 1, kind: "flashcard" },
    { ...(await service.store.read()), decks: (await service.store.read()).decks.filter((deck) => deck.id !== "baking") }, {});
  assert.equal(withBaking.inputTokens.high, withoutBaking.inputTokens.high);
});
