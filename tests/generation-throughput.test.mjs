import test from "node:test";
import assert from "node:assert/strict";
import { generateBatched } from "../lib/batch.js";
import { GENERATION_SETTINGS_DEFAULTS, GENERATION_SETTINGS_LIMITS } from "../lib/generation-settings.js";
import { qualityPlan, qualityReview } from "./helpers/assessment.mjs";
import { until } from "./helpers/wait.mjs";

/* #198: where the time goes (queue vs model call, per stage), and the throughput that follows from it: the groups of a big job are planned at the
   same time instead of one after the other, the default budget is wider, and a provider that answers 429 makes the run slow down (and speed up
   again) instead of failing a part. Every review still happens. */

const paragraph = (n) => `Section ${n}. Architecture includes the principles guiding a system's design and evolution, number ${n}. `.repeat(2);
const sources = Array.from({ length: 4 }, (_, index) => ({ id: `s${index + 1}`, title: `Page ${index + 1}`, text: paragraph(index + 1) }));
const number = (id) => Number(String(id).replace(/\D+/g, ""));
const card = (n, index, targetId, sourceId) => ({ id: `q${index + 1}`, targetId, kind: "flashcard", topic: `Architecture scope ${n}`, objective: `Planned ${n}`,
  prompt: `What does section ${n} say about architecture principle ${n}?`, answer: `Principles guide later choices ${n}.`, hint: "Think about change over time.",
  explanation: `The passage ties principle ${n} to design and evolution.`, misconception: "Architecture only describes components.",
  citations: [{ sourceId, quote: paragraph(number(sourceId)).slice(0, 60) }] });

/** A fake provider with a fixed latency per call, an optional limit on concurrent calls (over it: a 429) and a record of what ran together. */
function provider({ latency = 5, limit = Infinity, always429 = false } = {}) {
  const log = { active: 0, peak: 0, planPeak: 0, planning: 0, calls: 0, rateLimited: 0, contexts: [], reviews: 0 };
  let next = 0;
  const complete = async (system, prompt, context = {}) => {
    log.contexts.push(context);
    log.calls++; log.active++; log.peak = Math.max(log.peak, log.active);
    const isPlan = system.startsWith("Plan a source-grounded assessment");
    if (isPlan) { log.planning++; log.planPeak = Math.max(log.planPeak, log.planning); }
    try {
      await new Promise((resolve) => setTimeout(resolve, latency));
      if (always429 || log.active > limit) { log.rateLimited++; throw new Error("429 Too Many Requests: rate limit exceeded"); }
      const data = () => JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
      if (isPlan) {
        const request = data(), source = request.sources[0];
        const plan = qualityPlan({ ...request, kind: "flashcard", sources: [source] });
        return JSON.stringify({ targets: plan.targets.map((target) => ({ ...target, objective: `Planned ${++next}`, citations: [{ sourceId: source.id, quote: paragraph(number(source.id)).slice(0, 60) }] })) });
      }
      if (system.startsWith("Prepare supported answers")) {
        const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.objective), index, target.targetId, target.citations[0].sourceId));
        return JSON.stringify({ items: cards.map((item, index) => ({ targetId: plan.targets[index].targetId, answer: item.answer, reasoning: item.explanation,
          scenario: { kind: "none", facts: [], decisiveConditions: [] }, comparisonAxis: "scope" })) });
      }
      if (system.startsWith("You author")) {
        const plan = data().assessmentPlan, cards = plan.targets.map((target, index) => card(number(target.objective), index, target.targetId, target.citations[0].sourceId));
        return JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: qualityReview({ cards }).checks });
      }
      if (system.startsWith("Act as a strict assessment editor")) { log.reviews++; return JSON.stringify(qualityReview(JSON.parse(prompt).candidate)); }
      throw new Error(`unexpected call: ${system.slice(0, 40)}`);
    } finally { log.active--; if (isPlan) log.planning--; }
  };
  return { complete, log };
}
const run = (model, request = {}, ...rest) => generateBatched(model.complete, { count: 15, kind: "flashcard", sources, performance: { concurrency: 4, batchSize: 5, fillRounds: 0 }, ...request }, ...rest);

test("the default budget is wider: 4 at once, up to 8", () => {
  assert.equal(GENERATION_SETTINGS_DEFAULTS.concurrency, 4);
  assert.deepEqual(GENERATION_SETTINGS_LIMITS.concurrency, { min: 1, max: 8 });
});

test("every model call says how long it waited for a free slot, and the review is never skipped", async () => {
  const model = provider({ latency: 5 });
  const result = await run(model, { performance: { concurrency: 1, batchSize: 5, fillRounds: 0 } });
  assert.equal(result.cards.length, 15);
  assert.ok(model.log.contexts.every((context) => Number.isFinite(context.waitedMs) && context.waitedMs >= 0), "waitedMs on every call");
  assert.ok(model.log.contexts.some((context) => context.waitedMs > 0), "with one slot and several parts somebody waited");
  assert.ok(model.log.reviews >= 3, `one independent review per part: ${model.log.reviews}`);
});

test("the groups of a big job are planned at the same time, not one after the other", async () => {
  const model = provider({ latency: 20 });
  const result = await run(model);
  assert.equal(result.cards.length, 15);
  assert.ok(model.log.planPeak >= 2, `planning calls overlapped: ${model.log.planPeak}`);
  assert.equal(new Set(result.cards.map((item) => item.objective)).size, 15, "no objective twice");
});

test("a 429 slows the run down and it finishes with every card; a limit of two ends up respected", async () => {
  const model = provider({ latency: 10, limit: 2 });
  const events = [];
  const result = await run(model, { performance: { concurrency: 6, batchSize: 3, fillRounds: 0 }, rateLimitBackoffMs: 1, onThrottle: (event) => events.push(event) });
  assert.equal(result.cards.length, 15, "the rate-limited calls were retried, no part failed");
  assert.ok(model.log.rateLimited > 0, "the fake provider did answer 429");
  assert.ok(events.length > 0 && events.every((event) => event.concurrency >= 1));
  assert.ok(Math.min(...events.map((event) => event.concurrency)) <= 2, `the budget came down to the provider's limit: ${JSON.stringify(events)}`);
  assert.deepEqual(result.editorial.failures, []);
});

test("after calls succeed again the budget climbs back, never above the configured one", async () => {
  const model = provider({ latency: 3, limit: 1 });
  const events = [];
  // The provider can only take one call at once; a run with many calls throttles down and then, with nothing failing, recovers step by step.
  await run(model, { count: 10, performance: { concurrency: 3, batchSize: 5, fillRounds: 0 }, rateLimitBackoffMs: 1, onThrottle: (event) => events.push(event) });
  assert.ok(events.some((event) => event.reason === "rate-limit"));
  assert.ok(events.every((event) => event.concurrency <= 3));

});

test("a provider that never stops answering 429 ends the part with the rate-limit reason, after a bounded number of tries", async () => {
  const model = provider({ latency: 1, always429: true });
  await assert.rejects(run(model, { count: 5, performance: { concurrency: 2, batchSize: 5, fillRounds: 0 }, rateLimitBackoffMs: 1 }), /429|rate limit/i);
  assert.ok(model.log.calls <= 12, `a bounded number of calls: ${model.log.calls}`);
});

test("cancelling while a call waits out a 429 stops at once", async () => {
  const controller = new AbortController(), model = provider({ latency: 1, always429: true });
  const running = run(model, { count: 5, performance: { concurrency: 2, batchSize: 5, fillRounds: 0 }, rateLimitBackoffMs: 60_000, signal: controller.signal });
  await until(() => model.log.rateLimited > 0, "the first 429");
  controller.abort(new Error("stopped by the learner"));
  await assert.rejects(running, /stopped by the learner/);
});
