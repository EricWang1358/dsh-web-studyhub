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

  // Warmup cache & JIT (5 calls), then measure batched CPU time (5 batches x 10 calls) so parallel CI scheduling
  // and Windows 15.625ms process.cpuUsage() tick quantization cannot inflate single-call readings.
  const first = libraryPaceForecast(state, { now: NOW });
  for (let i = 0; i < 4; i++) libraryPaceForecast(state, { now: NOW });
  const BATCH = 10;
  const times = [];
  for (let i = 0; i < 5; i++) {
    const cpuBefore = process.cpuUsage();
    for (let j = 0; j < BATCH; j++) libraryPaceForecast(state, { now: NOW });
    const cpuUsed = process.cpuUsage(cpuBefore);
    times.push((cpuUsed.user + cpuUsed.system) / 1000 / BATCH);
  }
  times.sort((a, b) => a - b);
  const medianMs = times[Math.floor(times.length / 2)];
  const payloadBytes = JSON.stringify(first).length;
  t.diagnostic(`2,000-card libraryPaceForecast: median ${medianMs.toFixed(3)} ms CPU, payload ${payloadBytes} bytes`);

  assert.ok(medianMs < 15, `expected median < 15ms CPU on 2,000 cards, got ${medianMs.toFixed(3)}ms`);
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

  const snap1 = await service.call("snapshot");
  assert.ok(snap1.paceForecast, "full snapshot carries paceForecast");
  const paceBytes = JSON.stringify(snap1.paceForecast).length;
  assert.ok(paceBytes < 5120, `snapshot paceForecast is ${paceBytes} bytes; budget < 5 KB`);
  assert.equal(Object.keys(snap1.paceForecast.decks).length, 8);
  assert.ok(snap1.paceForecast.library.total > 0);

  // Unchanged poll short-circuits (re-read once if the real clock crossed a minute boundary between snap1 and the poll)
  let baseSnap = snap1;
  let unchanged = await service.call("snapshot", { since: baseSnap.fingerprint });
  if (!unchanged.unchanged && unchanged.fingerprint && unchanged.fingerprint !== baseSnap.fingerprint) {
    baseSnap = unchanged;
    unchanged = await service.call("snapshot", { since: baseSnap.fingerprint });
  }
  assert.equal(unchanged.unchanged, true);

  // Simulated timeOnly partial poll (advance minute in fingerprint within same local day) does NOT emit paceForecast
  const fpParts = JSON.parse(baseSnap.fingerprint);
  const currentMinute = fpParts[6];
  const sameLocalDay = new Date((currentMinute - 1) * 60_000).toDateString() === new Date(currentMinute * 60_000).toDateString();
  if (sameLocalDay) {
    fpParts[6] = currentMinute - 1;
    const earlierFp = JSON.stringify(fpParts);
    const partial = await service.call("snapshot", { since: earlierFp, partial: true });
    assert.equal(partial.partial, true);
    assert.equal(Object.hasOwn(partial, "paceForecast"), false, "timeOnly partial poll must not resend or recompute paceForecast");
  }

  // Compact agent snapshot omits paceForecast
  const compact = await service.call("snapshot", { compact: true });
  assert.equal(Object.hasOwn(compact, "paceForecast"), false, "compact snapshot omits paceForecast");
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
