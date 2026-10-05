import test from "node:test";
import assert from "node:assert/strict";
import { generateDeck, reviewDeck } from "../lib/generation.js";
import { REVIEW_REASKS, REVIEW_PROTOCOL, classifyFailure } from "../lib/generation-failure.js";
import { injectedModel, source, quizCard, keepChecks, cutInCheck } from "./helpers/review-injector.mjs";

/* The review of a part is asked again when its reply cannot be used: cut off, not JSON, or without a complete check for every question. A truncated
   reply is salvaged (the complete per-card checks parsed so far are kept; only the rest is asked again). Only after the re-asks does the part fail,
   with a typed error. The publish path (singleRound false) keeps its own single re-ask. Every case here injects the failure, so it is reproducible. */

const request = { count: 3, kind: "quiz", sources: [source] };
const reviews = (model) => model.log.reviews;

test("the review is asked again at most twice: 1 + REVIEW_REASKS calls", () => { assert.equal(REVIEW_REASKS, 2); });

test("a review reply that is not JSON is asked again once, and the part goes on", async () => {
  const model = injectedModel({ review: ({ nth }) => (nth === 1 ? '{"issues":' : undefined) });
  const deck = await generateDeck(model.complete, request);
  assert.equal(deck.cards.length, 3);
  assert.equal(model.count("review"), 2, "one re-ask, nothing more");
  assert.deepEqual(model.log.calls.filter((call) => call.stage === "review").map((call) => [call.retry, call.kind]), [[0, null], [1, "review"]],
    "the re-ask is marked as a review retry so the console can show it");
  assert.equal(model.count("plan"), 1);
  assert.equal(model.count("author"), 1, "the author is never asked again for a bad review");
  assert.equal(deck.editorial.reviewReasks, 1);
});

test("a truncated reply keeps the complete checks parsed so far and only the rest is asked again", async () => {
  const model = injectedModel({ review: ({ nth, reply }) => (nth === 1 ? cutInCheck(reply, 3) : undefined) });
  const deck = await generateDeck(model.complete, request);
  assert.equal(deck.cards.length, 3, "all three questions are reviewed in the end");
  assert.equal(model.count("review"), 2);
  const [first, second] = reviews(model);
  assert.deepEqual(first.cardIds, second.cardIds, "the same candidate and the same payload prefix");
  assert.deepEqual(JSON.parse(second.prompt).reask.onlyCardIds, ["q3"], "q1 and q2 were salvaged; only q3 is asked for");
  assert.equal(deck.editorial.audit.checks.length, 3, "the audit holds a check for every kept question");
  assert.deepEqual(deck.editorial.audit.checks.map((check) => check.cardId).length, 3);
});

test("complete JSON with too few checks is asked again for the missing cards only, then accepted", async () => {
  const model = injectedModel({ review: ({ nth, reply }) => (nth === 1 ? keepChecks(reply, 1) : undefined) });
  const deck = await generateDeck(model.complete, request);
  assert.equal(deck.cards.length, 3);
  assert.equal(model.count("review"), 2);
  assert.deepEqual(JSON.parse(reviews(model)[1].prompt).reask.onlyCardIds, ["q2", "q3"]);
});

test("a reply that stays unusable gets two re-asks, the second with the exact format; then a typed failure that keeps the authored candidates", async () => {
  const model = injectedModel({ review: () => '{"issues":' });
  const error = await generateDeck(model.complete, request).then(() => null, (failure) => failure);
  assert.ok(error, "the part failed");
  assert.equal(error.code, REVIEW_PROTOCOL);
  assert.equal(error.attempts, 1 + REVIEW_REASKS);
  assert.match(error.message, /^Review (?:JSON )?protocol failed after 3 attempts/);
  assert.equal(model.count("review"), 3);
  assert.deepEqual(reviews(model).map((entry) => entry.retry), [0, 1, 2]);
  assert.equal(JSON.parse(reviews(model)[1].prompt).reask.format, undefined, "the first re-ask is only a reminder");
  assert.match(JSON.parse(reviews(model)[2].prompt).reask.format.checks[0].cardId, /exact candidate id/, "the second re-ask carries the exact format");
  assert.equal(JSON.parse(reviews(model)[0].prompt).reask, undefined);
  assert.deepEqual(Object.keys(JSON.parse(reviews(model)[1].prompt)).slice(0, -1), Object.keys(JSON.parse(reviews(model)[0].prompt)), "the same payload; only a reask field is added at the end (the provider's cached prefix is unchanged)");
  assert.equal(model.count("author"), 1);
  assert.equal(error.authored.draft.cards.length, 3, "the authored candidates are not lost");
  assert.equal(error.authored.assessmentPlan.targets.length, 3);
  assert.equal(error.authored.answerBlueprint.items.length, 3);
  assert.equal(classifyFailure(error).code, REVIEW_PROTOCOL);
  assert.equal(classifyFailure(error).attempts, 3);
});

test("a reply that keeps missing checks is the same typed failure, and says it was incomplete", async () => {
  const model = injectedModel({ review: ({ reply }) => keepChecks(reply, 1) });
  const error = await generateDeck(model.complete, request).then(() => null, (failure) => failure);
  assert.equal(error.code, REVIEW_PROTOCOL);
  assert.match(error.message, /Review protocol failed after 3 attempts: missing complete per-card checks/);
  assert.equal(model.count("review"), 3);
});

test("a failed part can be resumed from its retained candidates: only the review is asked again", async () => {
  const model = injectedModel({ review: ({ nth }) => (nth <= 3 ? '{"issues":' : undefined) });
  const error = await generateDeck(model.complete, request).then(() => null, (failure) => failure);
  const deck = await generateDeck(model.complete, { ...request, resumeAuthored: error.authored });
  assert.equal(deck.cards.length, 3);
  assert.deepEqual([model.count("plan"), model.count("blueprint"), model.count("author"), model.count("review")], [1, 1, 1, 4], "no plan, answer or author call again");
});

test("an abort between the re-asks stops at once and is not a protocol failure", async () => {
  const controller = new AbortController();
  const model = injectedModel({ review: () => { controller.abort(new Error("stopped by the learner")); return '{"issues":'; } });
  await assert.rejects(generateDeck(model.complete, { ...request, signal: controller.signal }), /stopped by the learner/);
  assert.equal(model.count("review"), 1);
});

test("publish path: singleRound false keeps its own single re-ask and never throws for a bad shape", async () => {
  const deck = { title: "D", cards: [quizCard(1, 0, "target-1")] };
  const calls = [];
  const complete = async (system, prompt, context) => {
    calls.push({ prompt, context });
    return JSON.stringify({ issues: [] });
  };
  const result = await reviewDeck(complete, { sources: [source], deck, kind: "quiz", count: 1 });
  assert.equal(calls.length, 2, "asked again once, as before");
  assert.match(calls[1].prompt, /Your previous review was unusable/);
  assert.deepEqual(result.checks, []);
  const fine = [];
  const good = await reviewDeck(async (system, prompt) => { fine.push(prompt); return calls.length ? JSON.stringify({ issues: [], summary: "ok", checks: [{ cardId: "q1" }] }) : ""; },
    { sources: [source], deck, kind: "quiz", count: 1 });
  assert.equal(fine.length, 1, "a well-formed reply is one call");
  assert.equal(good.summary, "ok");
});
