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

/** `verdict(candidate)` returns { checks: {cardId: {dimension: value, explanation}}, issues, suggestions } for the first review of the draft.
 *  `second(candidate)` is the same for every later review (the review of re-worded cards); `patch(data)` answers the re-wording call with { cards: [...] }. */
function model(verdict, { second, patch } = {}) {
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
      const found = (log.calls.filter((call) => call === "review").length === 1 ? verdict(candidate) : second?.(candidate)) || {};
      for (const check of base.checks) Object.assign(check, found.checks?.[check.cardId] || {});
      return JSON.stringify({ ...base, issues: found.issues || [], suggestions: found.suggestions || [] });
    }
    if (system.startsWith("Rewrite only the wording")) { log.calls.push("patch"); log.patchPrompts.push(prompt); return JSON.stringify(patch ? patch(data()) : { cards: [] }); }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  return { complete, log };
}
const generate = (m, extra = {}) => generateDeck(m.complete, { count: 3, kind: "quiz", sources: [source], ...extra });

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

/* Applying the suggestions is optional (設置 › 出题偏好, and the 即时控制 box): more tokens and time, so the learner chooses. Off, a suggestion is only recorded (the test above). */
const suggested = () => ({ checks: {}, issues: [], suggestions: ["q1：提示可以更概括一些，建议改为只说明判断维度。", "q3：建议把提问收敛到一个判定点。"] });
const reword = (data) => ({ cards: data.cards.map((card) => ({ id: card.id, hint: `Reworded ${card.id}: compare what is described with what is allowed to change.` })) });

test("applySuggestions on: a card that passed with a suggestion is re-worded once and re-reviewed alone; the others are not touched", async () => {
  const m = model(suggested, { patch: reword });
  const result = await generate(m, { applySuggestions: true });
  assert.deepEqual(m.log.calls, ["plan", "blueprint", "author", "review", "patch", "review"], "one rewrite call and one review call for the whole part");
  const sent = JSON.parse(m.log.patchPrompts[0].split("REQUEST DATA:\n")[1]).cards;
  assert.deepEqual(sent.map((card) => card.id), ["q1", "q3"], "only the cards that were given a suggestion");
  assert.match(sent[0].issues.join(" "), /建议改为只说明判断维度/, "the reviewer's own words reach the rewrite");
  assert.equal(result.cards.length, 3);
  assert.match(result.cards[0].hint, /^Reworded/); assert.match(result.cards[2].hint, /^Reworded/);
  assert.doesNotMatch(result.cards[1].hint, /^Reworded/, "a card without a suggestion stays as it was");
  assert.equal(result.editorial.suggestionsApplied, 2);
  assert.equal(result.editorial.reviewRounds, 2);
  assert.ok(result.editorial.suggestions.every((item) => item.applied === true), "what was used says so");
  assert.equal(result.editorial.repairedInRun, undefined, "it is not counted as a repair of a failed card");
});

test("applySuggestions is read when the review is done (the 即时控制 box), as a flag or as a function", async () => {
  const on = model(suggested, { patch: reword });
  await generate(on, { applySuggestions: () => true });
  assert.ok(on.log.calls.includes("patch"));
  const off = model(suggested, { patch: reword });
  await generate(off, { applySuggestions: () => false });
  assert.deepEqual(off.log.calls, ["plan", "blueprint", "author", "review"]);
  const unset = model(suggested, { patch: reword });
  const result = await generate(unset);
  assert.deepEqual(unset.log.calls, ["plan", "blueprint", "author", "review"], "off by default");
  assert.equal(result.editorial.suggestionsApplied, undefined);
  assert.ok(result.editorial.suggestions.every((item) => item.applied === undefined));
});

test("a rewrite that does not pass its review leaves the approved card exactly as it was", async () => {
  const m = model(suggested, { patch: reword, second: () => ({ checks: { q1: { selfContained: "fail", explanation: "q1 的新提示依赖未提供的材料。" } }, issues: ["q1 的新提示依赖未提供的材料。"] }) });
  const result = await generate(m, { applySuggestions: true });
  assert.equal(result.cards.length, 3, "nothing is dropped for a rewrite that failed");
  assert.doesNotMatch(result.cards[0].hint, /^Reworded/, "q1 keeps its approved wording");
  assert.match(result.cards[2].hint, /^Reworded/, "q3 passed its re-review and is re-worded");
  assert.equal(result.editorial.suggestionsApplied, 1);
  const q1 = result.editorial.suggestions.find((item) => item.cardId === result.cards[0].id), q3 = result.editorial.suggestions.find((item) => item.cardId === result.cards[2].id);
  assert.equal(q1.applied, undefined); assert.equal(q3.applied, true);
});

test("a rewrite call that changes nothing costs the calls but changes nothing", async () => {
  const m = model(suggested);
  const result = await generate(m, { applySuggestions: true });
  assert.deepEqual(m.log.calls, ["plan", "blueprint", "author", "review", "patch"], "no card changed, so there is nothing to review again");
  assert.equal(result.cards.length, 3);
  assert.equal(result.editorial.suggestionsApplied, undefined);
});

test("applySuggestions with nothing to apply asks for nothing; a quote-format complaint is not a suggestion to apply", async () => {
  const none = model(() => ({ checks: {}, issues: [], suggestions: [] }), { patch: reword });
  await generate(none, { applySuggestions: true });
  assert.deepEqual(none.log.calls, ["plan", "blueprint", "author", "review"]);
  const complaint = "q2：两处引文与所给原文并非逐字一致：'the things they handle best' 原文有句末句点，引文漏掉句点。";
  const format = model(() => ({ checks: { q2: { sourceSupport: "fail", explanation: complaint } }, issues: [complaint] }), { patch: reword });
  const result = await generate(format, { applySuggestions: true });
  assert.ok(!format.log.calls.includes("patch"), "the program verifies quotes; a citation cannot be re-worded");
  assert.equal(result.cards.length, 3);
});
