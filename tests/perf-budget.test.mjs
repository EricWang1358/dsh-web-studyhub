import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { seedLibrary } from "../scripts/qa/perf-seed.mjs";
import { Probe, settledMemory } from "../scripts/qa/perf-probe.mjs";

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

test("an unchanged poll costs a stat, not a rebuild (poll budget)", async (t) => {
  const f = await fixture(t);
  const first = await f.service.call("snapshot");
  await f.probe.measure(() => f.service.call("snapshot", { since: first.fingerprint }));
  const { value, counts } = await f.probe.measure(() => f.service.call("snapshot", { since: first.fingerprint }));
  assert.equal(value.unchanged, true);
  assert.equal(counts.jsonParseChars, 0, "an unchanged poll must not parse anything");
  assert.ok(counts.structuredCloneCalls <= 8, `an unchanged poll made ${counts.structuredCloneCalls} structuredClone calls; budget 8`);
  assert.ok(counts.jsonStringifyChars <= f.libraryChars * 0.002, `an unchanged poll stringified ${counts.jsonStringifyChars} chars`);
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
