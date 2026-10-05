import test from "node:test";
import assert from "node:assert/strict";
import { generateBatched } from "../lib/batch.js";
import { buildPartPlans, PART_PLAN_LIMITS } from "../lib/plan-record.js";
import { fallbackDeckTitle } from "../lib/deck-title.js";
import { mergeContinuedDraft } from "../lib/bank-import.js";
import { summarizePartOutcomes } from "../lib/generation-report.js";
import { injectedModel, source } from "./helpers/review-injector.mjs";

/* The owner's run: 2 of 8 parts failed because the review reply was malformed, the part was thrown away, never run again, and the job still said
   "complete". Now: the review is asked again (tests/review-reask.test.mjs); a part that still fails keeps its authored candidates and is run again in
   the automatic fill rounds (its review first, a fresh attempt only when it had no usable output), bounded by fillRounds; the plan of every part,
   failed ones too, is kept on the draft; and the reason recorded is the true one. Every case injects its failure, so it is reproducible. */

const run = (model, { fillRounds = 2, ...request } = {}) => generateBatched(model.complete, { count: 10, kind: "quiz", sources: [source],
  performance: { concurrency: 1, batchSize: 5, fillRounds }, ...request });
const bad = '{"issues":';
const failPart2Review = (times) => ({ part, nth }) => (part === 2 && nth <= times ? bad : undefined);
const plansOf = (deck) => deck.editorial.partPlans;

test("a part whose review stays unreadable is reviewed again in a fill round; the authored questions are kept, never written twice", async () => {
  const model = injectedModel({ review: failPart2Review(3) });
  const deck = await run(model);
  assert.equal(deck.cards.length, 10, "both parts reached the draft");
  assert.deepEqual(deck.editorial.failures, []);
  assert.equal(model.count("plan"), 1);
  assert.equal(model.count("blueprint"), 2);
  assert.equal(model.count("author"), 2, "part 2 was not written again");
  assert.equal(model.count("review", 1), 1);
  assert.equal(model.count("review", 2), 4, "its three tries in the run, then one review in the fill round");
  const [one, two] = plansOf(deck);
  assert.equal(one.attempts, 1);
  assert.equal(two.attempts, 2, "the part ran twice");
  assert.equal(two.status, "passed");
  assert.ok(two.targets.every((target) => target.status === "kept"));
  assert.equal(deck.editorial.partReport.passed, 2);
  assert.equal(deck.editorial.partReport.parts[1].attempts, 2);
});

test("fillRounds 0 never runs a part again: it fails with the true reason, its candidates and plan are on record", async () => {
  const model = injectedModel({ review: failPart2Review(99) });
  const deck = await run(model, { fillRounds: 0 });
  assert.equal(deck.cards.length, 5);
  assert.equal(model.count("review", 2), 3, "the review and its two re-asks, nothing more");
  assert.equal(deck.editorial.failures.length, 1);
  assert.match(deck.editorial.failures[0], /^Part 2: Review (?:JSON )?protocol failed after 3 attempts/);
  const [one, two] = plansOf(deck);
  assert.equal(one.status, "passed");
  assert.equal(two.status, "failed");
  assert.equal(two.reason, "review-protocol");
  assert.equal(two.attempts, 1);
  assert.equal(two.targets.length, 5, "the plan of a part that failed entirely is not lost");
  for (const target of two.targets) {
    assert.equal(target.status, "failed");
    assert.equal(target.reason, "review-protocol");
    assert.equal(target.sourceId, "s");
    assert.ok(target.objective && target.targetId);
    assert.ok(target.quote && target.quote.length <= 200);
  }
  assert.ok(one.targets.every((target) => target.status === "kept"));
  assert.deepEqual(deck.editorial.partReport.parts[1].reasons, ["review-protocol"]);
  assert.equal(deck.editorial.partReport.reasons["review-protocol"], 1);
});

test("the rounds are bounded by fillRounds: a stubborn review is tried 3 + 3 + 3 times and the part fails with the total", async () => {
  const model = injectedModel({ review: failPart2Review(999) });
  const deck = await run(model, { fillRounds: 2 });
  assert.equal(model.count("review", 2), 9, "never beyond fillRounds");
  assert.equal(model.count("author"), 2);
  assert.equal(model.count("blueprint"), 2);
  assert.match(deck.editorial.failures[0], /^Part 2: Review (?:JSON )?protocol failed after 9 attempts/);
  assert.equal(plansOf(deck)[1].attempts, 3);
  assert.equal(plansOf(deck)[1].reason, "review-protocol");
  const one = injectedModel({ review: failPart2Review(999) });
  await run(one, { fillRounds: 1 });
  assert.equal(one.count("review", 2), 6);
});

test("a part with no usable output is written again from its plan, once the others are done", async () => {
  const model = injectedModel({ author: ({ part, nth }) => (part === 2 && nth <= 2 ? "not json at all" : undefined) });
  const deck = await run(model);
  assert.equal(deck.cards.length, 10);
  assert.equal(model.count("plan"), 1, "the plan of the part is kept: no second plan call");
  assert.equal(model.count("blueprint", 2), 2);
  assert.equal(model.count("author", 2), 3, "two bad replies, then the fresh attempt");
  assert.equal(model.count("review", 2), 1);
  assert.equal(plansOf(deck)[1].attempts, 2);
  assert.deepEqual(deck.editorial.failures, []);
});

test("a part whose planning failed is planned again by itself, then written", async () => {
  let planCalls = 0;
  const model = injectedModel({ plan: () => (++planCalls <= 2 ? "no targets here" : undefined) });
  const deck = await run(model);
  assert.equal(deck.cards.length, 10, "both parts came back");
  assert.equal(model.count("plan"), 4, "the group's plan and its retry failed; each part was then planned again");
  assert.ok(plansOf(deck).every((part) => part.status === "passed" && part.attempts === 2));
});

test("a failure no repetition can fix (a refused key) is not run again, and the reason says so", async () => {
  const model = injectedModel({ author: ({ part }) => { if (part === 2) throw new Error("Invalid API key (401 unauthorized)"); } });
  const deck = await run(model);
  assert.equal(deck.cards.length, 5);
  assert.equal(model.count("author", 2), 1);
  assert.equal(model.count("blueprint", 2), 1);
  assert.equal(plansOf(deck)[1].attempts, 1);
  assert.equal(plansOf(deck)[1].reason, "credential");
  assert.match(deck.editorial.failures[0], /^Part 2: Invalid API key/);
});

test("a stop never starts the fill rounds", async () => {
  const controller = new AbortController();
  const model = injectedModel({ review: ({ part }) => { if (part === 2) controller.abort(new Error("stopped by the learner")); return part === 2 ? bad : undefined; } });
  await assert.rejects(run(model, { signal: controller.signal }), /stopped by the learner/);
  assert.equal(model.count("review", 2), 1);
});

test("a part that kept only some questions lists which targets were kept and which were omitted, with the reviewer's reason", async () => {
  const model = injectedModel({ review: ({ part, nth, reply, candidate }) => {
    if (part !== 1 || nth !== 1) return undefined;
    const value = JSON.parse(reply), card = candidate.cards[0];
    value.issues = [`${card.id}: sourceSupport failed - the evidence does not support the answer`];
    value.checks = value.checks.map((check) => (check.cardId === card.id ? { ...check, sourceSupport: "fail", explanation: "The evidence does not support the answer." } : check));
    return value;
  } });
  const deck = await run(model, { fillRounds: 0 });
  const [one] = plansOf(deck);
  assert.equal(one.status, "partial");
  assert.equal(one.targets.filter((target) => target.status === "kept").length, 4);
  const omitted = one.targets.filter((target) => target.status === "omitted");
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0].reason, "quality");
});

test("the title of the draft is never a placeholder: the request's, else the model's, else the material's own name", async () => {
  const salvaged = ({ part, nth, reply }) => {
    if (nth !== 1) return undefined;
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    return part === 1 || part === null ? text.slice(0, text.indexOf('],"changes"')) : undefined;
  };
  // The first part's reply is cut off after its cards: salvaged, and a salvaged fragment has no title.
  const first = await run(injectedModel({ author: salvaged, title: "Architecture basics" }), { fillRounds: 0 });
  assert.equal(first.title, "Architecture basics", "the other part's real title wins over a placeholder");
  assert.equal(first.cards.length, 10);
  const named = await run(injectedModel({ author: salvaged }), { fillRounds: 0, title: "我的题组" });
  assert.equal(named.title, "我的题组");
  const only = await run(injectedModel({ author: salvaged, title: "" }), { fillRounds: 0, count: 5 });
  assert.equal(only.title, "Course notes", "no title anywhere: the material's own display name");
  assert.doesNotMatch(only.title, /Recovered/i);
  const english = await run(injectedModel({ author: salvaged, title: "" }), { fillRounds: 0, count: 5, language: "English", sources: [{ ...source, title: "" }] });
  assert.equal(english.title, "New question set", "localised, never Chinese for an English request");
  const chinese = await run(injectedModel({ author: salvaged, title: "" }), { fillRounds: 0, count: 5, language: "中文", sources: [{ ...source, title: "" }] });
  assert.equal(chinese.title, "新题组");
});

test("fallbackDeckTitle names a deck from its materials, in the language of the request", () => {
  assert.equal(fallbackDeckTitle([{ title: "平台框架培训-第一天.mp3" }], "中文"), "平台框架培训-第一天");
  assert.equal(fallbackDeckTitle([{ title: "Notes.pdf" }, { title: "b" }, { title: "c" }], "English"), "Notes and 2 more");
  assert.equal(fallbackDeckTitle([{ title: "Notes.pdf" }, { title: "b" }, { title: "c" }], "中文"), "Notes 等 3 份资料");
  assert.equal(fallbackDeckTitle([], "English"), "New question set");
  assert.equal(fallbackDeckTitle([], "中英双语"), "新题组");
  assert.ok(fallbackDeckTitle([{ title: "x".repeat(200) }], "English").length <= 60);
});

test("partPlans is bounded: at most 400 targets, quotes of at most 200 characters", () => {
  const sources = [{ id: "s" }], long = "q".repeat(500);
  const planned = Array.from({ length: 30 }, () => ({ sources, count: 20, kind: "quiz" }));
  const plans = new Map(planned.map((part, k) => [k, { targets: Array.from({ length: 20 }, (_, i) => ({ targetId: `target-${i + 1}`, objective: "o".repeat(300),
    citations: [{ sourceId: "s", quote: long }] })) }]));
  const outcomes = planned.map(() => ({ error: "Review protocol failed after 3 attempts: x", pending: false }));
  const records = buildPartPlans({ planned, outcomes, plans });
  assert.equal(PART_PLAN_LIMITS.targets, 400);
  assert.equal(records.length, 30, "every part is on record");
  assert.equal(records.flatMap((part) => part.targets).length, 400);
  assert.ok(records.flatMap((part) => part.targets).every((target) => target.quote.length <= 200 && target.objective.length <= 200));
  assert.ok(records[29].targets.length === 0 && records[29].truncated === true, "a part past the bound still says it was planned and failed");
  assert.equal(records[29].status, "failed");
});

test("a part with no plan (planning never succeeded) is on record with no targets and its reason", () => {
  const planned = [{ sources: [{ id: "a" }, { id: "b" }], count: 5, kind: "quiz" }];
  const records = buildPartPlans({ planned, outcomes: [{ error: "Request timed out after 120s" }], plans: new Map(), runs: new Map([[0, 2]]) });
  assert.deepEqual(records, [{ part: 1, sourceIds: ["a", "b"], targets: [], status: "failed", reason: "timeout", attempts: 2 }]);
});

test("continuing a draft keeps the plans of the earlier parts and numbers the new ones after them", () => {
  const base = { id: "d", title: "T", cards: [], editorial: { requested: 10, generated: 0, parts: 2, completedParts: 2, failures: [], generation: { sourceIds: ["s"] },
    partPlans: [{ part: 1, sourceIds: ["s"], targets: [{ targetId: "target-1", objective: "a", sourceId: "s", status: "kept" }], status: "passed", attempts: 1 },
      { part: 2, sourceIds: ["s"], targets: [{ targetId: "target-6", objective: "b", sourceId: "s", status: "failed", reason: "review-protocol" }], status: "failed", reason: "review-protocol", attempts: 3 }] } };
  const fresh = { id: "f", title: "T", cards: [], editorial: { parts: 1, completedParts: 1, failures: [], generation: { sourceIds: ["s"], course: "" },
    partPlans: [{ part: 1, sourceIds: ["s"], targets: [{ targetId: "fill-1", objective: "c", sourceId: "s", status: "kept" }], status: "passed", attempts: 1 }] } };
  const merged = mergeContinuedDraft(base, fresh, [{ id: "s", title: "S" }]);
  assert.deepEqual(merged.editorial.partPlans.map((part) => part.part), [1, 2, 3]);
  assert.equal(merged.editorial.partPlans[1].reason, "review-protocol", "an earlier failure stays visible to the coverage view");
});

test("the part report keeps the codes of the new reasons and its numbers", () => {
  const report = summarizePartOutcomes({ planned: [{ count: 5 }, { count: 5 }, { count: 5 }, { count: 5 }],
    outcomes: [{ error: "Review protocol failed after 3 attempts: missing complete per-card checks" }, { error: "Model timed out after 120s" },
      { error: "Model returned no text" }, { error: "Invalid API key (401)" }] });
  assert.deepEqual(report.reasons, { "review-protocol": 1, timeout: 1, "no-reply": 1, credential: 1 });
  assert.match(report.summary, /4 produced none/);
  assert.equal(report.failed, 4);
});
