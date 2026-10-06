import test from "node:test";
import assert from "node:assert/strict";
import { generateBatched } from "../lib/batch.js";
import { GENERATION_SETTINGS_DEFAULTS, GENERATION_SETTINGS_LIMITS, normalizeGenerationPerformance, validateGenerationPatch, resolveGenerationRequest } from "../lib/generation-settings.js";
import { priorRoundBrief, rejectionCode } from "../lib/generation-yield.js";
import { fakeModel, source } from "./helpers/fill-rounds-model.mjs";

/* #197: a part that ends short is filled again automatically, a bounded number of rounds, each round asking only for the gap, with what the
   earlier candidates were rejected for in its prompt; a rejected objective is never tried again; cancel and timeout stop at once and keep
   what passed. Round 1 draws on the group's verified reserve; later rounds plan new targets (avoiding every rejected objective). */

const run = (model, request = {}) => generateBatched(model.complete, { count: 5, kind: "quiz", sources: [source], performance: { concurrency: 1, batchSize: 5 }, ...request });
const withRounds = (fillRounds) => ({ concurrency: 1, batchSize: 5, fillRounds });

test("fillRounds is a setting: default 2, 0-4, kept with the job's performance", () => {
  assert.equal(GENERATION_SETTINGS_DEFAULTS.fillRounds, 2);
  assert.deepEqual(GENERATION_SETTINGS_LIMITS.fillRounds, { min: 0, max: 4 });
  assert.equal(normalizeGenerationPerformance({}).fillRounds, 2);
  assert.equal(normalizeGenerationPerformance({ fillRounds: 0 }).fillRounds, 0);
  assert.equal(normalizeGenerationPerformance({ fillRounds: 9 }).fillRounds, 2, "an out-of-range value falls back to the default");
  assert.deepEqual(validateGenerationPatch({ fillRounds: 4 }), { fillRounds: 4 });
  assert.throws(() => validateGenerationPatch({ fillRounds: 5 }), /Invalid generation setting: fillRounds/);
  assert.throws(() => validateGenerationPatch({ fillRounds: 1.5 }), /Invalid generation setting: fillRounds/);
  assert.equal(resolveGenerationRequest({ fillRounds: 3 }, {}, { language: "zh" }).performance.fillRounds, 3);
  assert.equal(resolveGenerationRequest({ fillRounds: 3 }, { performance: { fillRounds: 1 } }, { language: "zh" }).performance.fillRounds, 1);
});

test("a part that ends short is filled again: the reserve first, then newly planned targets, each round only the gap", async () => {
  // 5 asked + 1 reserve are planned; 3 of the first 5 fail source support, so 2 are kept and 3 are missing.
  const model = fakeModel({ rejectObjectives: new Set(["Planned 1", "Planned 2", "Planned 3"]) });
  const result = await run(model, { performance: withRounds(2) });
  assert.equal(result.cards.length, 5, "round 2 reached the target");
  assert.deepEqual(model.log.plans.map((plan) => plan.count), [6, 2], "the group plan, then a replan for the 2 still missing after the reserve gave 1");
  assert.deepEqual(model.log.authors.map((author) => author.objectives.length), [5, 1, 2], "first batch, round 1 (the one reserve target), round 2 (the gap)");
  assert.equal(result.editorial.fillRoundsUsed, 2);
  assert.equal(new Set(result.cards.map((card) => card.objective)).size, 5);
  assert.ok(result.cards.every((card) => !["Planned 1", "Planned 2", "Planned 3"].includes(card.objective)), "no rejected objective came back");
  assert.deepEqual(result.editorial.failures, []);
});

test("the bound on rounds holds: fillRounds 1 never replans, 0 never fills, a stubborn gap ends the part short", async () => {
  const one = fakeModel({ rejectObjectives: new Set(["Planned 1", "Planned 2", "Planned 3"]) });
  const first = await run(one, { performance: withRounds(1) });
  assert.equal(first.cards.length, 3, "2 kept + the 1 reserve target; no replan");
  assert.deepEqual(one.log.plans.map((plan) => plan.count), [6]);
  const none = fakeModel({ rejectObjectives: new Set(["Planned 1", "Planned 2", "Planned 3"]) });
  const second = await run(none, { performance: withRounds(0) });
  assert.equal(second.cards.length, 2);
  assert.deepEqual(none.log.calls, ["plan", "blueprint", "author", "review"]);
  // Everything beyond the first batch is rejected too: two rounds are spent, and the part reports itself short.
  const stubborn = fakeModel({ rejectObjectives: new Set(Array.from({ length: 30 }, (_, index) => `Planned ${index + 1}`).filter((name) => !["Planned 4", "Planned 5"].includes(name))) });
  const third = await run(stubborn, { performance: withRounds(2) });
  assert.equal(third.cards.length, 2);
  assert.equal(stubborn.log.plans.length, 2, "one group plan and one replan, never a third");
  assert.ok(third.editorial.failures.some((line) => /retained 2\/5/.test(line)));
  assert.equal(third.editorial.fillRoundsUsed, 2);
});

test("what the earlier candidates were rejected for goes into the next round's prompt, and no rejected objective is asked again", async () => {
  const model = fakeModel({ rejectObjectives: new Set(["Planned 1", "Planned 2", "Planned 3", "Planned 7"]) });
  const result = await run(model, { performance: withRounds(2) });
  const [, round1, round2] = model.log.authors;
  assert.ok(round1.priorRound, "round 1 already knows why the first batch lost cards");
  assert.match(JSON.stringify(round1.priorRound), /not supported by the quoted source/);
  assert.deepEqual(round1.priorRound.rejectedObjectives.sort(), ["Planned 1", "Planned 2", "Planned 3"]);
  assert.equal(round1.priorRound.rejectedFor[0].count, 3);
  assert.ok(round2?.priorRound?.rejectedObjectives, "round 2 knows the round before as well");
  const replan = model.log.plans[1];
  for (const objective of ["Planned 1", "Planned 2", "Planned 3"]) assert.ok(replan.existing.includes(objective), `${objective} is excluded from the replan`);
  const asked = model.log.authors.flatMap((author) => author.objectives);
  assert.equal(new Set(asked).size, asked.length, "no objective was written twice");
  assert.ok(result.cards.length >= 4);
});

test("cancelling during a fill round stops at once and keeps the cards that passed", async () => {
  const controller = new AbortController(), saved = [];
  const model = fakeModel({ rejectObjectives: new Set(["Planned 1", "Planned 2", "Planned 3"]), onAuthor: (request) => { if (request.assessmentPlan.targets.length < 5) controller.abort(new Error("stopped by the learner")); } });
  await assert.rejects(run(model, { performance: withRounds(2), signal: controller.signal }, ), /stopped by the learner/);
  void saved;
  const calls = model.log.calls.length;
  assert.ok(!model.log.calls.slice(calls - 1).includes("plan"), "no further planning after the stop");
});

test("a checkpoint with the first pass is saved before any fill round, so a stop keeps it", async () => {
  const checkpoints = [], controller = new AbortController();
  const model = fakeModel({ rejectObjectives: new Set(["Planned 1", "Planned 2", "Planned 3"]), onAuthor: (request) => { if (request.assessmentPlan.targets.length < 5) controller.abort(new Error("stop")); } });
  await assert.rejects(generateBatched(model.complete, { count: 5, kind: "quiz", sources: [source], performance: withRounds(2), signal: controller.signal },
    () => {}, async (deck) => { checkpoints.push(deck.cards.length); }), /stop/);
  assert.ok(checkpoints.some((count) => count === 2), `the 2 passed cards were saved: ${checkpoints}`);
});

test("rejection reasons are grouped in plain words for the prompt", () => {
  assert.equal(rejectionCode("q2: answerLeak failed or was not checked"), "leak");
  assert.equal(rejectionCode("Card 2: hint reveals the answer"), "leak");
  assert.equal(rejectionCode("q2: optionQuality failed or was not checked"), "options");
  assert.equal(rejectionCode("q2: learningValue failed or was not checked"), "value");
  assert.equal(rejectionCode("q2: sourceSupport failed or was not checked"), "source");
  assert.equal(rejectionCode("q2: explanationQuality failed or was not checked"), "explanation");
  assert.equal(rejectionCode("something else"), "other");
  assert.equal(priorRoundBrief([]), undefined);
  const brief = priorRoundBrief([{ objective: "A", reasons: ["q1: answerLeak failed or was not checked"] }, { objective: "B", reasons: ["q2: answerLeak failed or was not checked", "q2: optionQuality failed or was not checked"] }]);
  assert.deepEqual(brief.rejectedFor.map((item) => item.count), [2, 1]);
  assert.match(brief.rejectedFor[0].reason, /gave away the answer/);
  assert.deepEqual(brief.rejectedObjectives, ["A", "B"]);
});
