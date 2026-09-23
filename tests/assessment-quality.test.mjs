import test from "node:test";
import assert from "node:assert/strict";
import { generateDeck } from "../lib/generation.js";
import { publicCard } from "../lib/domain.js";
import { authored, qualityPlan, qualityReview } from "./helpers/assessment.mjs";
import { reviewIssues, explanationIssues } from "../lib/assessment-quality.js";
import { reviewedCardFingerprint } from "../lib/review-integrity.js";

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const request = { count: 1, kind: "flashcard", sources: [source] };
const card = { id: "q", kind: "flashcard", topic: "Architecture decisions", objective: "Recognize the role of architectural constraints",
  prompt: "Why does architecture contain principles guiding design and evolution?", answer: "Principles guide subsequent design choices and changes.",
  hint: "Compare a current-state description with a constraint on permitted changes.", explanation: "The quoted definition explicitly includes principles governing design and evolution.", misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }] };
const candidate = () => ({ title: "Architecture", cards: [structuredClone(card)] });

test("a card that still fails after one repair round is dropped, and the rest is kept", async () => {
  const draft = candidate();
  draft.cards.push({ ...structuredClone(card), id: "q2", prompt: "What governs later system changes?", objective: "Identify constraints on evolution" });
  const req = { ...request, count: 2, allowPartial: true };
  const failed = qualityReview(draft, []);
  failed.checks[1].answerLeak = "fail";
  failed.checks[1].explanation = "q2 leaks its requested answer.";
  // The repair and the retained subset both receive independent reviews.
  const responses = [qualityPlan(req), authored(draft), failed, { deck: { cards: [draft.cards[1]] }, checks: [failed.checks[1]] }, failed, qualityReview({ cards: [draft.cards[0]] })];
  const phases = [];
  const result = await generateDeck(async () => JSON.stringify(responses.shift()), req, (stage) => phases.push(stage));
  assert.equal(responses.length, 0, "repair and retained-subset reviews were consumed");
  assert.equal(result.cards.length, 1, "only the sound card survives");
  assert.equal(result.cards[0].prompt, card.prompt);
  assert.equal(result.editorial.dropped, 1);
  assert.equal(result.editorial.audit.checks.length, 1);
  assert.equal(result.editorial.audit.checks[0].cardId, result.cards[0].id);
  assert.ok(phases.some((stage) => /Dropping 1 question/.test(stage)));
});

test("only the flagged card is re-sent for repair, so a round cannot grow the payload", async () => {
  const draft = candidate();
  draft.cards.push({ ...structuredClone(card), id: "q2", prompt: "What governs later system changes?", objective: "Identify constraints on evolution" });
  const req = { ...request, count: 2, allowPartial: true };
  const failed = qualityReview(draft, []);
  failed.checks[1].answerLeak = "fail";
  failed.checks[1].explanation = "q2 leaks its requested answer.";
  const repairedCard = { ...structuredClone(draft.cards[1]), prompt: "Which recorded rule constrains later changes?" };
  const prompts = [];
  const responses = [qualityPlan(req), authored(draft), failed,
    { deck: { cards: [repairedCard] }, checks: [{ ...failed.checks[1], answerLeak: "pass", explanation: "The stem no longer names the answer." }] }, qualityReview({ cards: [draft.cards[0], repairedCard] })];
  const result = await generateDeck(async (_system, prompt) => { prompts.push(prompt); return JSON.stringify(responses.shift()); }, req);
  const repairPrompt = prompts.at(-2);
  assert.match(repairPrompt, /Repair ONLY the questions in repair\[\]/);
  assert.ok(repairPrompt.includes("q2"), "the flagged card travels");
  assert.ok(!repairPrompt.includes(card.prompt), "the sound card does not");
  assert.equal(result.cards.length, 2, "the repaired card rejoins the deck");
  assert.ok(result.cards.some((c) => c.prompt === repairedCard.prompt));
  assert.equal(result.editorial.dropped, undefined);
});

test("an unusable review is asked again instead of failing the batch", async () => {
  const deck = candidate();
  const systems = [];
  const responses = [qualityPlan(request), authored(deck), { issues: ["empty"] }, qualityReview(deck)];
  const result = await generateDeck(async (system) => { systems.push(system); return JSON.stringify(responses.shift()); }, request);
  assert.equal(responses.length, 0);
  assert.equal(result.cards.length, 1);
  assert.equal(result.editorial.repaired, false, "a protocol hiccup is not a content repair");
  assert.match(systems.at(-1), /^Act as a strict assessment editor/);
});

test("authoring and self-improvement happen in one call before an independent review", async () => {
  const original = candidate(), improved = candidate();
  improved.cards[0].prompt = "A team records a rule that every new service must use the shared access layer. What role does this rule play when later changes are proposed?";
  improved.cards[0].explanation += " The access-layer rule is a constructed example, not a quotation from the course.";
  const responses = [qualityPlan(request),
    authored(improved, [{ cardId: "q", summary: "Replaced the answer-bearing stem with a self-contained constraint scenario." }]),
    qualityReview(improved)];
  const phases = [], systems = [];
  const deck = await generateDeck(async (system) => { systems.push(system); return JSON.stringify(responses.shift()); }, request, (stage) => phases.push(stage));
  assert.equal(responses.length, 0, "three model calls: plan, author+self-check, review");
  assert.match(systems[0], /^Plan/);
  assert.match(systems[1], /^You author/);
  assert.match(systems[2], /^Act as a strict/);
  assert.notEqual(deck.cards[0].prompt, original.cards[0].prompt);
  assert.equal(deck.cards[0].prompt, improved.cards[0].prompt);
  assert.equal(deck.editorial.audit.changes.length, 1);
  assert.equal(deck.editorial.audit.checks[0].cardId, deck.cards[0].id);
  assert.equal(deck.editorial.reviewedCards[deck.cards[0].id], reviewedCardFingerprint(deck.cards[0]));
  assert.ok(phases.indexOf("Writing and self-checking questions") < phases.indexOf("Reviewing ambiguity and source support"));
});

test("unsupported planning evidence stops generation before an author writes questions", async () => {
  const plan = qualityPlan(request); plan.targets[0].citations[0].quote = "This distinction was never in the supplied notes.";
  const prompts = [];
  // The plan gets exactly one corrective round, naming the quote that failed;
  // a model that repeats it never reaches an author.
  await assert.rejects(
    generateDeck(async (_system, prompt) => { prompts.push(prompt); return JSON.stringify(plan); }, request),
    /plan is not usable: Target 1: quote "This distinction was never in the .*…" is not in source s/,
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Your previous plan was rejected/);
});

test("a plan whose quote only lost an emoji bullet is accepted without a retry", async () => {
  const emoji = { id: "e", title: "Outline", text: "吞吐量提升\n\t\t✋️ 服务器升级\n\t\t♻️ 缓存命中率提升，减少处理时间" };
  const req = { count: 1, kind: "flashcard", sources: [emoji] };
  const plan = qualityPlan(req);
  plan.targets[0].citations = [{ sourceId: "e", quote: "吞吐量提升\n\t\t 服务器升级\n\t\t 缓存命中率提升" }];
  const deck = { title: "性能", cards: [{ ...structuredClone(card), citations: [{ sourceId: "e", quote: "缓存命中率提升，减少处理时间" }] }] };
  const replies = [plan, authored(deck), qualityReview(deck)];
  const out = await generateDeck(async () => JSON.stringify(replies.shift()), req);
  assert.equal(out.cards.length, 1);
  assert.equal(replies.length, 0, "no corrective round was needed");
});

test("an empty issues list cannot approve missing or failed per-card checks", () => {
  assert.match(reviewIssues({ issues: [] }, candidate()).join(), /every card/);
  const review = qualityReview(candidate()); review.checks[0].answerLeak = "fail";
  assert.match(reviewIssues(review, candidate()).join(), /answerLeak/);
  const choice = candidate(); choice.cards[0].kind = "quiz";
  assert.match(reviewIssues(qualityReview(candidate()), choice).join(), /optionQuality/);
});

test("leakage that survives its repair round costs that card; a whole batch of them fails", async () => {
  const deck = candidate(), failed = qualityReview(deck);
  failed.checks[0].answerLeak = "fail";
  failed.checks[0].explanation = "The stem supplies the requested principles and their effect.";
  const responses = [qualityPlan(request), authored(deck), failed, { deck: { cards: deck.cards }, checks: failed.checks }, failed];
  // The only card is still flagged, so nothing is left to keep.
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), request), /Quality gate failed.*answerLeak/);
  assert.equal(responses.length, 0);
});

test("invisible slide dependency remains blocked even when all model checks claim pass", async () => {
  const deck = candidate(); deck.cards[0].prompt = "根据该幻灯片，架构的原则是什么？";
  const responses = [qualityPlan(request), authored(deck), qualityReview(deck), authored(deck), qualityReview(deck)];
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), request), /Quality gate failed:.*unavailable/);
});

test("learner projection withholds answer-bearing objectives and rubrics", () => {
  const view = publicCard({ ...card, objective: "The correct answer is principles", rubric: "Award points for naming principles" });
  assert.equal(Object.hasOwn(view, "objective"), false);
  assert.equal(Object.hasOwn(view, "rubric"), false);
  assert.equal(Object.hasOwn(view, "answer"), false);
  assert.equal(view.prompt, card.prompt);
});

test("an independent explanation-quality failure cannot be ignored", () => {
  const review = qualityReview(candidate());
  review.checks[0].explanationQuality = "fail";
  assert.match(reviewIssues(review, candidate()).join(), /explanationQuality/);
  delete review.checks[0].explanationQuality;
  assert.match(reviewIssues(review, candidate()).join(), /explanationQuality/);
});

test("a retained subset cannot bypass its independent review", async () => {
  const deck = candidate();
  deck.cards.push({ ...structuredClone(card), id: "q2", prompt: "What governs later changes?", objective: "Identify constraints" });
  const req = { ...request, count: 2 };
  const failed = qualityReview(deck);
  failed.checks[1].explanationQuality = "fail";
  const retained = qualityReview({ cards: [deck.cards[0]] }, ["Remaining answer is unsupported"]);
  const responses = [qualityPlan(req), authored(deck), failed, authored(deck), failed, retained];
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), req), /Quality gate failed for retained questions.*unsupported/);
  assert.equal(responses.length, 0);
});

test("a repairer's self approval cannot replace an independent acceptance of the repaired text", async () => {
  const deck = candidate(), failed = qualityReview(deck);
  failed.checks[0].learningValue = "fail";
  const systems = [];
  const responses = [qualityPlan(request), authored(deck), failed, authored(deck), failed];
  await assert.rejects(generateDeck(async (system) => { systems.push(system); return JSON.stringify(responses.shift()); }, request), /Quality gate failed/);
  assert.equal(systems.filter(s => s.startsWith("Act as a strict assessment editor")).length, 2);
});


test("answer restatements are rejected locally even if the editor approves", async () => {
  const deck = candidate();
  deck.cards[0].explanation = deck.cards[0].answer;
  assert.match(explanationIssues(deck).join(), /only repeats/);
  const responses = [qualityPlan(request), authored(deck), qualityReview(deck), authored(deck), qualityReview(deck)];
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), request), /Quality gate failed.*only repeats/);
});

test("the independent editor receives the recruiting role and intended difficulty", async () => {
  const deck = candidate();
  const responses = [qualityPlan(request), authored(deck), qualityReview(deck)];
  let review;
  await generateDeck(async (system, prompt) => {
    if (system.startsWith("Act as a strict")) review = JSON.parse(prompt);
    return JSON.stringify(responses.shift());
  }, { ...request, role: "后端开发", difficulty: "hard", focus: "应用与权衡" });
  assert.equal(review.role, "后端开发");
  assert.equal(review.difficulty, "hard");
  assert.equal(review.focus, "应用与权衡");
});
