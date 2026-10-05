import test from "node:test";
import assert from "node:assert/strict";
import { generateDeck, reviewPrompts } from "../lib/generation.js";
import { reviewIssues, reviewSuggestions, REVIEW_SHAPE } from "../lib/assessment-quality.js";
import { qualityPlan, qualityReview } from "./helpers/assessment.mjs";

/* #216: the review has two severities. Only a blocker (unsupported answer, wrong attribution, wrong kind, a real leak, several correct options)
   drops or repairs a card; a suggestion (wording, "could be shorter", an optional rewrite) is recorded and the card stays. Quotes are verified by
   the program on letters and digits alone, so a missing full stop or a curly quote can never fail a card. The review text of the owner's failed
   fill (2.5.16) is the regression fixture. */

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution. It is “the things they handle best”." };
const quote = "Architecture includes the principles guiding a system's design and evolution.";
const quizCard = (n, index) => ({ id: `q${index + 1}`, targetId: `target-${n}`, kind: "quiz", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `Which statement about architecture principle ${n} follows from the definition?`, answer: `Principles guide later choices ${n}.`,
  hint: "Compare a description of today with a rule about permitted change.", explanation: `The definition ties principle ${n} to design and evolution, so later choices must follow it.`,
  misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote }],
  options: [{ id: "a", text: `Principles guide later choices ${n}.`, correct: true, explanation: "The definition says principles guide design and evolution." },
    { id: "b", text: `Architecture is only today's diagram ${n}.`, correct: false, explanation: "Ignores the evolution part of the definition." },
    { id: "c", text: `Principles never constrain design ${n}.`, correct: false, explanation: "Contradicts the definition." }] });

/** `verdict(candidate)` returns { checks: {cardId: {dimension: value, explanation}}, issues, suggestions } for the first review of the draft. */
function model(verdict) {
  const log = { calls: [], reviewPrompts: [], patchPrompts: [] };
  const complete = async (system, prompt) => {
    const data = () => JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    if (system.startsWith("Plan a source-grounded assessment")) { log.calls.push("plan"); return JSON.stringify({ targets: qualityPlan({ ...data(), kind: "quiz" }).targets.map((target, index) => ({ ...target, objective: `Planned ${index + 1}`,
      citations: [{ sourceId: "s", quote }] })) }); }
    if (system.startsWith("Prepare supported answers")) {
      log.calls.push("blueprint");
      const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => quizCard(index + 1, index));
      return JSON.stringify({ items: cards.map((card, index) => ({ targetId: plan.targets[index].targetId, answer: card.answer, reasoning: card.explanation,
        scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope", options: card.options })) });
    }
    if (system.startsWith("You author")) {
      log.calls.push("author");
      const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => quizCard(index + 1, index));
      return JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: qualityReview({ cards }).checks });
    }
    if (system.startsWith("Act as a strict assessment editor")) {
      log.calls.push("review"); log.reviewPrompts.push({ system, prompt });
      const candidate = JSON.parse(prompt).candidate, base = qualityReview(candidate);
      const found = log.calls.filter((call) => call === "review").length === 1 ? verdict(candidate) : {};
      for (const check of base.checks) Object.assign(check, found.checks?.[check.cardId] || {});
      return JSON.stringify({ ...base, issues: found.issues || [], suggestions: found.suggestions || [] });
    }
    if (system.startsWith("Rewrite only the wording")) { log.calls.push("patch"); log.patchPrompts.push(prompt); return JSON.stringify({ cards: [] }); }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  return { complete, log };
}
const generate = (m) => generateDeck(m.complete, { count: 3, kind: "quiz", sources: [source] });

test("suggest is a severity the shared review shape knows, and it is not an error", () => {
  assert.match(JSON.stringify(REVIEW_SHAPE.checks[0]), /pass\|fail\|suggest/);
  const deck = { cards: [{ id: "q1", kind: "quiz" }] }, base = qualityReview(deck);
  base.checks[0].answerLeak = "suggest"; base.checks[0].explanation = "The hint is close to the key point; consider a more generic hint.";
  assert.deepEqual(reviewIssues(base, deck), []);
  const found = reviewSuggestions(base, deck);
  assert.equal(found.length, 1);
  assert.equal(found[0].cardId, "q1");
  assert.match(found[0].text, /consider a more generic hint/);
  base.checks[0].answerLeak = "fail";
  assert.deepEqual(reviewIssues(base, deck), ["q1: answerLeak failed or was not checked"], "fail is still a blocker");
  base.checks[0].answerLeak = "maybe";
  assert.deepEqual(reviewIssues(base, deck), ["q1: answerLeak failed or was not checked"], "anything else is an unchecked dimension");
});

test("a card whose review only gave suggestions stays, and the suggestions are recorded (the owner's q1)", async () => {
  const m = model((candidate) => ({
    checks: { q1: { answerLeak: "suggest", optionQuality: "suggest", explanation: "q1：该题的 hint 已直接提示…虽未泄漏具体条目、尚不构成完全给分，但该提示已接近公布判定要点，建议改为只说明判断维度。" } },
    issues: [], suggestions: ["q1：选项 a…建议把选项压缩为一句话。", "q3：建议把提问收敛到一个判定点。"] }));
  const result = await generate(m);
  assert.deepEqual(m.log.calls, ["plan", "blueprint", "author", "review"], "no repair, no replacement, no second review for a suggestion");
  assert.equal(result.cards.length, 3, "nothing was dropped");
  assert.equal(result.editorial.dropped, undefined);
  const ids = result.cards.map((card) => card.id);
  assert.ok(result.editorial.suggestions.length >= 3, JSON.stringify(result.editorial.suggestions));
  assert.ok(result.editorial.suggestions.every((item) => ids.includes(item.cardId)), "suggestions point at published card ids");
  assert.match(result.editorial.suggestions.map((item) => item.text).join(" "), /建议把选项压缩/);
});

test("the old pass/fail reply is read with the same severity: a reviewer who concedes it is not a leak and only suggests does not drop the card", async () => {
  const m = model(() => ({ checks: { q1: { answerLeak: "fail", explanation: "q1：该 hint 虽未泄漏具体条目、尚不构成完全给分，但已接近公布判定要点，建议改为只说明判断维度。" } },
    issues: ["q1：该 hint 虽未泄漏具体条目、尚不构成完全给分，但已接近公布判定要点，建议改为只说明判断维度。"] }));
  const result = await generate(m);
  assert.equal(result.cards.length, 3);
  assert.ok(!m.log.calls.includes("patch"));
  assert.ok(result.editorial.suggestions.some((item) => /建议改为/.test(item.text)));
});

test("a quote that differs only in a full stop or the shape of the quote marks never fails a card", async () => {
  const complaint = "q2：两处引文与所给原文并非逐字一致：'the things they handle best' 原文有句末句点，引文漏掉句点；'fool's errand' 是弯引号而证据文本是直引号。";
  const m = model(() => ({ checks: { q2: { sourceSupport: "fail", explanation: complaint } }, issues: [complaint] }));
  const result = await generate(m);
  assert.equal(result.cards.length, 3, "the program verifies quotes on letters and digits; the card stays");
  assert.ok(!m.log.calls.includes("patch"));
  assert.ok(result.editorial.suggestions.some((item) => /句末句点/.test(item.text)), "the complaint is recorded, not acted on");
  // the same words with a quote the program cannot find are NOT dismissed
  const deck = { cards: [{ ...quizCard(2, 1), citations: [{ sourceId: "s", quote: "A sentence that is nowhere in the course notes at all." }] }] };
  const review = qualityReview(deck); review.checks[0].sourceSupport = "fail"; review.checks[0].explanation = complaint; review.issues = [complaint];
  assert.ok(reviewIssues(review, deck, { sources: [source] }).some((issue) => /sourceSupport failed/.test(issue)), "an invented quote is still a blocker");
  deck.cards[0].citations = [{ sourceId: "s", quote }];
  assert.deepEqual(reviewIssues(review, deck, { sources: [source] }), [], "a quote the program verified is not the reviewer's to judge");
  assert.ok(reviewIssues(review, deck).length > 0, "without sources there is nothing verified, so nothing is dismissed");
});

test("real blockers still drop or repair a card", async () => {
  const leak = model(() => ({ checks: { q2: { answerLeak: "fail", explanation: "q2 的提示直接给出了答案的核心区分，与正确选项几乎同义。" } }, issues: ["q2 的提示直接给出了答案的核心区分，与正确选项几乎同义。"] }));
  const first = await generate(leak);
  assert.ok(leak.log.calls.includes("patch"), "a real leak goes to the targeted repair");
  assert.equal(first.cards.length, 2, "the empty repair kept nothing, so the card is dropped");
  for (const [dimension, text] of [["sourceSupport", "q2：答案没有资料支持。"], ["selfContained", "q2：题干依赖看不到的幻灯片。"]]) {
    const m = model(() => ({ checks: { q2: { [dimension]: "fail", explanation: text } }, issues: [text] }));
    assert.equal((await generate(m)).cards.length, 2, dimension);
  }
});

test("the review prompt says what a blocker is, that a suggestion never rejects, and that the program checks quotes", async () => {
  const m = model(() => ({}));
  await generate(m);
  const { system, prompt } = m.log.reviewPrompts[0];
  const text = system + prompt;
  assert.match(text, /blocker/i);
  assert.match(text, /suggest/);
  assert.match(text, /never (?:fail|reject)[^.]*(?:format|quote)/i);
  assert.match(text, /verified by the program/i);
  const built = reviewPrompts({ sources: [source], deck: { cards: [] }, kind: "quiz", count: 0 });
  assert.match(built.system, /suggestions/);
});
