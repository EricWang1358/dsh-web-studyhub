/* Fast (<2s) NFR performance & boot-transition regression gates that ALWAYS run inside `npm run test:fast`
   (never skipped by `tests/slow-tests.json`). Pins:
   1. FSRS-6 `retrievabilityAt` hoists `computeDecayFactor` out of the per-card loop (<= 1.5x Math.pow calls per card).
   2. `createLocator` reuses cached normalized index + approx results across repeated snapshot rebuilds on unchanged source text.
   3. `useAppStore` stages slice updates synchronously so newly mounted subtrees never read stale `data: null` on boot. */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { planPath } from "../lib/mastery.js";
import { createLocator } from "../lib/quote-locate.js";
import { AppStoreContext, createAppStore, useAppStore, useAppSelector } from "../ui/app/store.js";

test("NFR fast gate: planning 3 000 overdue cards calls Math.pow once per card (hoisted computeDecayFactor)", () => {
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
  assert.ok(powCalls <= count * 1.1, `expected <= ${count * 1.1} Math.pow calls (hoisted decay factor), got ${powCalls}`);
});

test("NFR fast gate: createLocator reuses cached index and approx results across repeated snapshot rebuilds", () => {
  const filler = Array.from({ length: 120 }, (_, i) => `Section ${i + 1}: lecture filler paragraph number ${i + 1} covering topic index alpha-${i}.`);
  filler[60] = "Section 61: distributed consensus requires quorum intersection across every replica epoch.";
  const body = filler.join("\n");
  const nearMiss = "distributed consensus requres quorum intersection across evry replica epoch";
  const absent = "completely unrelated quantum chromodynamics vacuum expectation value";

  // Warm the bounded LRU index + approx cache on first snapshot build.
  const first = createLocator(body);
  const hit1 = first(nearMiss);
  assert.ok(hit1 && hit1.end > hit1.start, "near-miss quote should resolve on cold locator");
  assert.equal(first(absent), null);

  // Warm JIT on the cached lookup path before timing.
  {
    const loc = createLocator(body);
    assert.deepEqual(loc(nearMiss), hit1);
    assert.equal(loc(absent), null);
  }

  // Subsequent 50 snapshot rebuilds calling createLocator(sameText) must stay ultra-fast (< 100 ms CPU, best of 3 rounds).
  const cpuSamples = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const cpuBefore = process.cpuUsage();
    for (let round = 0; round < 50; round += 1) {
      const loc = createLocator(body);
      const hit = loc(nearMiss);
      assert.deepEqual(hit, hit1);
      assert.equal(loc(absent), null);
    }
    const cpuUsed = process.cpuUsage(cpuBefore);
    cpuSamples.push((cpuUsed.user + cpuUsed.system) / 1000);
  }
  const bestCpuMs = Math.min(...cpuSamples);
  assert.ok(bestCpuMs < 100, `50 repeated locator rebuilds + approx lookups took best ${bestCpuMs.toFixed(1)} ms CPU (samples: ${cpuSamples.map((v) => v.toFixed(1)).join(", ")}); expected < 100 ms CPU with cache`);
});

test("NFR fast gate: useAppStore stages updated slices synchronously before child mount (no stale null data)", () => {
  // Verify two-phase boot transition: null -> loaded is visible immediately via stageSlices before flushPending runs,
  // and listeners are notified only on flushPending (never mid-render).
  const store = createAppStore({ data: null });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  assert.equal(store.getState().data, null);
  assert.equal(store.stageSlices({ data: { sample: { loaded: true } } }), true);
  assert.equal(store.getState().data?.sample?.loaded, true);
  assert.equal(notifications, 0, "staging during parent render must not notify subscribers mid-render");
  assert.equal(store.flushPending(), true);
  assert.equal(notifications, 1, "flushPending in useLayoutEffect notifies existing subscribers once");
  assert.equal(store.flushPending(), false);

  let seen = null;
  function Child() {
    seen = useAppSelector((s) => s.data?.sample?.loaded ?? null);
    return React.createElement("div", null, String(seen));
  }
  function Shell({ data }) {
    const appStore = useAppStore({ data });
    return React.createElement(AppStoreContext.Provider, { value: appStore }, data ? React.createElement(Child) : null);
  }
  const html = renderToStaticMarkup(React.createElement(Shell, { data: { sample: { loaded: true } } }));
  assert.equal(seen, true);
  assert.match(html, /true/);
});
