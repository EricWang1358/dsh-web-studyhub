import test from "node:test";
import assert from "node:assert/strict";
import { generateDeck } from "../lib/generation.js";
import { generateBatched } from "../lib/batch.js";
import { cardLocalIssues, learnerContextIssues, explanationIssues, answerLeakIssues, formulaIssues } from "../lib/assessment-quality.js";
import { validateDeck } from "../lib/domain.js";
import { qualityPlan, qualityReview } from "./helpers/assessment.mjs";

/* First-pass yield (WP-B): a flagged card whose only defects are wording is patched in the same run (one batched call per part
   plus one review of the survivors); a part that is still short claims verified reserve targets from the plan instead of a full
   rerun. Nothing extra is asked when nothing failed. */

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
const targetNumber = (card) => Number(String(card.targetId).replace("target-", ""));
const quizCard = (n, index) => ({ id: `q${index + 1}`, targetId: `target-${n}`, kind: "quiz", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `Which statement about architecture principle ${n} follows from the definition?`, answer: `Principles guide later choices ${n}.`,
  hint: "Compare a description of today with a rule about permitted change.",
  explanation: `The definition ties principle ${n} to design and evolution, so later choices must follow it.`,
  misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }],
  options: [{ id: "a", text: `Principles guide later choices ${n}.`, correct: true, explanation: "The definition says principles guide design and evolution." },
    { id: "b", text: `Architecture is only today's diagram ${n}.`, correct: false, explanation: "Ignores the evolution part of the definition." },
    { id: "c", text: `Principles never constrain design ${n}.`, correct: false, explanation: "Contradicts the definition." }] });

/** A scripted model. `reviewFail`: target number -> failed checks (consumed by the first review that sees the card).
 *  `defects`: target number -> function applied to that card in the FIRST author call only. */
function fakeModel({ kind = "quiz", reviewFail = {}, defects = {}, patch } = {}) {
  const log = { calls: [], planCounts: [], authorTargets: [], patchPrompts: [], reviewSizes: [] };
  let authors = 0;
  const complete = async (system, prompt) => {
    if (system.startsWith("Plan a source-grounded assessment")) {
      const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
      log.calls.push("plan"); log.planCounts.push(request.count);
      const plan = qualityPlan({ ...request, kind });
      return JSON.stringify({ targets: plan.targets.map((target, index) => ({ ...target, objective: `Planned ${index + 1}` })) });
    }
    if (system.startsWith("Prepare supported answers")) {
      log.calls.push("blueprint");
      const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]), plan = request.assessmentPlan;
      const deck = { cards: plan.targets.map((target, index) => quizCard(Number(target.targetId.replace("target-", "")), index)) };
      return JSON.stringify({ items: deck.cards.map((card, index) => ({ targetId: plan.targets[index].targetId, answer: card.answer, reasoning: card.explanation,
        scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope", options: card.options })) });
    }
    if (system.startsWith("You author")) {
      log.calls.push("author"); authors++;
      const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]), plan = request.assessmentPlan;
      log.authorTargets.push(plan.targets.map((target) => target.targetId));
      const cards = plan.targets.map((target, index) => {
        const n = Number(target.targetId.replace("target-", "")), card = quizCard(n, index);
        return authors === 1 && defects[n] ? defects[n](card) : card;
      });
      return JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: qualityReview({ cards }).checks });
    }
    if (system.startsWith("Act as a strict assessment editor")) {
      log.calls.push("review");
      const candidate = JSON.parse(prompt).candidate; log.reviewSizes.push(candidate.cards.length);
      const review = qualityReview(candidate), issues = [];
      for (const check of review.checks) {
        const card = candidate.cards.find((item) => item.id === check.cardId), keys = reviewFail[targetNumber(card)];
        if (!keys) continue;
        delete reviewFail[targetNumber(card)];
        for (const key of keys) check[key] = "fail";
        issues.push(`${card.id}: ${keys.join(", ")} needs work`);
      }
      return JSON.stringify({ ...review, issues });
    }
    if (system.startsWith("Rewrite only the wording")) {
      log.calls.push("patch");
      const body = JSON.parse(prompt.split("REQUEST DATA:\n")[1]); log.patchPrompts.push(body);
      return JSON.stringify(patch ? patch(body) : { cards: body.cards.map((card) => ({ id: card.id, explanation: `Rewritten for ${card.id}: the decisive condition, then the result, then the nearest wrong path.` })) });
    }
    throw new Error(`unexpected call: ${system.slice(0, 40)}`);
  };
  return { complete, log };
}

const generate = (model, request = {}) => generateDeck(model.complete, { count: 3, kind: "quiz", sources: [source], ...request });
const byObjective = (deck, n) => deck.cards.find((card) => card.objective === `Planned ${n}`);

test("cardLocalIssues is the list generateDeck and draft.repair share", () => {
  const card = { ...quizCard(1, 0), hint: "x", explanation: "Principles guide later choices 1." };
  card.explanation = card.answer;
  const deck = { title: "D", cards: [card, { ...quizCard(2, 1), kind: "flashcard" }] };
  const constraints = { hintNoAnswer: true };
  const expected = [...validateDeck(deck, [source]).errors,
    ...deck.cards.flatMap((item, index) => item.kind !== "quiz" ? [`Card ${index + 1}: must use requested kind: quiz`] : []),
    ...learnerContextIssues(deck), ...explanationIssues(deck), ...answerLeakIssues(deck, constraints), ...formulaIssues(deck)];
  assert.ok(expected.length >= 2);
  assert.deepEqual(cardLocalIssues(deck, { sources: [source], expectedKind: "quiz", constraints }), expected);
  assert.ok(!cardLocalIssues(deck, { sources: [source], constraints }).some((issue) => /requested kind/.test(issue)), "no expected kind, no kind issue (draft.repair checks the id/kind itself)");
});

test("happy path: no patch, no reserve, the same calls as before", async () => {
  const model = fakeModel();
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review"]);
  assert.equal(result.cards.length, 3);
  assert.equal(result.editorial.repairedInRun, undefined);
  assert.equal(result.editorial.reserveUsed, undefined);
  assert.equal(result.editorial.reviewRounds, 1);
});

test("a card failing only explanationQuality is patched in the run; its answer fields stay byte-identical", async () => {
  const model = fakeModel({ reviewFail: { 2: ["explanationQuality"] }, defects: { 2: (card) => ({ ...card, explanation: card.answer }) },
    patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, explanation: "Rewritten: the definition ties principle 2 to evolution, so a later choice that ignores it is wrong.",
      answer: "HACKED", options: [], citations: [], objective: "HACKED", targetId: "target-9", id: card.id, kind: "flashcard" })) }) });
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review", "patch", "review"]);
  assert.equal(model.log.reviewSizes[1], 1, "only the patched card is re-reviewed");
  assert.equal(result.cards.length, 3);
  const patched = byObjective(result, 2), original = { ...quizCard(2, 1), citations: [{ sourceId: "s", quote: source.text.slice(0, 40) }] }; // citations are the plan target's, bound by the program
  assert.match(patched.explanation, /^Rewritten/);
  for (const key of ["answer", "options", "citations", "objective", "kind"]) assert.equal(JSON.stringify(patched[key]), JSON.stringify(original[key]), key);
  assert.equal(patched.targetId, "target-2");
  assert.deepEqual(result.cards.map((card) => card.objective), ["Planned 1", "Planned 2", "Planned 3"], "original order is preserved");
  assert.equal(result.editorial.repairedInRun, 1);
  assert.equal(result.editorial.dropped, undefined);
  assert.equal(result.editorial.omitted, undefined);
  assert.equal(result.editorial.reviewRounds, 2);
  const sent = model.log.patchPrompts[0];
  assert.equal(sent.cards.length, 1);
  assert.deepEqual(sent.cards[0].blueprint.options.map((option) => option.id), ["a", "b", "c"], "the bound blueprint item goes with the card");
  assert.deepEqual(sent.sources.map((item) => item.id), ["s"]);
  assert.ok(result.editorial.reviewedCards[patched.id], "the patched card has a review receipt");
});

test("local wording defects (a stem in the source's voice) are patched in one batched call", async () => {
  const model = fakeModel({ defects: { 1: (card) => ({ ...card, prompt: `According to the notes, ${card.prompt}` }), 3: (card) => ({ ...card, explanation: card.answer }) },
    patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, prompt: `Rewritten stem ${card.id}: which change does the definition permit?`, explanation: "Rewritten with the decisive condition and the tempting wrong path." })) }) });
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review", "patch", "review"], "one patch call for both cards");
  assert.equal(model.log.patchPrompts[0].cards.length, 2);
  assert.equal(result.cards.length, 3);
  assert.equal(result.editorial.repairedInRun, 2);
});

test("a hint that repeats the answer is fixed for free before the review, without a patch call", async () => {
  const model = fakeModel({ defects: { 1: (card) => ({ ...card, hint: card.answer }) } });
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review"]);
  assert.equal(result.cards.length, 3);
  assert.ok(result.editorial.autofixed >= 1);
  assert.equal(result.editorial.repairedInRun, undefined);
});

test("a sourceSupport failure is not patched", async () => {
  const model = fakeModel({ reviewFail: { 2: ["sourceSupport"] } });
  const result = await generate(model);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review"]);
  assert.equal(result.cards.length, 2);
  assert.equal(result.editorial.omitted.length, 1);
  assert.equal(result.editorial.repairedInRun, undefined);
});

test("a card that fails sourceSupport AND explanationQuality is not patched", async () => {
  const model = fakeModel({ reviewFail: { 2: ["explanationQuality", "sourceSupport"] } });
  const result = await generate(model);
  assert.ok(!model.log.calls.includes("patch"));
  assert.equal(result.cards.length, 2);
});

test("a patch that still fails the local checks, or a malformed patch reply, drops the card as before", async () => {
  const still = fakeModel({ reviewFail: { 2: ["explanationQuality"] }, patch: (body) => ({ cards: body.cards.map((card) => ({ id: card.id, explanation: "Principles guide later choices 2." })) }) });
  const first = await generate(still);
  assert.deepEqual(still.log.calls, ["plan", "blueprint", "author", "review", "patch"], "no review for a patch that fails locally");
  assert.equal(first.cards.length, 2);
  assert.equal(first.editorial.omitted.length, 1);
  assert.ok(first.editorial.omitted[0].reasons.some((reason) => /explanationQuality/.test(reason)), "original reasons are kept");
  const broken = fakeModel({ reviewFail: { 2: ["explanationQuality"] } });
  const wrap = broken.complete;
  broken.complete = async (system, prompt) => system.startsWith("Rewrite only the wording") ? "not json at all" : wrap(system, prompt);
  const second = await generate(broken);
  assert.equal(second.cards.length, 2, "an unreadable patch reply never fails the part");
});

test("a patched card that the review still rejects is dropped", async () => {
  const model = fakeModel({ reviewFail: { 2: ["explanationQuality"] } });
  const wrap = model.complete; let reviews = 0;
  model.complete = async (system, prompt) => {
    const reply = await wrap(system, prompt);
    if (!system.startsWith("Act as a strict assessment editor") || ++reviews < 2) return reply;
    const review = JSON.parse(reply); review.checks[0].explanationQuality = "fail"; return JSON.stringify(review);
  };
  const result = await generate(model);
  assert.equal(result.cards.length, 2);
  assert.equal(result.editorial.repairedInRun, undefined);
  assert.equal(result.editorial.omitted.length, 1);
});

test("an aborted run does not patch", async () => {
  const controller = new AbortController(), model = fakeModel({ reviewFail: { 2: ["explanationQuality"] } });
  const wrap = model.complete;
  model.complete = async (system, prompt) => { const reply = await wrap(system, prompt); if (system.startsWith("Act as a strict assessment editor")) controller.abort(new Error("stop")); return reply; };
  await assert.rejects(generate(model, { signal: controller.signal }), /stop/);
  assert.ok(!model.log.calls.includes("patch"));
});

const reserveTargets = (from, n) => qualityPlan({ count: n, kind: "quiz", sources: [source], existing: [] }).targets
  .map((target, index) => ({ ...target, targetId: `target-${from + index}`, objective: `Planned ${from + index}` }));
const ownPlan = () => ({ targets: reserveTargets(1, 3) });

test("a part short by one claims exactly one reserve target and ends at the full count", async () => {
  const model = fakeModel({ reviewFail: { 2: ["sourceSupport"] } }), claims = [];
  const pool = reserveTargets(4, 2);
  const result = await generate(model, { assessmentPlan: ownPlan(), claimReserve: (n) => { claims.push(n); return pool.splice(0, n); } });
  assert.deepEqual(claims, [1]);
  assert.equal(pool.length, 1, "the other reserve target stays in the pool");
  assert.deepEqual(model.log.calls, ["blueprint", "author", "review", "blueprint", "author", "review"]);
  assert.deepEqual(model.log.authorTargets, [["target-1", "target-2", "target-3"], ["target-4"]]);
  assert.equal(result.cards.length, 3);
  assert.deepEqual(result.cards.map((card) => card.objective), ["Planned 1", "Planned 3", "Planned 4"]);
  assert.equal(new Set(result.cards.map((card) => card.id)).size, 3, "reserve ids never collide with the first batch's");
  assert.equal(result.editorial.reserveUsed, 1);
  assert.equal(result.editorial.omitted.length, 1, "the dropped candidate is still reported");
  assert.equal(result.editorial.reviewRounds, 2);
  assert.ok(result.editorial.audit.checks.every((check) => result.cards.some((card) => card.id === check.cardId)));
  assert.ok(result.cards.every((card) => result.editorial.reviewedCards[card.id]));
});

test("without claimReserve (the single-call path) a short part stays short and makes no extra call", async () => {
  const model = fakeModel({ reviewFail: { 2: ["sourceSupport"] } });
  const result = await generate(model, { assessmentPlan: ownPlan() });
  assert.deepEqual(model.log.calls, ["blueprint", "author", "review"]);
  assert.equal(result.cards.length, 2);
});

test("an empty reserve, or a reserve card that fails review, never fails the part", async () => {
  const none = fakeModel({ reviewFail: { 2: ["sourceSupport"] } });
  const first = await generate(none, { assessmentPlan: ownPlan(), claimReserve: () => [] });
  assert.equal(first.cards.length, 2);
  assert.deepEqual(none.log.calls, ["blueprint", "author", "review"]);
  const weak = fakeModel({ reviewFail: { 2: ["sourceSupport"], 4: ["sourceSupport"] } });
  const second = await generate(weak, { assessmentPlan: ownPlan(), claimReserve: (n) => reserveTargets(4, n) });
  assert.equal(second.cards.length, 2);
  assert.equal(second.editorial.reserveUsed, undefined);
});

test("a happy part never touches the reserve", async () => {
  const model = fakeModel();
  const result = await generate(model, { assessmentPlan: ownPlan(), claimReserve: () => { throw new Error("claimed without need"); } });
  assert.equal(result.cards.length, 3);
});

test("the batch plans a few extra targets and hands them out as reserve; a happy run asks nothing more", async () => {
  const model = fakeModel();
  const result = await generateBatched(model.complete, { count: 3, kind: "quiz", sources: [source] });
  assert.deepEqual(model.log.planCounts, [4], "3 + ceil(3 * 0.2)");
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review"]);
  assert.equal(result.cards.length, 3);
  const small = fakeModel();
  await generateBatched(small.complete, { count: 2, kind: "quiz", sources: [source] });
  assert.deepEqual(small.log.planCounts, [2], "no reserve under three questions");
});

test("a failed card is replaced from the group's reserve, not by a rerun", async () => {
  const model = fakeModel({ reviewFail: { 2: ["sourceSupport"] } });
  const result = await generateBatched(model.complete, { count: 3, kind: "quiz", sources: [source] });
  assert.equal(result.cards.length, 3);
  assert.deepEqual(model.log.calls, ["plan", "blueprint", "author", "review", "blueprint", "author", "review"]);
  assert.deepEqual(model.log.authorTargets[1], ["target-4"]);
  assert.equal(result.editorial.reserveUsed, 1);
  assert.deepEqual(result.editorial.failures, []);
});

test("two parallel parts never claim the same reserve target", async () => {
  const model = fakeModel({ reviewFail: { 2: ["sourceSupport"], 7: ["sourceSupport"] } });
  const result = await generateBatched(model.complete, { count: 10, kind: "quiz", sources: [source] });
  assert.deepEqual(model.log.planCounts, [12], "10 + min(3, ceil(2))");
  const reserve = model.log.authorTargets.filter((targets) => targets.every((id) => Number(id.replace("target-", "")) > 10)).flat();
  assert.equal(reserve.length, 2);
  assert.equal(new Set(reserve).size, 2, "each part got its own target");
  assert.equal(result.cards.length, 10);
  assert.equal(new Set(result.cards.map((card) => card.objective)).size, 10);
  assert.equal(result.editorial.reserveUsed, 2);
});

test("a pool smaller than the shortfall is shared out once, never twice", async () => {
  // Three failures, two reserve targets: the third part-short card is simply missing; nobody gets a target twice.
  const model = fakeModel({ reviewFail: { 1: ["sourceSupport"], 2: ["sourceSupport"], 6: ["sourceSupport"] } });
  const result = await generateBatched(model.complete, { count: 10, kind: "quiz", sources: [source] });
  const reserve = model.log.authorTargets.filter((targets) => targets.every((id) => Number(id.replace("target-", "")) > 10)).flat();
  assert.equal(new Set(reserve).size, reserve.length);
  assert.ok(reserve.length <= 2);
  assert.equal(result.cards.length, 10 - 3 + reserve.length);
});
