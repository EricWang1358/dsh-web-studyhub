import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CARD_SEC,
  DEFAULT_REWORK_FACTOR,
  ELAPSED_CAP_MS,
  MAX_REWORK_FACTOR,
  MIN_REWORK_FACTOR,
  TARGET_SPACED_REPS,
  cardSpacedReps,
  extractLearnerPace,
  forecastScope,
  libraryPaceForecast,
  spacingProfile,
} from "../lib/pace/forecast.js";
import { StudyService } from "../lib/service.js";
import { schedule } from "../lib/sm2.js";
import { seedLibrary } from "../scripts/qa/perf-seed.mjs";
import { assertCpuBudget, measureWallSamples } from "./helpers/perf-gate.mjs";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const DAY_MS = 864e5;

function isoDaysAgo(daysAgo, hour = 10) {
  const d = new Date(NOW - daysAgo * DAY_MS);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function makeCard(id, overrides = {}) {
  return {
    id,
    kind: "quiz",
    topic: "Algorithms",
    prompt: `Question ${id}`,
    answer: "A",
    review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
    ...overrides,
  };
}

test("extractLearnerPace handles cold-start gracefully with sensible defaults", () => {
  const pace = extractLearnerPace([], { now: NOW });
  assert.equal(pace.coldStart, true);
  assert.equal(pace.lowSample, true);
  assert.equal(pace.dailyAttempts, 0);
  assert.equal(pace.medianCardSec, DEFAULT_CARD_SEC);
  assert.equal(pace.cardSecSource, "default");
  assert.equal(pace.reworkFactor, DEFAULT_REWORK_FACTOR);
  assert.equal(pace.passRate14d, null);
  assert.equal(pace.cardsPerPomodoro, 30);
});

test("extractLearnerPace filters voided/implicit attempts, caps elapsed_ms at 3 min, and clamps rework factor", () => {
  const attempts = [];
  // Older attempt > 7d ago so learner is established (spanDays7d = 7)
  attempts.push({ timestamp: isoDaysAgo(12), grade: 4, elapsed_ms: 40_000 });
  // 70 active direct attempts over last 7 days (10/day), with 2 AFK outliers (10 min each) and 60s typical time
  for (let day = 0; day < 7; day++) {
    for (let i = 0; i < 10; i++) {
      attempts.push({
        timestamp: isoDaysAgo(day, 9 + (i % 6)),
        grade: i === 0 ? 1 : 4, // 90% pass rate -> rework ~1.11
        elapsed_ms: day === 0 && i < 2 ? 600_000 : 60_000,
      });
    }
  }
  // Ignored attempts: voided and implicit
  attempts.push({ timestamp: isoDaysAgo(0), grade: 1, elapsed_ms: 1000, voidedAt: isoDaysAgo(0) });
  attempts.push({ timestamp: isoDaysAgo(0), grade: 4, elapsed_ms: 1000, implicit: true });

  const pace = extractLearnerPace(attempts, { now: NOW, focusMinutes: 25 });
  assert.equal(pace.coldStart, false);
  assert.equal(pace.lowSample, false);
  assert.equal(pace.attempts7d, 70);
  assert.equal(pace.activeDays7d, 7);
  assert.equal(pace.dailyAttempts, 10);
  assert.equal(pace.medianCardSec, 60);
  assert.equal(pace.cardSecSource, "observed");
  assert.equal(pace.cardsPerPomodoro, 25);
  assert.ok(pace.reworkFactor >= MIN_REWORK_FACTOR && pace.reworkFactor <= MAX_REWORK_FACTOR);
  assert.ok(Math.abs(pace.reworkFactor - 1.11) <= 0.02, `expected rework ~1.11, got ${pace.reworkFactor}`);

  // All-outlier elapsed times are capped at ELAPSED_CAP_MS (180s)
  const slowAttempts = Array.from({ length: 6 }, (_, i) => ({
    timestamp: isoDaysAgo(i),
    grade: 1, // 0% pass rate -> clamped to MAX_REWORK_FACTOR (2.0)
    elapsed_ms: ELAPSED_CAP_MS * 5,
  }));
  const slowPace = extractLearnerPace(slowAttempts, { now: NOW });
  assert.equal(slowPace.medianCardSec, 180);
  assert.equal(slowPace.reworkFactor, MAX_REWORK_FACTOR);

  // 100% pass rate clamps rework factor to MIN_REWORK_FACTOR (1.05)
  const perfectAttempts = Array.from({ length: 12 }, (_, i) => ({
    timestamp: isoDaysAgo(i % 4),
    grade: 4,
    elapsed_ms: 30_000,
  }));
  const perfectPace = extractLearnerPace(perfectAttempts, { now: NOW });
  assert.equal(perfectPace.reworkFactor, MIN_REWORK_FACTOR);
});

test("cardSpacedReps reads spaced_reps, falls back cleanly on legacy cards, and respects mastery/lapses", () => {
  // Explicit spaced_reps takes precedence over inflated same-day repetitions
  const sameDayCard = makeCard("c1", {
    review: { repetitions: 5, spaced_reps: 1, interval_days: 3, due_at: isoDaysAgo(-3) },
  });
  assert.equal(cardSpacedReps(sameDayCard, 4), 1);

  // Legacy card without spaced_reps falls back to Math.min(3, repetitions)
  const legacy2 = makeCard("c2", {
    review: { repetitions: 2, interval_days: 7, due_at: isoDaysAgo(-7) },
  });
  assert.equal(cardSpacedReps(legacy2, 4), 2);
  const legacy5 = makeCard("c3", {
    review: { repetitions: 5, interval_days: 10, due_at: isoDaysAgo(-10) },
  });
  assert.equal(cardSpacedReps(legacy5, 4), TARGET_SPACED_REPS);

  // Mastered card (via Easy grade 5 or interval >= 21d + streak >= 2) returns 3
  const easyCard = makeCard("c4", { review: { repetitions: 1, spaced_reps: 1, interval_days: 8 } });
  assert.equal(cardSpacedReps(easyCard, 5), TARGET_SPACED_REPS);
  const intervalMastered = makeCard("c5", { review: { repetitions: 2, interval_days: 24 } });
  assert.equal(cardSpacedReps(intervalMastered, 4), TARGET_SPACED_REPS);

  // Lapsed card (grade < 3) resets remaining progress to 0
  assert.equal(cardSpacedReps(sameDayCard, 1), 0);
});

test("FSRS spacing floor prevents claiming a fresh deck can be mastered in one afternoon", () => {
  const normal = spacingProfile({}, { isFocus: false });
  const focus = spacingProfile({}, { isFocus: true });
  assert.equal(normal.totalDays, 17, `expected 17d default FSRS spacing floor, got ${normal.totalDays}`);
  assert.equal(focus.totalDays, 10, `expected 10d focus FSRS spacing floor, got ${focus.totalDays}`);

  const fastPace = {
    focusMinutes: 25,
    breakMinutes: 5,
    medianCardSec: 30,
    cardSecSource: "observed",
    cardsPerPomodoro: 50,
    attempts7d: 700,
    activeDays7d: 7,
    spanDays7d: 7,
    dailyAttempts: 100,
    attempts14d: 1400,
    passRate14d: 0.9,
    reworkFactor: 1.11,
    coldStart: false,
    lowSample: false,
  };
  const freshDeck = Array.from({ length: 10 }, (_, i) => makeCard(`fresh-${i}`));
  const forecast = forecastScope(freshDeck, fastPace, { now: NOW });
  assert.equal(forecast.status, "active");
  assert.equal(forecast.spacingFloorDays, 17);
  assert.ok(forecast.paceDays < 1, "raw pace workload is under 1 day");
  assert.ok(forecast.calendarDays >= 17, "calendar ETA honors the 17-day FSRS spacing floor");
  assert.ok(forecast.etaStartDate && /^\d{4}-\d{2}-\d{2}$/.test(forecast.etaStartDate));

  // Focus-only deck uses ~10-day spacing floor
  const focusForecast = forecastScope(freshDeck, fastPace, { now: NOW, isFocus: true });
  assert.equal(focusForecast.spacingFloorDays, 10);
  assert.ok(focusForecast.calendarDays >= 10 && focusForecast.calendarDays < 17);
});

test("forecastScope supports overrideDailyCards, exam-date deficit, suspended exclusion, and uncoveredPoints", () => {
  const cards = [
    ...Array.from({ length: 60 }, (_, i) => makeCard(`q-${i}`)),
    makeCard("suspended-1", { suspended: true }),
    makeCard("done-1", { review: { repetitions: 3, spaced_reps: 3, interval_days: 30 } }),
  ];

  // Cold start without override
  const coldPace = extractLearnerPace([], { now: NOW });
  const cold = forecastScope(cards, coldPace, { now: NOW, uncoveredPoints: 4 });
  assert.equal(cold.status, "cold-start");
  assert.equal(cold.totalCards, 61);
  assert.equal(cold.masteredCards, 1);
  assert.equal(cold.remainingCards, 60);
  assert.equal(cold.uncoveredPoints, 4);
  assert.equal(cold.etaStartDate, null);
  assert.equal(cold.spacingFloorDays, 17);
  assert.ok(cold.remainingPomodoros >= 7 && cold.remainingPomodoros <= 9);

  // Override daily cards preview ("按每天 100 题算") turns cold-start into an active forecast
  const preview = forecastScope(cards, coldPace, { now: NOW, overrideDailyCards: 100 });
  assert.equal(preview.status, "active");
  assert.equal(preview.paceBasis, "target");
  assert.equal(preview.effectiveDailyCards, 100);
  assert.ok(preview.calendarDays >= 17);
  assert.ok(preview.etaStartDate);

  // Exam date closer than pace-driven ETA flags `exam.behind` with calm daily pomodoro requirement
  const slowPace = { ...coldPace, coldStart: false, lowSample: false, dailyAttempts: 10 };
  const behindExam = forecastScope(cards, slowPace, { now: NOW, examDate: "2026-12-02" }); // 10 days from NOW
  assert.ok(behindExam.exam);
  assert.equal(behindExam.exam.date, "2026-12-02");
  assert.equal(behindExam.exam.daysLeft, 10);
  assert.equal(behindExam.exam.behind, true);
  assert.equal(behindExam.exam.spacingTight, true);
  assert.ok(behindExam.exam.requiredDailyPomodoros > 0);
  assert.ok(behindExam.exam.requiredDailyCards >= 20);

  // Distant exam date is comfortably on track
  const comfyExam = forecastScope(cards, slowPace, { now: NOW, examDate: "2027-03-01" });
  assert.equal(comfyExam.exam.behind, false);
});

test("libraryPaceForecast benchmarks < 15ms and < 5 KB payload on 2,000 cards", (t) => {
  const decks = Array.from({ length: 20 }, (_, d) => ({
    id: `deck-${d}`,
    title: `Deck ${d}`,
    course: `Course ${d % 5}`,
    cards: Array.from({ length: 100 }, (_, c) => ({
      id: `c-${d}-${c}`,
      kind: "quiz",
      topic: `Topic ${c % 4}`,
      review: c % 4 === 0
        ? { repetitions: 3, spaced_reps: 3, interval_days: 28, due_at: isoDaysAgo(-20) }
        : c % 4 === 1
          ? { repetitions: 2, spaced_reps: 2, interval_days: 10, due_at: isoDaysAgo(-5) }
          : c % 4 === 2
            ? { repetitions: 1, spaced_reps: 1, interval_days: 3, due_at: isoDaysAgo(-2) }
            : { repetitions: 0, interval_days: 0, due_at: null },
    })),
  }));
  const attempts = Array.from({ length: 600 }, (_, i) => ({
    deckId: `deck-${i % 20}`,
    quiz_id: `c-${i % 20}-${i % 100}`,
    grade: i % 5 === 0 ? 1 : 4,
    elapsed_ms: 35_000 + (i % 30) * 1000,
    timestamp: isoDaysAgo(i % 14),
  }));
  const state = {
    decks,
    attempts,
    courses: Array.from({ length: 5 }, (_, i) => ({
      id: `course-${i}`,
      name: `Course ${i}`,
      ...(i === 0 ? { exam: { date: "2026-12-15" } } : {}),
    })),
    settings: { request_retention: 0.9, maximum_interval: 36500 },
  };

  // Warmup cache & JIT (5 calls), then measure batched CPU time (5 batches x 10 calls) via shared perf-gate helper
  // so parallel CI scheduling and Windows 15.625ms process.cpuUsage() tick quantization cannot inflate single-call readings.
  const first = libraryPaceForecast(state, { now: NOW });
  const smallState = {
    ...state,
    decks: decks.slice(0, 5), // 500 cards (1/4 of full state)
    attempts: attempts.slice(0, 150),
  };
  const stats = assertCpuBudget(() => libraryPaceForecast(state, { now: NOW }), {
    maxMedianMs: 15,
    warmup: 5,
    samples: 5,
    batch: 10,
    label: "2,000-card libraryPaceForecast",
    referenceFn: () => libraryPaceForecast(smallState, { now: NOW }),
    maxRatio: 10, // 4x cards in O(N) stays well under 10x (O(N^2) would be ~16x)
  });
  // Deterministic O(N) work invariant: Date.parse is called at most once per attempt + once per non-mastered card with due_at.
  const origDateParse = Date.parse;
  let dateParseCalls = 0;
  Date.parse = (...args) => {
    dateParseCalls += 1;
    return origDateParse(...args);
  };
  try {
    libraryPaceForecast(state, { now: NOW });
  } finally {
    Date.parse = origDateParse;
  }
  const payloadBytes = JSON.stringify(first).length;
  t.diagnostic(
    `2,000-card libraryPaceForecast: median ${stats.median.toFixed(3)} ms CPU (${stats.ratio.toFixed(2)}x vs 500-card ref ${stats.reference.median.toFixed(3)} ms), ${dateParseCalls} Date.parse calls, payload ${payloadBytes} bytes`,
  );

  assert.ok(
    dateParseCalls <= 2000 + attempts.length,
    `expected O(N) Date.parse calls <= ${2000 + attempts.length}, got ${dateParseCalls}`,
  );
  assert.ok(payloadBytes < 5120, `expected compact payload < 5 KB, got ${payloadBytes} bytes`);
  assert.equal(first.library.total, 2000);
  assert.equal(Object.keys(first.decks).length, 20);
  assert.equal(Object.keys(first.courses).length, 5);
  assert.equal(first.courses["Course 0"].exam?.date, "2026-12-15");
  assert.equal("cards" in first.decks["deck-0"], false, "no per-card arrays in compact snapshot");
});

test("buildRevisionBase caches compact paceForecast (< 5 KB) and skips it on timeOnly / compact snapshots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-pace-snapshot-"));
  await seedLibrary(root, { sources: 12, decks: 8, cardsPerDeck: 25, runs: 2, attempts: 120, courses: 3 });
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  // Pin Date after seeding so snapshot minute-bucket polling is 100% deterministic and never races real :00 or midnight rollovers.
  const localNoon = new Date(2026, 10, 22, 12, 0, 30, 0).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: localNoon });

  const snap1 = await service.call("snapshot");
  assert.ok(snap1.paceForecast, "full snapshot carries paceForecast");
  const paceBytes = JSON.stringify(snap1.paceForecast).length;
  assert.ok(paceBytes < 5120, `snapshot paceForecast is ${paceBytes} bytes; budget < 5 KB`);
  assert.equal(Object.keys(snap1.paceForecast.decks).length, 8);
  assert.ok(snap1.paceForecast.library.total > 0);

  // Within the same minute (12:00:30 -> 12:00:45): unchanged poll deterministically short-circuits.
  t.mock.timers.tick(15_000);
  const unchanged = await service.call("snapshot", { since: snap1.fingerprint });
  assert.equal(unchanged.unchanged, true);

  // Advance across a real minute boundary within the same local day (12:00:45 -> 12:01:45):
  // timeOnly partial poll MUST execute (never silently skipped at 00:00) and MUST NOT emit paceForecast.
  t.mock.timers.tick(60_000);
  const partial = await service.call("snapshot", { since: snap1.fingerprint, partial: true });
  assert.equal(partial.partial, true);
  assert.equal(Object.hasOwn(partial, "paceForecast"), false, "timeOnly partial poll must not resend or recompute paceForecast");

  // Explicit midnight rollover check (23:59:45 -> 00:00:15 next local day): crossing local midnight yields a full snapshot with fresh paceForecast.
  const beforeMidnightMs = new Date(2026, 10, 22, 23, 59, 45, 0).getTime();
  t.mock.timers.setTime(beforeMidnightMs);
  const preMidnightSnap = await service.call("snapshot");
  t.mock.timers.tick(30_000); // 2026-11-23 00:00:15 local
  const postMidnightSnap = await service.call("snapshot", { since: preMidnightSnap.fingerprint, partial: true });
  assert.notEqual(postMidnightSnap.partial, true, "crossing local midnight must return a full snapshot, not a timeOnly partial");
  assert.ok(postMidnightSnap.paceForecast, "post-midnight full snapshot refreshes paceForecast");

  // Compact agent snapshot omits paceForecast
  const compact = await service.call("snapshot", { compact: true });
  assert.equal(Object.hasOwn(compact, "paceForecast"), false, "compact snapshot omits paceForecast");
});

test("pace-forecast flake-repro: minute-boundary & wall-clock jitter flake legacy checks, hardened gates stay green and catch real regressions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-pace-flake-"));
  await seedLibrary(root, { sources: 6, decks: 4, cardsPerDeck: 15, runs: 1, attempts: 40, courses: 2 });
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  // (a1) Reproduce the legacy minute-boundary race: clock sits 100ms before :00, crosses :00 before the poll.
  const boundaryMs = new Date(2026, 10, 22, 12, 0, 59, 900).getTime();
  t.mock.timers.enable({ apis: ["Date"], now: boundaryMs });
  const snapBeforeTick = await service.call("snapshot");
  t.mock.timers.tick(200); // crosses into 12:01:00.100
  const racedPoll = await service.call("snapshot", { since: snapBeforeTick.fingerprint });
  assert.notEqual(racedPoll.unchanged, true, "a naive unpinned poll flakes when real wall clock crosses :00");

  // (a2) Reproduce wall-clock jitter flaking a legacy single-shot performance.now() gate on real libraryPaceForecast.
  const state = {
    decks: Array.from({ length: 10 }, (_, d) => ({
      id: `deck-${d}`,
      course: `Course ${d % 3}`,
      cards: Array.from({ length: 100 }, (_, c) => makeCard(`c-${d}-${c}`)),
    })),
    attempts: Array.from({ length: 200 }, (_, i) => ({
      deckId: `deck-${i % 10}`,
      quiz_id: `c-${i % 10}-${i % 100}`,
      grade: i % 4 === 0 ? 1 : 4,
      elapsed_ms: 40_000,
      timestamp: isoDaysAgo(i % 10),
    })),
    courses: [{ id: "c0", name: "Course 0" }],
    settings: { request_retention: 0.9, maximum_interval: 36500 },
  };
  let wallStallMs = 0;
  let wallCall = 0;
  let inside = false;
  const preemptedWallNow = () => {
    const realMs = performance.now();
    if (!inside) {
      inside = true;
      return realMs + wallStallMs;
    }
    inside = false;
    wallCall += 1;
    if (wallCall % 5 < 3) wallStallMs += 18; // +18 ms OS scheduling stall layered onto real performance.now()
    return realMs + wallStallMs;
  };
  const legacyWall = measureWallSamples(() => libraryPaceForecast(state, { now: NOW }), {
    warmup: 3,
    samples: 11,
    now: preemptedWallNow,
  });
  assert.throws(
    () => assert.ok(legacyWall.median < 15, `median ${legacyWall.median.toFixed(2)} ms exceeded 15 ms`),
    /exceeded 15 ms/,
    "legacy wall-clock gate must fail under OS preemption stalls",
  );

  // (b) Hardened deterministic clock & batched CPU-time gate stay green.
  t.mock.timers.setTime(new Date(2026, 10, 22, 12, 5, 10, 0).getTime());
  const pinnedSnap = await service.call("snapshot");
  t.mock.timers.tick(5_000);
  assert.equal((await service.call("snapshot", { since: pinnedSnap.fingerprint })).unchanged, true);
  t.mock.timers.tick(60_000);
  const pinnedPartial = await service.call("snapshot", { since: pinnedSnap.fingerprint, partial: true });
  assert.equal(pinnedPartial.partial, true);
  assert.equal(Object.hasOwn(pinnedPartial, "paceForecast"), false);

  const cpuStats = assertCpuBudget(() => libraryPaceForecast(state, { now: NOW }), {
    maxMedianMs: 15,
    warmup: 3,
    samples: 5,
    batch: 5,
    label: "hardened pace-forecast CPU gate",
  });
  assert.ok(cpuStats.median < 15);

  // (c) Genuine regressions still fail the hardened gates (zero busy-loops, zero hand-built tautologies):
  // (c1) Real algorithmic CPU regression: recomputing uncached FSRS spacingProfile once per card (violating
  // forecast.js's "ONCE per settings bucket — never per card" invariant) naturally breaches < 15 ms CPU.
  let uniqueInterval = 10_000;
  const regressedPerCardSpacing = () => {
    let totalFloor = 0;
    for (const deck of state.decks) {
      for (let i = 0; i < deck.cards.length; i += 1) {
        uniqueInterval += 1;
        totalFloor += spacingProfile({ request_retention: 0.9, maximum_interval: uniqueInterval }).totalDays;
      }
    }
    const res = libraryPaceForecast(state, { now: NOW });
    return totalFloor > 0 ? res : null;
  };
  const calibratedBudgetMs = Math.min(15, Math.max(cpuStats.median * 3, 0.5));
  assert.throws(
    () => assertCpuBudget(regressedPerCardSpacing, {
      maxMedianMs: calibratedBudgetMs,
      referenceFn: () => libraryPaceForecast(state, { now: NOW }),
      maxRatio: 5,
      warmup: 1,
      samples: 3,
      batch: 1,
      label: "regressed per-card spacingProfile forecast",
    }),
    /exceeded budget </,
    "genuine per-card FSRS spacingProfile regression must fail the hardened pace-forecast CPU gate",
  );

  // (c2) Real buildRevisionBase / snapshot contract check: when a library mutation occurs before the next
  // `partial: true` poll, snapshot MUST invalidate the timeOnly shortcut and emit a fresh paceForecast.
  await service.call("source.add", { title: "Mutation invalidates timeOnly", text: "Content for revision bump", courses: [] });
  const afterMutation = await service.call("snapshot", { since: pinnedPartial.fingerprint, partial: true });
  assert.notEqual(afterMutation.partial, true, "real library write must bypass timeOnly partial poll");
  assert.ok(afterMutation.paceForecast, "post-write full snapshot must recompute and emit paceForecast");
});

test("sm2.schedule same-day spaced_reps and Easy->Good last_grade=5 integrate cleanly with pace-forecast", () => {
  // 1. 5x same-day Good(4) caps spaced_reps at 1 -> pace-forecast still counts 2 remaining spaced passes.
  let sameDayReview = null;
  for (let i = 0; i < 5; i++) {
    sameDayReview = schedule(sameDayReview, 4, new Date(NOW + i * 60_000));
  }
  assert.equal(sameDayReview.spaced_reps, 1);
  assert.equal(cardSpacedReps({ id: "c-same", review: sameDayReview }, 4), 1);

  // 2. Easy(5) followed by same-day Good(4) preserves last_grade=5 -> pace-forecast keeps card mastered (3/3).
  let easyThenGood = schedule(null, 5, new Date(NOW));
  easyThenGood = schedule(easyThenGood, 4, new Date(NOW + 120_000));
  assert.equal(easyThenGood.last_grade, 5);
  assert.equal(cardSpacedReps({ id: "c-easy", review: easyThenGood }, 4), TARGET_SPACED_REPS);

  // 3. Combined deck forecast reports mastered=1, total=2, remaining=1 (2 spaced passes left).
  const state = {
    decks: [{
      id: "d-int",
      course: "Algo",
      cards: [
        { id: "c-same", review: sameDayReview },
        { id: "c-easy", review: easyThenGood },
      ],
    }],
    attempts: [
      { deck_id: "d-int", quiz_id: "c-same", grade: 4, elapsed_ms: 40_000, timestamp: new Date(NOW).toISOString() },
      { deck_id: "d-int", quiz_id: "c-easy", grade: 4, elapsed_ms: 40_000, timestamp: new Date(NOW + 120_000).toISOString() },
    ],
    settings: {},
    courses: [{ name: "Algo" }],
  };
  const forecast = libraryPaceForecast(state, { now: NOW + 180_000 });
  assert.equal(forecast.decks["d-int"].total, 2);
  assert.equal(forecast.decks["d-int"].remaining, 1);
  assert.equal(forecast.decks["d-int"].passes, 2);
});
