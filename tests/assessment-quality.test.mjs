import test from "node:test";
import assert from "node:assert/strict";
import { generateDeck } from "../lib/generation.js";
import { publicCard } from "../lib/domain.js";
import { qualityPlan, qualityReview } from "./helpers/assessment.mjs";
import { reviewIssues } from "../lib/assessment-quality.js";

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const request = { count: 1, kind: "flashcard", sources: [source] };
const card = { id: "q", kind: "flashcard", topic: "Architecture decisions", objective: "Recognize the role of architectural constraints",
  prompt: "Why does architecture contain principles guiding design and evolution?", answer: "Principles guide subsequent design choices and changes.",
  hint: "Compare a current-state description with a constraint on permitted changes.", explanation: "The quoted definition explicitly includes principles governing design and evolution.", misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }] };
const candidate = () => ({ title: "Architecture", cards: [structuredClone(card)] });

test("partial editorial failures retain only separately re-reviewed passing cards", async () => {
  for (const approveSubset of [true, false]) {
    const draft = candidate();
    draft.cards.push({ ...structuredClone(card), id: "q2", prompt: "What governs later system changes?", objective: "Identify constraints on evolution" });
    const req = { ...request, count: 2, allowPartial: true };
    const failed = qualityReview(draft, ["q2 leaks its requested answer"]);
    failed.checks[1].answerLeak = "fail";
    const subset = { ...draft, cards: [draft.cards[0]] };
    const final = qualityReview(subset, approveSubset ? [] : ["A batch-wide evidence problem also affects q"]);
    const responses = [qualityPlan(req), draft, { ...qualityReview(draft), deck: draft, changes: [] }, failed, draft, failed, final];
    const phases = [];
    const pending = generateDeck(async () => JSON.stringify(responses.shift()), req, (stage) => phases.push(stage));
    if (approveSubset) {
      const result = await pending;
      assert.equal(result.cards.length, 1);
      assert.equal(result.cards[0].prompt, card.prompt);
      assert.equal(result.editorial.audit.checks.length, 1);
      assert.equal(result.editorial.audit.checks[0].cardId, result.cards[0].id);
    } else await assert.rejects(pending, /batch-wide evidence problem/);
    assert.ok(phases.includes("Reviewing retained questions"));
    assert.equal(responses.length, 0);
  }
});

test("every initial draft goes through evidence planning and self-improvement before independent approval", async () => {
  const original = candidate(), improved = candidate();
  improved.cards[0].prompt = "A team records a rule that every new service must use the shared access layer. What role does this rule play when later changes are proposed?";
  improved.cards[0].explanation += " The access-layer rule is a constructed example, not a quotation from the course.";
  const responses = [qualityPlan(request), original, { ...qualityReview(improved), deck: improved,
    changes: [{ cardId: "q", summary: "Replaced the answer-bearing stem with a self-contained constraint scenario." }] }, qualityReview(improved)];
  const phases = [], systems = [];
  const deck = await generateDeck(async (system) => { systems.push(system); return JSON.stringify(responses.shift()); }, request, (stage) => phases.push(stage));
  assert.equal(responses.length, 0);
  assert.match(systems[0], /^Plan/);
  assert.match(systems[2], /^Self-check/);
  assert.match(systems[3], /^Act as a strict/);
  assert.equal(deck.cards[0].prompt, improved.cards[0].prompt);
  assert.equal(deck.editorial.audit.changes.length, 1);
  assert.equal(deck.editorial.audit.checks[0].cardId, deck.cards[0].id);
  assert.ok(phases.indexOf("Self-checking and improving every question") < phases.indexOf("Reviewing ambiguity and source support"));
});

test("unsupported planning evidence stops generation before an author writes questions", async () => {
  const plan = qualityPlan(request); plan.targets[0].citations[0].quote = "This distinction was never in the supplied notes.";
  let calls = 0;
  await assert.rejects(generateDeck(async () => { calls++; return JSON.stringify(plan); }, request), /plan cites unsupported evidence/);
  assert.equal(calls, 1);
});

test("an empty issues list cannot approve missing or failed per-card checks", () => {
  assert.match(reviewIssues({ issues: [] }, candidate()).join(), /every card/);
  const review = qualityReview(candidate()); review.checks[0].answerLeak = "fail";
  assert.match(reviewIssues(review, candidate()).join(), /answerLeak/);
  const choice = candidate(); choice.cards[0].kind = "quiz";
  assert.match(reviewIssues(qualityReview(candidate()), choice).join(), /optionQuality/);
});

test("an editor flag for answer leakage forces repair and persistent leakage is rejected", async () => {
  const deck = candidate(), failed = qualityReview(deck);
  failed.checks[0].answerLeak = "fail";
  failed.checks[0].explanation = "The stem supplies the requested principles and their effect.";
  const responses = [qualityPlan(request), deck, { ...qualityReview(deck), deck, changes: [] }, failed, deck, failed];
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), request), /still found issues.*answerLeak/);
  assert.equal(responses.length, 0);
});

test("invisible slide dependency remains blocked even when all model checks claim pass", async () => {
  const deck = candidate(); deck.cards[0].prompt = "根据该幻灯片，架构的原则是什么？";
  const responses = [qualityPlan(request), deck, { ...qualityReview(deck), deck, changes: [] }, qualityReview(deck), deck];
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), request), /Quality gate failed:.*unavailable/);
});

test("learner projection withholds answer-bearing objectives and rubrics", () => {
  const view = publicCard({ ...card, objective: "The correct answer is principles", rubric: "Award points for naming principles" });
  assert.equal(Object.hasOwn(view, "objective"), false);
  assert.equal(Object.hasOwn(view, "rubric"), false);
  assert.equal(Object.hasOwn(view, "answer"), false);
  assert.equal(view.prompt, card.prompt);
});
