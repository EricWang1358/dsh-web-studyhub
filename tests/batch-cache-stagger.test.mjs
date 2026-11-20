import test from "node:test";
import assert from "node:assert/strict";
import { generateBatched, CACHE_WARMUP_MIN_CHARS } from "../lib/batch.js";
import { qualityPlan, qualityReview } from "./helpers/assessment.mjs";
import { until, sleep } from "./helpers/wait.mjs";
import { requestData } from "./helpers/request-data.mjs";

/* P2: Cold-cache warm-up stagger for sibling parts sharing identical cache-eligible `sources`.
   - Identical large `sources` (>= CACHE_WARMUP_MIN_CHARS): only the leader runs its 1st model call
     first; waiting siblings launch immediately once that 1st call finishes (not waiting for the
     leader's entire multi-stage part).
   - Disjoint `sources` and small `sources` (< CACHE_WARMUP_MIN_CHARS): zero delay, full parallelism.
   - Leader failure, abort, concurrency=1, and fill rounds: clean `finally` release, zero deadlock. */

const makeLargeText = (label, repeat = 70) =>
  `Section ${label}. Architecture includes the principles guiding a system's design and evolution for topic ${label}. `.repeat(repeat);

const makeSmallText = (label) =>
  `Section ${label}. Architecture includes the principles guiding a system's design and evolution for topic ${label}. `.repeat(2);

const numberOf = (text) => Number(String(text).replace(/\D+/g, "")) || 1;

const cardFor = (n, index, targetId, sourceId, quote) => ({
  id: `q${index + 1}`,
  targetId,
  kind: "flashcard",
  topic: `Architecture scope ${n}`,
  objective: `Planned ${n}`,
  prompt: `What does section ${n} say about architecture principle ${n}?`,
  answer: `Principles guide later choices ${n}.`,
  hint: "Think about change over time.",
  explanation: `The passage ties principle ${n} to design and evolution.`,
  misconception: "Architecture only describes components.",
  citations: [{ sourceId, quote }],
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Scripted provider for `generateBatched` that lets tests observe stage ordering,
 * gate specific calls, or inject per-part failures.
 */
function scriptedProvider({ assignSource, onCall } = {}) {
  const events = [];
  let nextObjective = 0;
  let activeBlueprints = 0;
  let peakBlueprints = 0;
  const blueprintStarts = [];

  const complete = async (system, prompt, context = {}) => {
    const part = context.part ?? null;
    const isPlan = system.startsWith("Plan a source-grounded assessment");
    const isBlueprint = system.startsWith("Prepare supported answers");
    const isAuthor = system.startsWith("You author");
    const isReview = system.startsWith("Act as a strict assessment editor");
    const stageKind = isPlan ? "plan" : isBlueprint ? "blueprint" : isAuthor ? "author" : isReview ? "review" : "other";

    events.push({ type: "start", stageKind, part, attempt: context.attempt ?? 1 });
    if (isBlueprint) {
      blueprintStarts.push(part);
      activeBlueprints++;
      peakBlueprints = Math.max(peakBlueprints, activeBlueprints);
    }

    try {
      if (onCall) await onCall({ stageKind, part, attempt: context.attempt ?? 1, system, prompt, context });

      const data = () => requestData(prompt);
      if (isPlan) {
        const req = data();
        const plan = qualityPlan({ ...req, kind: "flashcard", sources: [req.sources[0]] });
        return JSON.stringify({
          targets: plan.targets.map((target, idx) => {
            const chosen = assignSource ? assignSource(req.sources, idx) : req.sources[0];
            return {
              ...target,
              objective: `Planned ${++nextObjective}`,
              citations: [{ sourceId: chosen.id, quote: chosen.text.slice(0, 60) }],
            };
          }),
        });
      }
      if (isBlueprint) {
        const plan = data().assessmentPlan;
        const cards = plan.targets.map((target, idx) =>
          cardFor(numberOf(target.objective), idx, target.targetId, target.citations[0].sourceId, target.citations[0].quote));
        return JSON.stringify({
          items: cards.map((item, idx) => ({
            targetId: plan.targets[idx].targetId,
            answer: item.answer,
            reasoning: item.explanation,
            scenario: { kind: "none", facts: [], decisiveConditions: [] },
            comparisonAxis: "scope",
          })),
        });
      }
      if (isAuthor) {
        const plan = data().assessmentPlan;
        const cards = plan.targets.map((target, idx) =>
          cardFor(numberOf(target.objective), idx, target.targetId, target.citations[0].sourceId, target.citations[0].quote));
        return JSON.stringify({ deck: { title: "D", cards }, changes: [], checks: qualityReview({ cards }).checks });
      }
      if (isReview) {
        return JSON.stringify(qualityReview(data().candidate));
      }
      throw new Error(`unexpected call: ${system.slice(0, 40)}`);
    } finally {
      if (isBlueprint) activeBlueprints--;
      events.push({ type: "end", stageKind, part, attempt: context.attempt ?? 1 });
    }
  };

  return {
    complete,
    events,
    blueprintStarts,
    get peakBlueprints() { return peakBlueprints; },
  };
}

test("identical cache-eligible sources: siblings wait for leader's 1st call, then launch before leader finishes part", async () => {
  const largeSource = { id: "doc1", title: "Long Chapter", text: makeLargeText(1) };
  assert.ok(JSON.stringify([largeSource]).length >= CACHE_WARMUP_MIN_CHARS);

  const leaderBlueprintGate = deferred();
  const leaderAuthorGate = deferred();

  const model = scriptedProvider({
    onCall: async ({ stageKind, part }) => {
      if (stageKind === "blueprint" && part === 1) await leaderBlueprintGate.promise;
      if (stageKind === "author" && part === 1) await leaderAuthorGate.promise;
    },
  });

  const running = generateBatched(model.complete, {
    count: 15,
    kind: "flashcard",
    sources: [largeSource],
    performance: { concurrency: 4, batchSize: 5, fillRounds: 0 },
  });

  // Leader (part 1) enters Stage 2 blueprint immediately.
  await until(() => model.blueprintStarts.includes(1), "leader starts blueprint");
  await sleep(30);
  // While leader's 1st call is still in-flight, siblings 2 and 3 must NOT have started.
  assert.deepEqual(model.blueprintStarts, [1], "siblings wait while leader warms identical sources");

  // Release ONLY leader's 1st call (blueprint), while holding leader's Stage 3 (author).
  leaderBlueprintGate.resolve();

  // Siblings 2 and 3 must launch immediately without waiting for leader's author/review stages.
  await until(
    () => model.blueprintStarts.includes(2) && model.blueprintStarts.includes(3),
    "siblings launch right after leader's 1st call settles",
  );
  assert.ok(
    model.events.some((e) => e.type === "start" && e.stageKind === "author" && e.part === 1),
    "leader advanced into author stage",
  );
  assert.ok(
    !model.events.some((e) => e.type === "end" && e.stageKind === "author" && e.part === 1),
    "siblings launched before leader finished its author stage",
  );

  leaderAuthorGate.resolve();
  const result = await running;
  assert.equal(result.cards.length, 15);
  assert.deepEqual(result.editorial.failures, []);

  // Verify exact causal ordering: leader's blueprint ended strictly before any sibling's blueprint started.
  const leaderBpEnd = model.events.findIndex((e) => e.type === "end" && e.stageKind === "blueprint" && e.part === 1);
  const part2BpStart = model.events.findIndex((e) => e.type === "start" && e.stageKind === "blueprint" && e.part === 2);
  const part3BpStart = model.events.findIndex((e) => e.type === "start" && e.stageKind === "blueprint" && e.part === 3);
  assert.ok(leaderBpEnd >= 0 && part2BpStart > leaderBpEnd && part3BpStart > leaderBpEnd);
});

test("disjoint cache-eligible sources launch immediately in parallel with zero stagger", async () => {
  const sources = [
    { id: "p1", title: "Page 1", text: makeLargeText(1) },
    { id: "p2", title: "Page 2", text: makeLargeText(2) },
    { id: "p3", title: "Page 3", text: makeLargeText(3) },
  ];
  for (const s of sources) assert.ok(JSON.stringify([s]).length >= CACHE_WARMUP_MIN_CHARS);

  const releaseAll = deferred();
  const model = scriptedProvider({
    // Part 1 (targets 0..4) -> p1, Part 2 (targets 5..9) -> p2, Part 3 (targets 10..14) -> p3.
    assignSource: (groupSources, idx) => groupSources[Math.min(Math.floor(idx / 5), groupSources.length - 1)],
    onCall: async ({ stageKind }) => {
      if (stageKind === "blueprint") await releaseAll.promise;
    },
  });

  const running = generateBatched(model.complete, {
    count: 15,
    kind: "flashcard",
    sources,
    performance: { concurrency: 4, batchSize: 5, fillRounds: 0 },
  });

  // All 3 disjoint parts must enter blueprint simultaneously without waiting for each other.
  await until(() => model.blueprintStarts.length === 3, "all 3 disjoint parts start blueprint in parallel");
  assert.equal(model.peakBlueprints, 3);

  releaseAll.resolve();
  const result = await running;
  assert.equal(result.cards.length, 15);
  assert.deepEqual(result.editorial.failures, []);
});

test("waiting identical-source sibling does not starve a disjoint part from using a free concurrency slot", async () => {
  const sources = [
    { id: "pA", title: "Page A", text: makeLargeText(1) },
    { id: "pB", title: "Page B", text: makeLargeText(2) },
  ];

  const part1Gate = deferred();
  const part3Gate = deferred();

  const model = scriptedProvider({
    // Part 1 (0..4) -> pA, Part 2 (5..9) -> pA (shared!), Part 3 (10..14) -> pB (disjoint!).
    assignSource: (groupSources, idx) => (idx < 10 ? groupSources[0] : groupSources[1]),
    onCall: async ({ stageKind, part }) => {
      if (stageKind === "blueprint" && part === 1) await part1Gate.promise;
      if (stageKind === "blueprint" && part === 3) await part3Gate.promise;
    },
  });

  // concurrency = 2: Part 1 takes slot 1 (warming pA); Part 2 (also pA) must NOT hog slot 2,
  // allowing Part 3 (disjoint pB) to take slot 2 immediately!
  const running = generateBatched(model.complete, {
    count: 15,
    kind: "flashcard",
    sources,
    performance: { concurrency: 2, batchSize: 5, fillRounds: 0 },
  });

  await until(
    () => model.blueprintStarts.includes(1) && model.blueprintStarts.includes(3),
    "disjoint part 3 runs in parallel with leader part 1 under concurrency=2",
  );
  await sleep(30);
  assert.ok(!model.blueprintStarts.includes(2), "shared-source part 2 still waits while part 1 warms pA");

  part1Gate.resolve();
  part3Gate.resolve();
  const result = await running;
  assert.equal(result.cards.length, 15);
  assert.deepEqual(result.editorial.failures, []);
});

test("small identical sources below CACHE_WARMUP_MIN_CHARS do not stagger", async () => {
  const smallSource = { id: "tiny", title: "Short Note", text: makeSmallText(1) };
  assert.ok(JSON.stringify([smallSource]).length < CACHE_WARMUP_MIN_CHARS);

  const releaseAll = deferred();
  const model = scriptedProvider({
    onCall: async ({ stageKind }) => {
      if (stageKind === "blueprint") await releaseAll.promise;
    },
  });

  const running = generateBatched(model.complete, {
    count: 15,
    kind: "flashcard",
    sources: [smallSource],
    performance: { concurrency: 4, batchSize: 5, fillRounds: 0 },
  });

  await until(() => model.blueprintStarts.length === 3, "small-source siblings launch in parallel");
  assert.equal(model.peakBlueprints, 3);

  releaseAll.resolve();
  const result = await running;
  assert.equal(result.cards.length, 15);
});

test("leader failure releases warmup via finally with zero deadlock and lets next sibling warm cache", async () => {
  const largeSource = { id: "doc-fail", title: "Long Chapter", text: makeLargeText(1) };
  const part2BpGate = deferred();

  const model = scriptedProvider({
    onCall: async ({ stageKind, part }) => {
      if (stageKind === "blueprint" && part === 1) throw new Error("upstream 500 during warmup");
      if (stageKind === "blueprint" && part === 2) await part2BpGate.promise;
    },
  });

  const running = generateBatched(model.complete, {
    count: 15,
    kind: "flashcard",
    sources: [largeSource],
    performance: { concurrency: 4, batchSize: 5, fillRounds: 0 },
  });

  // Part 1 failed before warming cache, so Part 2 takes over as leader while Part 3 waits for Part 2's 1st call.
  await until(() => model.blueprintStarts.includes(2), "part 2 unblocks after part 1 fails");
  await sleep(30);
  assert.ok(!model.blueprintStarts.includes(3), "part 3 waits for new leader part 2 to warm cache");

  part2BpGate.resolve();
  const result = await running;
  assert.equal(result.cards.length, 10, "parts 2 and 3 both completed cleanly");
  assert.equal(result.editorial.failures.length, 1);
  assert.match(result.editorial.failures[0], /upstream 500 during warmup/);
});

test("abort during leader warmup cleans up with zero deadlock and never launches waiting siblings", async () => {
  const largeSource = { id: "doc-abort", title: "Long Chapter", text: makeLargeText(1) };
  const controller = new AbortController();

  const model = scriptedProvider({
    onCall: async ({ stageKind, part }) => {
      if (stageKind === "blueprint" && part === 1) {
        await new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        });
      }
    },
  });

  const running = generateBatched(model.complete, {
    count: 15,
    kind: "flashcard",
    sources: [largeSource],
    performance: { concurrency: 4, batchSize: 5, fillRounds: 0 },
    signal: controller.signal,
  });

  await until(() => model.blueprintStarts.includes(1), "leader starts blueprint");
  await sleep(20);
  controller.abort(new Error("stopped by learner"));

  await assert.rejects(running, /stopped by learner/);
  assert.deepEqual(model.blueprintStarts, [1], "waiting siblings never launched after abort");
});

test("concurrency=1 and fillRounds retries work cleanly with warmup gate", async () => {
  const largeSource = { id: "doc-retry", title: "Long Chapter", text: makeLargeText(1) };
  let failedOnce = false;

  const model = scriptedProvider({
    onCall: async ({ stageKind, part, attempt }) => {
      if (stageKind === "author" && part === 2 && attempt === 1 && !failedOnce) {
        failedOnce = true;
        throw new Error("transient author error");
      }
    },
  });

  const result = await generateBatched(model.complete, {
    count: 10,
    kind: "flashcard",
    sources: [largeSource],
    performance: { concurrency: 1, batchSize: 5, fillRounds: 1 },
  });

  assert.equal(result.cards.length, 10);
  assert.deepEqual(result.editorial.failures, []);
  assert.ok(failedOnce, "fill round retried part 2 on already-warm source key");
});

test("rate-limit 429 during leader warmup keeps siblings held until leader's retry succeeds", async () => {
  const largeSource = { id: "doc-429", title: "Long Chapter", text: makeLargeText(1) };
  let firstBlueprint429 = false;
  const retryGate = deferred();

  const model = scriptedProvider({
    onCall: async ({ stageKind, part }) => {
      if (stageKind === "blueprint" && part === 1) {
        if (!firstBlueprint429) {
          firstBlueprint429 = true;
          throw new Error("429 Too Many Requests: rate limit exceeded");
        }
        await retryGate.promise;
      }
    },
  });

  const running = generateBatched(model.complete, {
    count: 15,
    kind: "flashcard",
    sources: [largeSource],
    performance: { concurrency: 4, batchSize: 5, fillRounds: 0 },
    rateLimitBackoffMs: 5,
  });

  // Leader gets 429 on first attempt, backs off, and enters its retry attempt while siblings stay waiting.
  await until(() => model.blueprintStarts.filter((p) => p === 1).length === 2, "leader retries blueprint after 429");
  await sleep(30);
  assert.deepEqual(model.blueprintStarts, [1, 1], "siblings do not stampede during leader's 429 backoff/retry");

  retryGate.resolve();
  const result = await running;
  assert.equal(result.cards.length, 15);
  assert.deepEqual(result.editorial.failures, []);
});

test("preplanned reuse parts sharing identical cache-eligible sources also stagger", async () => {
  const largeSource = { id: "doc-reuse", title: "Long Chapter", text: makeLargeText(1) };
  const quote = largeSource.text.slice(0, 60);
  const mkTargets = (offset) => Array.from({ length: 3 }, (_, i) => ({
    targetId: `target-${i + 1}`,
    objective: `Planned ${offset + i + 1}`,
    knowledge: `Rule ${offset + i + 1}`,
    citations: [{ sourceId: largeSource.id, quote }],
  }));

  const leaderBpGate = deferred();
  const model = scriptedProvider({
    onCall: async ({ stageKind, part }) => {
      if (stageKind === "blueprint" && part === 1) await leaderBpGate.promise;
    },
  });

  const running = generateBatched(model.complete, {
    count: 0,
    kind: "flashcard",
    sources: [largeSource],
    reuse: [
      { sources: [largeSource], targets: mkTargets(0) },
      { sources: [largeSource], targets: mkTargets(3) },
    ],
    performance: { concurrency: 4, batchSize: 5, fillRounds: 0 },
  });

  await until(() => model.blueprintStarts.includes(1), "preplanned leader starts");
  await sleep(30);
  assert.deepEqual(model.blueprintStarts, [1], "preplanned sibling waits for leader's 1st call");

  leaderBpGate.resolve();
  const result = await running;
  assert.equal(result.cards.length, 6);
  assert.deepEqual(result.editorial.failures, []);
});
