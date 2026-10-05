import test from "node:test";
import assert from "node:assert/strict";
import { generateDeck } from "../lib/generation.js";
import { generateBatched } from "../lib/batch.js";
import { patchCandidates, patchFields, applyPatch } from "../lib/generation-yield.js";
import { qualityPlan, qualityReview } from "./helpers/assessment.mjs";

/* #202: when the review flags only defects that live in a few named fields (a hint or topic that gives the answer, a weak distractor, an
   unclear explanation) the card gets ONE targeted repair of just those fields, with the reviewer's comment, and the same local checks plus
   a review of that card decide whether it stays. Defects that cannot be fixed by rewriting (source support, kind, duplicate, value) still drop. */

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const quizCard = (n, index) => ({ id: `q${index + 1}`, targetId: `target-${n}`, kind: "quiz", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `Which statement about architecture principle ${n} follows from the definition?`, answer: `Principles guide later choices ${n}.`,
  hint: "Compare a description of today with a rule about permitted change.",
  explanation: `The definition ties principle ${n} to design and evolution, so later choices must follow it.`,
  misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }],
  options: [{ id: "a", text: `Principles guide later choices ${n}.`, correct: true, explanation: "The definition says principles guide design and evolution." },
    { id: "b", text: `Architecture is only today's diagram ${n}.`, correct: false, explanation: "Ignores the evolution part of the definition." },
    { id: "c", text: `Principles never constrain design ${n}.`, correct: false, explanation: "Contradicts the definition." }] });
const targetNumber = (card) => Number(String(card.targetId).replace("target-", ""));

/** A scripted model. `reviewFail`: target number -> failed checks (the first review that sees the card); `comment`: the reviewer's finding for it.
 *  `defects`: target number -> change applied to that card in the first author call. `patch(body)`: the reply to the repair call. */
function fakeModel({ reviewFail = {}, comment = {}, defects = {}, patch, reviewAfterPatch } = {}) {
  const log = { calls: [], patchPrompts: [], reviewed: [], blueprintOptions: [] };
  let authors = 0;
  const complete = async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment")) {
      const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
      log.calls.push("plan");
      return JSON.stringify({ targets: qualityPlan({ ...request, kind: "quiz" }).targets.map((target, index) => ({ ...target, objective: `Planned ${index + 1}` })) });
    }
    if (system.startsWith("Prepare supported answers")) {
      log.calls.push("blueprint");
      const plan = JSON.parse(prompt.split("REQUEST DATA:\n")[1]).assessmentPlan;
      const cards = plan.targets.map((target, index) => quizCard(targetNumber({ targetId: target.targetId }), index));
      return JSON.stringify({ items: cards.map((card, index) => ({ targetId: plan.targets[index].targetId, answer: card.answer, reasoning: card.explanation,
        scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope", options: card.options })) });
    }
    if (system.startsWith("You author")) {
      log.calls.push("author"); authors++;
      const plan = JSON.parse(prompt.split("REQUEST DATA:\n")[1]).assessmentPlan;
      const cards = plan.targets.map((target, index) => {
        const n = Number(target.targetId.replace("target-", "")), card = quizCard(n, index);
        return authors === 1 && defects[n] ? defects[n](card) : card;
      });
      return JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: qualityReview({ cards }).checks });
    }
    if (system.startsWith("Act as a strict assessment editor")) {
      log.calls.push("review");
      const body = JSON.parse(prompt), candidate = body.candidate;
      log.reviewed.push({ cards: candidate.cards, blueprint: body.answerBlueprint });
      const review = qualityReview(candidate), issues = [];
      const afterPatch = log.calls.includes("patch");
      for (const check of review.checks) {
        const card = candidate.cards.find((item) => item.id === check.cardId), n = targetNumber(card);
        const keys = afterPatch && reviewAfterPatch ? reviewAfterPatch[n] : reviewFail[n];
        if (!keys) continue;
        if (!afterPatch) delete reviewFail[n];
        for (const key of keys) check[key] = "fail";
        check.explanation = comment[n] || `Card ${n} needs work`;
        issues.push(`${card.id}: ${keys.join(", ")} needs work`);
      }
      return JSON.stringify({ ...review, issues });
    }
    if (system.startsWith("Rewrite only the wording")) {
      log.calls.push("patch");
      const body = JSON.parse(prompt.split("REQUEST DATA:\n")[1]); log.patchPrompts.push(body);
      return JSON.stringify(patch(body));
    }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  return { complete, log };
}
const generate = (model, request = {}) => generateDeck(model.complete, { count: 3, kind: "quiz", sources: [source], ...request });
const byObjective = (deck, n) => deck.cards.find((card) => card.objective === `Planned ${n}`);

test("a hint the reviewer says gives the answer is rewritten with the reviewer's comment and the card stays", async () => {
  const model = fakeModel({ reviewFail: { 2: ["answerLeak"] }, comment: { 2: "The hint names the key phrase of the correct option." },
    patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, hint: "Ask what a rule about permitted future change would add to a plain description.",
      explanation: "SHOULD BE IGNORED", options: [{ id: "a", text: "HACKED", explanation: "x" }], answer: "HACKED" })) }) });
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review", "patch", "review"], "one repair call, no second plan/author round");
  assert.equal(result.cards.length, 3);
  const patched = byObjective(result, 2);
  assert.match(patched.hint, /^Ask what a rule/);
  assert.equal(patched.explanation, quizCard(2, 1).explanation, "a field the review did not name is not rewritten");
  assert.deepEqual(patched.options, quizCard(2, 1).options, "options were not named either");
  assert.equal(patched.answer, quizCard(2, 1).answer);
  const sent = model.log.patchPrompts[0].cards[0];
  assert.deepEqual(sent.allowed.slice().sort(), ["hint", "prompt", "topic"], "the repair is told which fields it may touch");
  assert.match(sent.reviewerComment, /names the key phrase/, "the review comment travels with the card");
  assert.equal(result.editorial.repairedInRun, 1);
  assert.equal(result.editorial.repairTried, 1);
  assert.equal(model.log.reviewed[1].cards.length, 1, "only the repaired card is reviewed again");
});

test("a card the review still flags after the repair is dropped, with its original reasons", async () => {
  const model = fakeModel({ reviewFail: { 2: ["answerLeak"] }, reviewAfterPatch: { 2: ["answerLeak"] },
    patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, hint: "Think about which kind of rule outlives a single release." })) }) });
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review", "patch", "review"], "the same review decides again");
  assert.equal(result.cards.length, 2);
  assert.equal(result.editorial.repairTried, 1);
  assert.equal(result.editorial.repairedInRun, undefined);
  assert.equal(result.editorial.dropped, 1);
  assert.ok(result.editorial.omitted[0].reasons.some((reason) => /answerLeak/.test(reason)));
});

test("a weak distractor is repaired by rewriting only that option; the correct option cannot move", async () => {
  const model = fakeModel({ reviewFail: { 2: ["optionQuality"] }, comment: { 2: "Option c is absurd and teaches nothing." },
    patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id,
      options: [{ id: "c", text: "Principles apply only at the first release and never afterwards.", explanation: "Mistakes a one-time rule for guidance that lasts through evolution." },
        { id: "a", text: "HACKED correct option", explanation: "x" }, { id: "zz", text: "no such option", explanation: "x" }],
      hint: "SHOULD BE IGNORED" })) }) });
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review", "patch", "review"]);
  const patched = byObjective(result, 2), original = quizCard(2, 1);
  assert.equal(result.cards.length, 3);
  assert.match(patched.options.find((option) => option.id === "c").text, /^Principles apply only at the first release/);
  assert.deepEqual(patched.options.find((option) => option.id === "a"), original.options[0], "the correct option is untouched");
  assert.deepEqual(patched.options.find((option) => option.id === "b"), original.options[1], "an option the review did not blame is untouched");
  assert.equal(patched.options.length, 3);
  assert.equal(patched.hint, original.hint);
  assert.deepEqual(model.log.patchPrompts[0].cards[0].allowed, ["options"]);
  const reviewedAgain = model.log.reviewed[1].blueprint.items[0];
  assert.match(reviewedAgain.options.find((option) => option.id === "c").text, /^Principles apply only/, "the reviewer sees the blueprint that matches the repaired card");
  assert.equal(result.editorial.repairedInRun, 1);
});

test("defects that rewriting cannot fix still drop the card without a repair call", async () => {
  for (const keys of [["sourceSupport"], ["learningValue"], ["optionQuality", "sourceSupport"], ["answerLeak", "learningValue"]]) {
    const model = fakeModel({ reviewFail: { 2: keys } });
    const result = await generate(model);
    assert.ok(!model.log.calls.includes("patch"), keys.join("+"));
    assert.equal(result.cards.length, 2, keys.join("+"));
    assert.equal(result.editorial.repairTried, undefined);
  }
});

test("a repair that changes nothing nameable, or rewrites a field it was not allowed, keeps the card out", async () => {
  const model = fakeModel({ reviewFail: { 2: ["explanationQuality"] }, patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, hint: "Only the hint was rewritten." })) }) });
  const result = await generate(model);
  assert.equal(result.cards.length, 2, "nothing allowed was rewritten, so nothing was repaired");
  assert.equal(result.editorial.repairTried, 1);
});

test("the fields a repair may touch follow the findings", () => {
  assert.deepEqual([...patchFields(["q1: answerLeak failed or was not checked"])].sort(), ["hint", "prompt", "topic"]);
  assert.deepEqual([...patchFields(["q1: optionQuality failed or was not checked"])], ["options"]);
  assert.deepEqual([...patchFields(["q1: explanationQuality failed or was not checked"])].sort(), ["explanation", "misconception"]);
  assert.deepEqual([...patchFields(["Card 1: hint reveals the answer"])], ["hint"]);
  assert.deepEqual([...patchFields(["q1: selfContained failed or was not checked", "q1: optionQuality failed or was not checked"])].sort(), ["hint", "options", "prompt", "topic"]);
  const card = quizCard(1, 0);
  const next = applyPatch(card, { hint: "new", explanation: "new", options: [{ id: "b", text: "weak fixed", explanation: "why" }, { id: "a", text: "bad", explanation: "bad" }] }, new Set(["hint", "options"]));
  assert.equal(next.hint, "new");
  assert.equal(next.explanation, card.explanation);
  assert.equal(next.options[1].text, "weak fixed");
  assert.deepEqual(next.options[0], card.options[0]);
});

test("optionQuality is repairable, but sourceSupport next to it is not", () => {
  const card = quizCard(1, 0), deck = { cards: [card] };
  const mentions = (issue, c) => issue.startsWith(`${c.id}:`);
  const found = patchCandidates(deck, { local: [], binding: [], review: ["q1: optionQuality failed or was not checked"] }, mentions);
  assert.ok(found.has("q1"));
  assert.ok(!patchCandidates(deck, { local: [], binding: [], review: ["q1: optionQuality failed or was not checked", "q1: sourceSupport failed or was not checked"] }, mentions).has("q1"));
  assert.ok(!patchCandidates(deck, { local: [], binding: [], review: ["q1: learningValue failed or was not checked"] }, mentions).has("q1"));
});

test("a part's replacement cards get the same repair, not just the first batch", async () => {
  const model = fakeModel({ reviewFail: { 2: ["sourceSupport"], 4: ["answerLeak"] },
    patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, hint: "Ask what a rule about permitted future change would add." })) }) });
  const pool = qualityPlan({ count: 2, kind: "quiz", sources: [source], existing: [] }).targets.map((target, index) => ({ ...target, targetId: `target-${4 + index}`, objective: `Planned ${4 + index}` }));
  const result = await generate(model, { assessmentPlan: { targets: qualityPlan({ count: 3, kind: "quiz", sources: [source] }).targets.map((target, index) => ({ ...target, objective: `Planned ${index + 1}` })) },
    claimReserve: (n) => pool.splice(0, n) });
  assert.equal(result.cards.length, 3, "the replacement was repaired and kept");
  assert.ok(model.log.calls.filter((call) => call === "patch").length === 1);
  assert.equal(result.editorial.repairedInRun, 1);
  assert.equal(result.editorial.reserveUsed, 1);
});

test("the batch sums the repair counts of its parts", async () => {
  const model = fakeModel({ reviewFail: { 2: ["answerLeak"] }, patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, hint: "Ask what a rule about permitted future change would add." })) }) });
  const result = await generateBatched(model.complete, { count: 3, kind: "quiz", sources: [source] });
  assert.equal(result.cards.length, 3);
  assert.equal(result.editorial.repairedInRun, 1);
  assert.equal(result.editorial.repairTried, 1);
});
