import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { planPath } from "../lib/mastery.js";
import { courseKey } from "../lib/courses.js";
import { buildCompactScene } from "../lib/study-scene.js";
import { seedLibrary } from "../scripts/qa/perf-seed.mjs";
import { Probe, settledMemory } from "../scripts/qa/perf-probe.mjs";
import { fingerprintDiff } from "./helpers/fingerprint-diff.mjs";
import { assertCpuBudget, measureWallSamples } from "./helpers/perf-gate.mjs";

/* Performance budgets on a deterministic synthetic library (scripts/qa/perf-seed.mjs). They count work, not time:
   JSON parsed and written, structuredClone calls and characters copied, bytes sent, and heap growth after a collection.
   A budget is a ratio of the library's own size, so it holds for any seed size and cannot flake with machine load.
   docs/performance.md explains each number and how to measure a real library with scripts/qa/perf-baseline.mjs. */

async function directoryChars(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directoryChars(child) : (await stat(child)).size;
  }
  return total;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-perf-budget-"));
  const seeded = await seedLibrary(root, { sources: 160, decks: 14, cardsPerDeck: 30, runs: 24, attempts: 1200, courses: 8, largeSources: 4, largeSourceChars: 30000, ...options });
  const service = new StudyService(root);
  const probe = new Probe({ sizeClones: true }).install();
  t.after(async () => { probe.uninstall(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  const libraryChars = await directoryChars(join(root, "shards"));
  const sourceChars = (await service.store.read()).sources.reduce((sum, source) => sum + source.text.length, 0);
  // The panel's own path: a flashcard run on the biggest deck, then one question at a time.
  const snapshot = await service.call("snapshot");
  const deck = snapshot.decks.filter((item) => item.count).sort((a, b) => b.count - a.count)[0];
  let run = await service.call("review.start", { mode: "flashcard", deckId: deck.id, fresh: true });
  const next = async (kind) => {
    if (run.complete) run = await service.call("review.start", { mode: "flashcard", deckId: deck.id, fresh: true });
    const common ={ runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion };
    if (kind === "reveal") return (run = await service.call("review.reveal", common));
    if (kind === "answer") return (run = await service.call("review.answer", { ...common, grade: 4 }));
    return (run = await service.call("review.move", { runId: run.id, direction: 1 }));
  };
  return { root, service, probe, seeded, libraryChars, sourceChars, next, get run() { return run; } };
}

const ratio = (value, whole) => Math.round((value / whole) * 1000) / 1000;

test("a review click rewrites its own run, not the whole library (mutation budget)", async (t) => {
  const f = await fixture(t);
  await f.service.call("snapshot");
  const { counts } = await f.probe.measure(() => f.next("reveal"));
  const report = { parsed: ratio(counts.jsonParseChars, f.libraryChars), stringified: ratio(counts.jsonStringifyChars, f.libraryChars), cloned: ratio(counts.structuredCloneChars, f.libraryChars),
    shardWrites: counts.shardWrites, writtenChars: ratio(counts.shardWriteBytes, f.libraryChars) };
  t.diagnostic(`review.reveal: ${JSON.stringify(report)}`);
  assert.ok(report.parsed <= 0.05, `review.reveal parsed ${JSON.stringify(report)} of the library; budget 5%`);
  assert.ok(report.stringified <= 0.1, `review.reveal stringified ${JSON.stringify(report)} of the library; budget 10%`);
  assert.ok(report.cloned <= 0.05, `review.reveal cloned ${JSON.stringify(report)} of the library; budget 5%`);
  assert.ok(counts.shardWrites <= 2, `review.reveal wrote ${counts.shardWrites} shards; budget 2`);
});

test("the snapshot after a click does not parse or copy the library again (snapshot budget)", async (t) => {
  const f = await fixture(t);
  await f.service.call("snapshot");
  await f.next("reveal");
  const { value, counts } = await f.probe.measure(() => f.service.call("snapshot", { since: "stale" }));
  const payload = JSON.stringify(value).length;
  const report = { parsed: ratio(counts.jsonParseChars, f.libraryChars), cloned: ratio(counts.structuredCloneChars, f.libraryChars), payloadVsSourceText: ratio(payload, f.sourceChars) };
  t.diagnostic(`snapshot after a click: ${JSON.stringify(report)}`);
  assert.ok(report.parsed <= 0.1, `the snapshot after review.reveal parsed ${JSON.stringify(report)} of the library; budget 10% (only the shard the click wrote)`);
  assert.ok(report.cloned <= 0.35, `the snapshot copied ${JSON.stringify(report)} of the library with structuredClone; budget 35%`);
});

test("an unchanged poll costs a stat, not a rebuild (poll budget)", async (t) => {
  const f = await fixture(t);
  const first = await f.service.call("snapshot");
  await f.probe.measure(() => f.service.call("snapshot", { since: first.fingerprint }));
  const { value, counts } = await f.probe.measure(() => f.service.call("snapshot", { since: first.fingerprint }));
  assert.equal(value.unchanged, true, fingerprintDiff(first.fingerprint, value.fingerprint));
  t.diagnostic(`unchanged poll: ${JSON.stringify(counts)}`);
  assert.equal(counts.jsonParseChars, 0, "an unchanged poll must not parse anything");
  assert.ok(counts.structuredCloneCalls <= 8, `an unchanged poll made ${counts.structuredCloneCalls} structuredClone calls; budget 8`);
  assert.ok(counts.jsonStringifyChars <= f.libraryChars * 0.002, `an unchanged poll stringified ${counts.jsonStringifyChars} chars`);
});

test("the snapshot carries source metadata, not every source's text (payload budget)", async (t) => {
  const f = await fixture(t);
  // A case set's scenario is read straight from the snapshot by the case pages, so that one source keeps its text.
  const scenario = "src-0003";
  await f.service.store.update((state) => { state.decks[0].case = { sourceId: scenario, title: "Case" }; });
  const snapshot = await f.service.call("snapshot");
  const payload = JSON.stringify(snapshot).length;
  t.diagnostic(`snapshot payload ${payload} chars for ${f.sourceChars} chars of source text over ${snapshot.sources.length} sources`);
  // Budgets include `materialMastery` (about 280 chars per document that has questions: the reader's outline meters and the 资料 rows), added after the text was dropped.
  assert.ok(payload <= f.sourceChars * 0.5, `snapshot is ${payload} chars for ${f.sourceChars} chars of source text; budget 50%`);
  assert.ok(payload <= snapshot.sources.length * 1800, `snapshot is ${payload} chars for ${snapshot.sources.length} sources; budget 1800 per source`);
  for (const source of snapshot.sources) {
    assert.equal(typeof source.chars, "number", "each source reports its length as chars");
    assert.equal(typeof source.excerpt, "string", "and the first characters the sources page shows");
    assert.equal(Object.hasOwn(source, "text"), source.id === scenario, source.id === scenario ? "the scenario keeps its text" : "no other source ships its text");
  }
  const full = await f.service.call("source.get", { id: "src-0001", limit: 60000 });
  const stored = (await f.service.store.read()).sources.find((source) => source.id === "src-0001");
  assert.equal(full.text, stored.text.slice(0, 60000), "the text is one source.get away");
  assert.equal(full.chars, snapshot.sources.find((source) => source.id === "src-0001").chars, "the snapshot's chars is the real length");
});

test("building the snapshot again does not fingerprint every card or rebuild every outcome key (build budget)", async (t) => {
  const f = await fixture(t);
  await f.service.call("snapshot", { since: "warm" });
  await f.next("reveal");
  const { counts } = await f.probe.measure(() => f.service.call("snapshot", { since: "stale" }));
  const cards = f.seeded.cards;
  t.diagnostic(`snapshot build: ${counts.jsonStringifyCalls} JSON.stringify calls for ${cards} cards, ${f.seeded.attempts} attempts, ${f.seeded.sources} sources`);
  // Before: one canonical stringify per reviewed card (reviewedCardStatus) and a key per attempt, five times over (latestOutcomes): ~9 000 calls here.
  assert.ok(counts.jsonStringifyCalls <= cards * 1.5, `${counts.jsonStringifyCalls} JSON.stringify calls for ${cards} cards; budget ${cards * 1.5}`);
});

test("course names are normalised once each, however often they are asked for", () => {
  const normalize = String.prototype.normalize;
  let calls = 0;
  String.prototype.normalize = function (...args) { calls++; return normalize.apply(this, args); };
  try {
    for (let round = 0; round < 50; round++) for (let name = 0; name < 100; name++) courseKey(`Course ${name} /  Chapter`);
  } finally { String.prototype.normalize = normalize; }
  assert.ok(calls <= 100, `${calls} normalisations for 100 distinct names asked 50 times each`);
  for (let name = 0; name < 10000; name++) courseKey(`Name ${name}`);
  assert.equal(courseKey("  Name   5 "), "Name 5", "the memo is bounded and still right after it was dropped");
  assert.equal(courseKey(undefined), "");
});

test("opening a page does not copy the library to read it (read budget)", async (t) => {
  const f = await fixture(t);
  await f.service.call("snapshot");
  const run = f.run;
  const reads = [["map", {}], ["stats", {}], ["wrongbook", {}], ["graph", {}], ["inbox", {}], ["source.list", { limit: 100 }], ["source.get", { id: "src-0001" }],
    ["course.route", {}], ["review.get", { runId: run.id }], ["skeleton.list", {}], ["workflow.list", {}], ["study.scene.get", {}], ["study.session.list", {}]];
  const report = [];
  for (const [action, args] of reads) {
    await f.service.call(action, args).catch(() => null);
    const { value, counts } = await f.probe.measure(() => f.service.call(action, args));
    const response = JSON.stringify(value ?? null).length;
    report.push({ action, response, cloned: counts.structuredCloneChars });
    // The answer itself is copied once on its way out; reading the library to build it must not be.
    assert.ok(counts.structuredCloneChars <= response * 2 + f.libraryChars * 0.02,
      `${action} copied ${counts.structuredCloneChars} chars with structuredClone for a ${response}-char answer over a ${f.libraryChars}-char library`);
  }
  t.diagnostic(`page reads: ${report.map((row) => `${row.action} ${row.cloned}/${row.response}`).join(", ")}`);
});

function runWithSourceTextSpy(view, fn) {
  let sourceTextReads = 0;
  const instrumentedView = {
    ...view,
    sources: view.sources.map((src) => new Proxy(src, {
      get(target, prop, receiver) {
        if (prop === "text") sourceTextReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    })),
  };
  const result = fn(instrumentedView);
  return { result, sourceTextReads };
}

test("study.scene.get on a 1 000-source, 2 900-question library stays under 10 ms and reads nothing it need not (scene budget)", async (t) => {
  // #536 states this budget in time. A single call is at the mercy of a garbage collection or a busy runner, so the median of many calls
  // is held to the limit and the spread is only reported. The call as a whole is not timed against the limit: its first step, the
  // store's stat of the manifest, alone took 6-11 ms on a loaded Windows laptop and costs every read the same, scene or not. The scene's
  // own work (the projection of the host's frozen view) is timed; the whole call is held to counts, which do not depend on the machine.
  const f = await fixture(t, { sources: 1000, decks: 29, cardsPerDeck: 100, runs: 24, attempts: 1200 });
  const run = f.run;
  const session = await f.service.call("study.session.start", { courseId: "Course 01 / Chapter 1", goal: { title: "Scene budget" },
    scope: [{ kind: "deck", id: run.deckId }], focus: { kind: "card", id: run.card.id, runId: run.id, deckId: run.deckId } });
  const args = { sessionId: session.id };
  await f.service.call("study.scene.get", args);
  const { value, counts } = await f.probe.measure(() => f.service.call("study.scene.get", args));
  const bytes = JSON.stringify(value).length;
  assert.equal(value.focusObject?.cardId, run.card.id, "the scene is the run's current question, not an empty one");
  assert.ok(bytes <= 4096, `scene is ${bytes} bytes; budget 4096`);
  t.diagnostic(`study.scene.get: ${bytes} bytes, ${JSON.stringify({ parsed: counts.jsonParseChars, cloned: counts.structuredCloneChars, shardReads: counts.shardReads })}`);
  assert.equal(counts.jsonParseChars, 0, "a scene must not parse the library");
  assert.equal(counts.shardReads, 0, "a scene must not read shard files");
  assert.ok(counts.structuredCloneChars <= bytes * 2, `study.scene.get copied ${counts.structuredCloneChars} chars for a ${bytes}-byte scene; only the answer may be copied`);

  f.probe.uninstall(); // the probe doubles the cost of every clone: time the work as the host runs it
  const view = await f.service.store.read();
  // Batched CPU-time median (`process.cpuUsage`) with warmup eliminates OS preemption spikes that
  // inflated single-shot wall-clock `performance.now()` loops under parallel CI load while keeping
  // the strict < 10 ms budget unchanged (see docs/performance.md).
  const scene = assertCpuBudget(() => buildCompactScene(view, args), {
    maxMedianMs: 10,
    warmup: 20,
    samples: 7,
    batch: 25,
    label: `scene projection over ${f.seeded.sources} sources / ${f.seeded.cards} questions`,
  });
  t.diagnostic(`scene projection over ${f.seeded.sources} sources / ${f.seeded.cards} questions: median ${scene.median.toFixed(3)} ms CPU, p90 ${scene.p90.toFixed(3)} ms CPU, max ${scene.max.toFixed(3)} ms CPU (7x25 batched)`);
  // Deterministic work invariant: projecting a card scene must never scan all 1,000 sources' texts.
  const { result: guardedScene, sourceTextReads } = runWithSourceTextSpy(view, (v) => buildCompactScene(v, args));
  assert.equal(guardedScene.focusObject?.cardId, run.card.id);
  assert.equal(sourceTextReads, 0, `scene projection touched source.text ${sourceTextReads} times; must stay O(1) w.r.t. source texts`);
  const times = [];
  for (let i = 0; i < 31; i++) { const started = performance.now(); await f.service.call("study.scene.get", args); times.push(performance.now() - started); }
  times.sort((a, b) => a - b);
  t.diagnostic(`whole study.scene.get call (not asserted: it includes the store's stat of the manifest): median ${times[15].toFixed(3)} ms, max ${times[30].toFixed(3)} ms (31 calls)`);
});

test("scene budget flake-repro: wall-clock jitter flakes legacy gate, CPU-time + Proxy gates stay green and catch real source-scan regressions", async (t) => {
  const f = await fixture(t, { sources: 160, decks: 6, cardsPerDeck: 25, runs: 2, attempts: 120, courses: 2, largeSources: 4, largeSourceChars: 30000 });
  const run = f.run;
  const session = await f.service.call("study.session.start", {
    courseId: "Course 01 / Chapter 1",
    goal: { title: "Scene flake repro" },
    scope: [{ kind: "deck", id: run.deckId }],
    focus: { kind: "card", id: run.card.id, runId: run.id, deckId: run.deckId },
  });
  const args = { sessionId: session.id };
  f.probe.uninstall();
  const view = await f.service.store.read();

  // (a) Legacy wall-clock gate flakes when real performance.now() experiences +12 ms OS preemption stalls
  // on >50% of calls while executing the real buildCompactScene projection.
  let stallOffsetMs = 0;
  let sampleIdx = 0;
  let inCall = false;
  const preemptedWallNow = () => {
    const realMs = performance.now();
    if (!inCall) {
      inCall = true;
      return realMs + stallOffsetMs;
    }
    inCall = false;
    sampleIdx += 1;
    if (sampleIdx % 5 < 3) stallOffsetMs += 12;
    return realMs + stallOffsetMs;
  };
  const legacyWall = measureWallSamples(() => buildCompactScene(view, args), {
    warmup: 5,
    samples: 21,
    now: preemptedWallNow,
  });
  assert.throws(
    () => assert.ok(legacyWall.median < 10, `median ${legacyWall.median.toFixed(3)} ms exceeded 10 ms`),
    /exceeded 10 ms/,
    "legacy wall-clock gate must fail under OS preemption stalls",
  );

  // (b) Hardened CPU-time batched gate + Proxy source.text invariant stay green on the real buildCompactScene.
  const realStats = assertCpuBudget(() => buildCompactScene(view, args), {
    maxMedianMs: 10,
    warmup: 10,
    samples: 7,
    batch: 20,
    label: "hardened scene CPU gate",
  });
  assert.ok(realStats.median < 10);
  const cleanCheck = runWithSourceTextSpy(view, (v) => buildCompactScene(v, args));
  assert.equal(cleanCheck.result.focusObject?.cardId, run.card.id);
  assert.equal(cleanCheck.sourceTextReads, 0);

  // (c) Genuine regression sensitivity (no busy-loop): a regressed scene builder that scans and clones/serializes
  // every source's `text` (like a full-library read regression) is caught by BOTH the Proxy invariant and the CPU gate.
  const regressedBuildScene = (targetView) => {
    let serializedChars = 0;
    for (let pass = 0; pass < 8; pass += 1) {
      for (let i = 0; i < targetView.sources.length; i += 1) {
        serializedChars += JSON.stringify(targetView.sources[i].text).length;
      }
    }
    const scene = buildCompactScene(targetView, args);
    return serializedChars >= 0 ? scene : null;
  };
  const regressedSpy = runWithSourceTextSpy(view, regressedBuildScene);
  assert.ok(
    regressedSpy.sourceTextReads >= view.sources.length,
    `Proxy invariant must detect source.text scans (saw ${regressedSpy.sourceTextReads} reads)`,
  );
  const calibratedBudgetMs = Math.min(10, Math.max(realStats.median * 10, 0.5));
  assert.throws(
    () => assertCpuBudget(() => regressedBuildScene(view), {
      maxMedianMs: calibratedBudgetMs,
      referenceFn: () => buildCompactScene(view, args),
      maxRatio: 20,
      warmup: 1,
      samples: 3,
      batch: 1,
      label: "regressed full-source-scan scene projection",
    }),
    /exceeded budget </,
    "hardened CPU-time gate must fail on real full-source serialization regression",
  );
});

test("a write that copies a whole collection reads no shard files back (write budget)", async (t) => {
  const f = await fixture(t);
  await f.service.call("snapshot");
  const deck = (await f.service.call("snapshot", { since: "x" })).decks[0];
  const card = (await f.service.call("deck.get", { deckId: deck.id, id: deck.id })).cards[0];
  const report = {};
  for (const [label, action, args] of [["card.flag (copies every deck)", "card.flag", { deckId: deck.id, cardId: card.id, reason: "perf" }],
    ["source.add (copies every source)", "source.add", { title: "added", text: "added ".repeat(50), courses: [] }],
    ["review.answer (copies decks and attempts)", null, null]]) {
    if (!action) await f.next("reveal");
    const { counts } = await f.probe.measure(() => action ? f.service.call(action, args) : f.next("answer"));
    report[label] = { shardReads: counts.shardReads, parsedChars: ratio(counts.jsonParseChars, f.libraryChars) };
    // A private copy of a shard the cache holds parsed is a copy of that value; the file (hundreds of them, blocking sync reads) is not read.
    assert.equal(counts.shardReads, 0, `${label} read ${counts.shardReads} shard files back`);
  }
  t.diagnostic(`write copies: ${JSON.stringify(report)}`);
});

test("heavy dependencies are imported when used, not when the host starts (cold-start budget)", async () => {
  // yaml (a legacy import), pdf-lib and pdfjs-dist (PDF import and chunking) cost ~100-560 ms each to load: a static import anywhere
  // in lib/ would put that on every host start. The client bundle files (lib/client.*.js) are build output, not sources.
  const heavy = ["yaml", "pdf-lib", "pdfjs-dist"];
  const offenders = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".js") && !/^client\./.test(entry.name)) {
        const text = await readFile(path, "utf8");
        for (const name of heavy)
          if (new RegExp(String.raw`^\s*(?:import|export)\b[^\n;]*\bfrom\s*['"]${name}(?:/[^'"]*)?['"]`, "m").test(text) ||
              new RegExp(String.raw`^\s*import\s*['"]${name}['"]`, "m").test(text)) offenders.push(`${path}: ${name}`);
      }
    }
  };
  await walk("lib");
  assert.deepEqual(offenders, [], "import() these where they are used");
});

test("polling and clicking for a long time does not grow the heap (memory budget)", async (t) => {
  const f = await fixture(t);
  let fingerprint = (await f.service.call("snapshot")).fingerprint;
  const cycle = async (round) => {
    await f.next(["reveal", "answer", "move"][round % 3]);
    const polled = await f.service.call("snapshot", { since: fingerprint });
    if (!polled.unchanged) fingerprint = polled.fingerprint;
    for (let i = 0; i < 3; i++) await f.service.call("snapshot", { since: fingerprint });
  };
  for (let round = 0; round < 30; round++) await cycle(round);
  const before = settledMemory().heapUsed;
  for (let round = 30; round < 330; round++) await cycle(round);
  const grown = settledMemory().heapUsed - before;
  assert.ok(grown <= 12, `heap grew ${grown.toFixed(1)} MB over 300 click+poll cycles; budget 12 MB`);
});

test("planning a daily round over 3 000 overdue cards calls retrievabilityAt once per card (#881 budget)", () => {
  const now = Date.parse("2026-10-08T08:00:00Z");
  const count = 3000;
  const decks = Array.from({ length: 10 }, (_, d) => ({
    id: `backlog-${d}`,
    title: `Backlog ${d}`,
    cards: Array.from({ length: count / 10 }, (_, i) => {
      const idx = d * (count / 10) + i;
      return {
        id: `c-${idx}`,
        kind: "quiz",
        topic: "T",
        prompt: `Q${idx}?`,
        answer: "a",
        options: [{ id: "y", text: "Yes", correct: true }],
        review: {
          algorithm: "fsrs-6",
          repetitions: 3,
          interval_days: 4,
          ease_factor: 2.5,
          stability: 2 + (idx % 20),
          difficulty: 5,
          last_review: `2026-09-${String(1 + (idx % 28)).padStart(2, "0")}T08:00:00Z`,
          due_at: `2026-10-0${1 + (idx % 7)}T08:00:00Z`,
        },
      };
    }),
  }));
  let powCalls = 0;
  const originalPow = Math.pow;
  Math.pow = (...args) => { powCalls++; return originalPow(...args); };
  let plan;
  try {
    plan = planPath(decks, () => 4, { now, limit: 20 });
  } finally {
    Math.pow = originalPow;
  }
  assert.equal(plan.entries.length, 20);
  assert.equal(plan.counts.due, count);
  assert.ok(powCalls >= count, `expected retrievability pass to evaluate ${count} cards, got ${powCalls}`);
  assert.ok(powCalls <= count * 1.5, `expected <= ${count * 1.5} Math.pow calls, got ${powCalls}`);
});
