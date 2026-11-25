/* Plain-language mastery ETA forecast ("按近几天进度，大概啥时候能学会").
   Pure, zero-Node-dep, browser-safe module shared across library snapshot caching
   and forecast calculations.

   Core model (keep it honest, calm, and O(N) < 1.5ms on 2,000 cards):
   - Mastery bar: 3 distinct-day spaced passes (`spaced_reps >= 3`), falling back
     cleanly to legacy `repetitions` / `cardLevel() === 'mastered'` when `spaced_reps`
     is absent. Suspended / slayed cards are excluded.
   - Recent pace: extracted in one pass from active direct attempts (`!voidedAt && !implicit`),
     per-card `elapsed_ms` capped at 3 minutes, 10%-trimmed median card time (default 50s),
     7-day daily attempt rate (with cold-start & low-sample flags), and 14-day pass rate
     giving a rework multiplier clamped to [1.05, 2.0] (default 1.25).
   - Calendar horizon: combines pace-driven days (`effectiveAttempts / dailyAttempts`,
     or optional `overrideDailyCards`) with the FSRS spacing floor (~17d default, ~10d
     focus, computed ONCE per settings bucket via `ts-fsrs` — never per card). */

import { Rating, createEmptyCard, fsrs, generatorParameters } from "ts-fsrs";
import { checkSettings, defaults as sm2Defaults, focusScheduleSettings, weightsOf } from "../sm2.js";
import { cardLevel, isActiveAttempt, isImportedAttempt, latestOutcomes } from "../mastery.js";
import { courseOf } from "../focus.js";
import { courseExamByName } from "../card-schedule.js";
import { courseActivityRules } from "../course-active.js";
import { courseAncestors, courseKnown } from "../course-tree.js";
import { knownCourseNames } from "../source-courses.js";
import { courseFocusTopics } from "../focus-points.js";

const DAY_MS = 864e5;
const SPACING_CACHE_LIMIT = 64;
const ELAPSED_SAMPLE_CAP = 200;

export const TARGET_SPACED_REPS = 3;
export const ELAPSED_CAP_MS = 180_000;
export const MIN_VALID_ELAPSED_MS = 500;
export const DEFAULT_CARD_SEC = 50;
export const DEFAULT_FOCUS_MINUTES = 25;
export const DEFAULT_BREAK_MINUTES = 5;
export const PACE_WINDOW_DAYS = 7;
export const PASS_RATE_WINDOW_DAYS = 14;
export const DEFAULT_REWORK_FACTOR = 1.25;
export const MIN_REWORK_FACTOR = 1.05;
export const MAX_REWORK_FACTOR = 2.0;
export const MIN_PASS_RATE_SAMPLES = 5;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;

/** Local calendar day number for an epoch timestamp in the learner's local timezone. */
function localDay(ms) {
  const date = new Date(ms);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** Fast local day helper anchored to `now` (avoids per-card/per-attempt `new Date()` allocations in hot loops). */
function makeLocalDayFn(nowMs) {
  const offsetMs = -new Date(nowMs).getTimezoneOffset() * 60_000;
  return (ms) => Math.floor((ms + offsetMs) / DAY_MS);
}

/** Format a local epoch timestamp + integer day offset as `YYYY-MM-DD`. */
export function localDateIso(ms, offsetDays = 0) {
  const base = new Date(ms);
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, "0");
  const d = String(target.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole local calendar days from `nowMs` to `YYYY-MM-DD`, or null when invalid. */
function daysUntilDate(nowMs, isoDate) {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetDay = Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  if (!Number.isFinite(targetDay)) return null;
  return targetDay - localDay(nowMs);
}

/** Round pomodoro workload cleanly: >=0.5 when work remains, 0.5 steps under 10, whole integers at 10+. */
export function roundPomodoros(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (raw < 0.5) return 0.5;
  if (raw < 10) return Math.round(raw * 2) / 2;
  return Math.round(raw);
}

/** Count set bits in a small bitmask. */
function popcount(mask) {
  let n = mask;
  let bits = 0;
  while (n > 0) {
    n &= n - 1;
    bits++;
  }
  return bits;
}

/**
 * Cross-day spaced pass count (0..3) for one card.
 * Prefers `card.review.spaced_reps` (Stage 1a same-day FSRS fix) and falls back cleanly
 * to `card.review.repetitions` / `cardLevel(card, lastGrade) === 'mastered'` on older cards.
 */
export function cardSpacedReps(card, lastGrade) {
  if (!card || typeof card !== "object") return 0;
  if (cardLevel(card, lastGrade) === "mastered") return TARGET_SPACED_REPS;
  if (lastGrade !== undefined && lastGrade < 3) return 0;
  const review = card.review;
  if (!review || typeof review !== "object") return 0;
  if (review.last_grade === 5 && (Number(review.spaced_reps ?? review.repetitions) || 0) > 0) {
    return TARGET_SPACED_REPS;
  }
  if (review.spaced_reps !== undefined && review.spaced_reps !== null && Number.isFinite(Number(review.spaced_reps))) {
    return clamp(Math.floor(Number(review.spaced_reps)), 0, TARGET_SPACED_REPS);
  }
  const legacyReps = Number(review.repetitions);
  if (Number.isFinite(legacyReps) && legacyReps > 0) {
    return clamp(Math.floor(legacyReps), 0, TARGET_SPACED_REPS);
  }
  return 0;
}

const spacingCache = new Map();

/**
 * Compute the FSRS 3-pass spacing floor (`gap1`, `gap2`, `totalDays`) ONCE per settings bucket.
 * Default retention (0.90) -> ~3 + 14 = 17 days; focus retention (0.94) -> ~3 + 7 = 10 days.
 */
export function spacingProfile(settings = sm2Defaults, { isFocus = false } = {}) {
  let checked;
  try {
    checked = focusScheduleSettings(checkSettings(settings ?? sm2Defaults), { isFocus });
  } catch {
    checked = focusScheduleSettings(sm2Defaults, { isFocus });
  }
  const retention = checked.request_retention;
  const maxInterval = Math.max(1, Math.round(checked.maximum_interval));
  const weights = Array.isArray(checked.w) ? checked.w : null;
  const cacheKey = `${retention}:${maxInterval}:${weights ? weights.join(",") : ""}`;
  const cached = spacingCache.get(cacheKey);
  if (cached) return cached;

  const engine = fsrs(
    generatorParameters({
      request_retention: retention,
      maximum_interval: maxInterval,
      w: [...weightsOf(checked)],
      enable_fuzz: false,
      enable_short_term: false,
      learning_steps: [],
      relearning_steps: [],
    }),
  );
  const t0 = new Date(Date.UTC(2026, 0, 1));
  const pass1 = engine.repeat(createEmptyCard(t0), t0)[Rating.Good].card;
  const gap1 = Math.min(maxInterval, Math.max(1, Math.round(pass1.scheduled_days || 1)));
  const t1 = new Date(t0.getTime() + gap1 * DAY_MS);
  const pass2 = engine.repeat(pass1, t1)[Rating.Good].card;
  const gap2 = Math.min(maxInterval, Math.max(1, Math.round(pass2.scheduled_days || 1)));
  const profile = Object.freeze({ gap1, gap2, totalDays: gap1 + gap2 });

  if (spacingCache.size >= SPACING_CACHE_LIMIT) spacingCache.clear();
  spacingCache.set(cacheKey, profile);
  return profile;
}

/** 10%-trimmed median of a numeric array. */
function trimmedMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.1);
  const start = trim;
  const end = sorted.length - trim;
  const len = end - start;
  if (len <= 0) return sorted[Math.floor(sorted.length / 2)];
  const mid = start + Math.floor(len / 2);
  return len % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Extract recent learner pace from the attempt log in one O(M) pass.
 * Considers only active direct attempts (`!voidedAt && !implicit`).
 */
export function extractLearnerPace(
  attempts = [],
  { now = Date.now(), focusMinutes = DEFAULT_FOCUS_MINUTES, breakMinutes = DEFAULT_BREAK_MINUTES } = {},
) {
  const safeFocus = Number.isFinite(Number(focusMinutes)) && Number(focusMinutes) > 0 ? Number(focusMinutes) : DEFAULT_FOCUS_MINUTES;
  const safeBreak = Number.isFinite(Number(breakMinutes)) && Number(breakMinutes) >= 0 ? Number(breakMinutes) : DEFAULT_BREAK_MINUTES;
  const list = Array.isArray(attempts) ? attempts : [];
  const dayOf = makeLocalDayFn(now);
  const today = dayOf(now);

  let earliestDay = Infinity;
  let attempts7d = 0;
  let activeDayMask7 = 0;
  let attempts14d = 0;
  let passed14d = 0;
  const elapsed14d = [];
  const elapsedFallback = [];

  for (let i = 0; i < list.length; i++) {
    const attempt = list[i];
    if (!isActiveAttempt(attempt) || attempt.implicit || isImportedAttempt(attempt) || attempt.sample) continue;
    const ts = Date.parse(attempt.timestamp);
    if (!Number.isFinite(ts)) continue;
    const day = dayOf(ts);
    const age = today - day;
    if (age < 0) continue; // ignore clock-skew future timestamps
    if (day < earliestDay) earliestDay = day;

    const rawElapsed = attempt.assessment === 'oral' ? NaN : Number(attempt.elapsed_ms);
    const validElapsed = Number.isFinite(rawElapsed) && rawElapsed >= MIN_VALID_ELAPSED_MS
      ? Math.min(ELAPSED_CAP_MS, rawElapsed)
      : 0;

    if (age < PACE_WINDOW_DAYS) {
      attempts7d++;
      activeDayMask7 |= 1 << age;
    }
    if (age < PASS_RATE_WINDOW_DAYS) {
      attempts14d++;
      if (Number(attempt.grade) >= 3) passed14d++;
      if (validElapsed > 0) {
        if (elapsed14d.length >= ELAPSED_SAMPLE_CAP) elapsed14d.shift();
        elapsed14d.push(validElapsed);
      }
    } else if (validElapsed > 0) {
      if (elapsedFallback.length >= ELAPSED_SAMPLE_CAP) elapsedFallback.shift();
      elapsedFallback.push(validElapsed);
    }
  }

  // Median per-card time (seconds): prefer 14-day window, blend gently when < 3 samples, fallback 50s.
  const samples = elapsed14d.length >= 3 ? elapsed14d : elapsed14d.length > 0 ? [...elapsedFallback.slice(-(ELAPSED_SAMPLE_CAP - elapsed14d.length)), ...elapsed14d] : elapsedFallback;
  let medianCardSec = DEFAULT_CARD_SEC;
  let cardSecSource = "default";
  if (samples.length >= 3) {
    medianCardSec = Math.round(clamp(trimmedMedian(samples) / 1000, 5, ELAPSED_CAP_MS / 1000));
    cardSecSource = "observed";
  } else if (samples.length > 0) {
    const obsSec = clamp(trimmedMedian(samples) / 1000, 5, ELAPSED_CAP_MS / 1000);
    const weight = samples.length / 3;
    medianCardSec = Math.round(obsSec * weight + DEFAULT_CARD_SEC * (1 - weight));
    cardSecSource = "blended";
  }

  // Rework factor from recent 14-day pass rate, clamped to [1.05, 2.0].
  let passRate14d = null;
  let reworkFactor = DEFAULT_REWORK_FACTOR;
  if (attempts14d > 0) {
    passRate14d = Math.round((passed14d / attempts14d) * 1000) / 1000;
    if (attempts14d >= MIN_PASS_RATE_SAMPLES) {
      const rawRework = passRate14d > 0 ? 1 / passRate14d : MAX_REWORK_FACTOR;
      reworkFactor = round2(clamp(rawRework, MIN_REWORK_FACTOR, MAX_REWORK_FACTOR));
    }
  }

  const activeDays7d = popcount(activeDayMask7);
  // New learners who began within the last 7 days are averaged over their active span so day-1 pace isn't divided by 7.
  const spanDays7d = attempts7d === 0
    ? PACE_WINDOW_DAYS
    : clamp(today - Math.max(earliestDay, today - (PACE_WINDOW_DAYS - 1)) + 1, 1, PACE_WINDOW_DAYS);
  const dailyAttempts = attempts7d > 0 ? round1(attempts7d / spanDays7d) : 0;
  const coldStart = attempts7d === 0;
  const lowSample = coldStart || activeDays7d < 3 || attempts7d < 10;
  const cardsPerPomodoro = Math.max(1, Math.round((safeFocus * 60) / medianCardSec));

  return {
    focusMinutes: safeFocus,
    breakMinutes: safeBreak,
    medianCardSec,
    cardSecSource,
    cardsPerPomodoro,
    attempts7d,
    activeDays7d,
    spanDays7d,
    dailyAttempts,
    attempts14d,
    passRate14d,
    reworkFactor,
    coldStart,
    lowSample,
  };
}

function createScopeAcc() {
  return {
    totalCards: 0,
    masteredCards: 0,
    remainingCards: 0,
    freshOrWeakCards: 0,
    remainingRawPasses: 0,
    spacingFloorDays: 0,
  };
}

/** Add one non-suspended card's contribution to an accumulator (zero allocations). */
function addCardToAcc(acc, reps, dueDays, sp) {
  acc.totalCards++;
  if (reps >= TARGET_SPACED_REPS) {
    acc.masteredCards++;
    return;
  }
  acc.remainingCards++;
  acc.remainingRawPasses += TARGET_SPACED_REPS - reps;
  if (reps === 0) acc.freshOrWeakCards++;

  let cardFloor = 0;
  if (reps === 0) cardFloor = sp.totalDays;
  else if (reps === 1) cardFloor = dueDays + sp.gap2;
  else cardFloor = dueDays;
  if (cardFloor > acc.spacingFloorDays) acc.spacingFloorDays = cardFloor;
}

/** Build the full forecast object from an accumulator + learner pace. */
function finalizeAcc(acc, pace, { now = Date.now(), overrideDailyCards = null, examDate = null, uncoveredPoints = 0 } = {}) {
  const safeUncovered = Number.isFinite(Number(uncoveredPoints)) && Number(uncoveredPoints) > 0
    ? Math.floor(Number(uncoveredPoints))
    : 0;

  if (acc.totalCards === 0) {
    return {
      status: "empty",
      totalCards: 0,
      masteredCards: 0,
      remainingCards: 0,
      remainingRawPasses: 0,
      effectiveAttempts: 0,
      remainingPomodoros: 0,
      remainingHours: 0,
      spacingFloorDays: 0,
      paceDays: null,
      calendarDays: null,
      minDays: null,
      maxDays: null,
      etaStartDate: null,
      etaEndDate: null,
      paceBasis: "empty",
      effectiveDailyCards: 0,
      exam: null,
      uncoveredPoints: safeUncovered,
    };
  }

  if (acc.remainingCards === 0) {
    return {
      status: "mastered",
      totalCards: acc.totalCards,
      masteredCards: acc.masteredCards,
      remainingCards: 0,
      remainingRawPasses: 0,
      effectiveAttempts: 0,
      remainingPomodoros: 0,
      remainingHours: 0,
      spacingFloorDays: 0,
      paceDays: 0,
      calendarDays: 0,
      minDays: 0,
      maxDays: 0,
      etaStartDate: null,
      etaEndDate: null,
      paceBasis: pace.coldStart ? "cold-start" : "recent",
      effectiveDailyCards: pace.dailyAttempts,
      exam: null,
      uncoveredPoints: safeUncovered,
    };
  }

  const effectiveAttempts = Math.ceil(acc.remainingRawPasses * pace.reworkFactor);
  const remainingMinutes = (effectiveAttempts * pace.medianCardSec) / 60;
  const remainingHours = Math.max(0.1, round1(remainingMinutes / 60));
  const remainingPomodoros = roundPomodoros(remainingMinutes / pace.focusMinutes);
  const spacingFloorDays = Math.max(0, Math.round(acc.spacingFloorDays));

  const override = Number(overrideDailyCards);
  const hasOverride = Number.isFinite(override) && override > 0;
  const effectiveDailyCards = hasOverride ? override : pace.dailyAttempts;
  const paceBasis = hasOverride
    ? "target"
    : pace.dailyAttempts > 0
      ? (pace.lowSample ? "low-sample" : "recent")
      : "cold-start";

  let paceDays = null;
  let minDays = spacingFloorDays;
  let maxDays = null;
  let etaStartDate = null;
  let etaEndDate = null;
  let status = "cold-start";

  if (effectiveDailyCards > 0) {
    status = "active";
    paceDays = round1(effectiveAttempts / effectiveDailyCards);
    minDays = Math.max(Math.ceil(paceDays), spacingFloorDays);
    if (paceDays >= spacingFloorDays) {
      maxDays = Math.max(minDays, Math.ceil(minDays * 1.2));
    } else {
      const introDays = Math.ceil(acc.freshOrWeakCards / effectiveDailyCards);
      maxDays = Math.max(minDays, Math.ceil(spacingFloorDays + Math.min(introDays, paceDays) * 0.6));
    }
    etaStartDate = localDateIso(now, minDays);
    etaEndDate = localDateIso(now, maxDays);
  }

  let exam = null;
  const daysLeft = daysUntilDate(now, examDate);
  if (daysLeft !== null && daysLeft > 0) {
    const requiredDailyCards = Math.max(1, Math.ceil(effectiveAttempts / daysLeft));
    const requiredDailyPomodoros = roundPomodoros(((requiredDailyCards * pace.medianCardSec) / 60) / pace.focusMinutes);
    const behind = status === "active" ? minDays > daysLeft : spacingFloorDays > daysLeft;
    exam = {
      date: examDate,
      daysLeft,
      behind,
      spacingTight: spacingFloorDays > daysLeft,
      requiredDailyCards,
      requiredDailyPomodoros,
    };
  }

  return {
    status,
    totalCards: acc.totalCards,
    masteredCards: acc.masteredCards,
    remainingCards: acc.remainingCards,
    remainingRawPasses: acc.remainingRawPasses,
    effectiveAttempts,
    remainingPomodoros,
    remainingHours,
    spacingFloorDays,
    paceDays,
    calendarDays: minDays,
    minDays,
    maxDays,
    etaStartDate,
    etaEndDate,
    paceBasis,
    effectiveDailyCards,
    exam,
    uncoveredPoints: safeUncovered,
  };
}

/** Compact snapshot representation (< 120 bytes per active entry; no per-card arrays). */
function compactEntry(full) {
  if (full.status === "empty" || full.status === "mastered") {
    return { status: full.status, total: full.totalCards };
  }
  return {
    status: full.status,
    total: full.totalCards,
    remaining: full.remainingCards,
    passes: full.remainingRawPasses,
    pomodoros: full.remainingPomodoros,
    hours: full.remainingHours,
    days: full.calendarDays,
    ...(full.maxDays != null && full.maxDays !== full.calendarDays ? { maxDays: full.maxDays } : {}),
    floor: full.spacingFloorDays,
    ...(full.exam ? { exam: full.exam } : {}),
  };
}

/**
 * Forecast mastery workload and calendar ETA for an arbitrary card list (slice, deck, or course).
 */
export function forecastScope(
  cards = [],
  pace = null,
  {
    now = Date.now(),
    settings = sm2Defaults,
    isFocus = null,
    outcome = null,
    overrideDailyCards = null,
    examDate = null,
    uncoveredPoints = 0,
    normalSpacing = null,
    focusSpacing = null,
  } = {},
) {
  const resolvedPace = pace && typeof pace === "object" ? pace : extractLearnerPace([], { now });
  const spNormal = normalSpacing || spacingProfile(settings, { isFocus: false });
  const spFocus = focusSpacing || spacingProfile(settings, { isFocus: true });
  const today = localDay(now);
  const acc = createScopeAcc();

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card || card.suspended) continue;
    const lastGrade = typeof outcome === "function" ? outcome(card) : undefined;
    const reps = cardSpacedReps(card, lastGrade);
    let dueDays = 0;
    if (reps > 0 && reps < TARGET_SPACED_REPS && card.review?.due_at) {
      const dueMs = Date.parse(card.review.due_at);
      if (Number.isFinite(dueMs)) dueDays = Math.max(0, localDay(dueMs) - today);
    }
    const focus = typeof isFocus === "function" ? Boolean(isFocus(card)) : Boolean(isFocus || card.focus);
    addCardToAcc(acc, reps, dueDays, focus ? spFocus : spNormal);
  }

  return finalizeAcc(acc, resolvedPace, { now, overrideDailyCards, examDate, uncoveredPoints });
}

/**
 * Full-library single-pass mastery forecast projection for `buildRevisionBase()`.
 * Strictly O(N) over cards & attempts (< 1.5ms on 2,000 cards) with compact payload (< 5 KB).
 */
export function libraryPaceForecast(
  state,
  { now = Date.now(), focusMinutes = DEFAULT_FOCUS_MINUTES, breakMinutes = DEFAULT_BREAK_MINUTES } = {},
) {
  const safeState = state && typeof state === "object" ? state : {};
  const decksList = Array.isArray(safeState.decks) ? safeState.decks : [];
  const attemptsList = Array.isArray(safeState.attempts) ? safeState.attempts : [];

  const pace = extractLearnerPace(attemptsList, { now, focusMinutes, breakMinutes });
  const outcome = latestOutcomes(attemptsList);
  const spNormal = spacingProfile(safeState.settings, { isFocus: false });
  const spFocus = spacingProfile(safeState.settings, { isFocus: true });
  const rules = courseActivityRules(safeState);
  const known = courseKnown(knownCourseNames(safeState));
  const dayOf = makeLocalDayFn(now);
  const today = dayOf(now);
  const coursesArr = Array.isArray(safeState.courses) ? safeState.courses : [];
  const anyFocusTopics = coursesArr.some((c) => Array.isArray(c?.focusTopics) && c.focusTopics.length > 0);
  const anyExamDates = coursesArr.some((c) => typeof c?.exam?.date === "string" && c.exam.date.length === 10);
  const focusTopicsByCourse = new Map();
  const focusSetFor = (courseName) => {
    if (!anyFocusTopics || !courseName) return null;
    if (focusTopicsByCourse.has(courseName)) return focusTopicsByCourse.get(courseName);
    const topics = courseFocusTopics(safeState, courseName);
    const set = topics && topics.length ? new Set(topics) : null;
    focusTopicsByCourse.set(courseName, set);
    return set;
  };
  const examDateByCourse = new Map();
  const examDateFor = (courseName) => {
    if (!anyExamDates || !courseName) return null;
    if (examDateByCourse.has(courseName)) return examDateByCourse.get(courseName);
    const date = courseExamByName(safeState, courseName)?.date ?? null;
    examDateByCourse.set(courseName, date);
    return date;
  };

  const libAcc = createScopeAcc();
  const courseAccs = new Map();
  const decksOut = {};

  const getCourseAcc = (name) => {
    let acc = courseAccs.get(name);
    if (!acc) {
      acc = createScopeAcc();
      courseAccs.set(name, acc);
    }
    return acc;
  };

  for (let d = 0; d < decksList.length; d++) {
    const deck = decksList[d];
    if (!deck || deck.archived || deck.systemKind) continue;
    const cards = Array.isArray(deck.cards) ? deck.cards : [];
    const deckAcc = createScopeAcc();
    const deckCourse = courseOf(deck);
    const active = rules.deckActive(deck);
    const focusTopics = focusSetFor(deckCourse);
    // Parent courses include active descendant decks; a parked course still accumulates its own decks when viewed directly.
    const targetCourseAccs = [];
    if (deckCourse) {
      const ancestors = courseAncestors(deckCourse, known);
      for (let a = 0; a < ancestors.length; a++) {
        const ancestor = ancestors[a];
        if (active || ancestor === deckCourse) targetCourseAccs.push(getCourseAcc(ancestor));
      }
    } else if (active) {
      targetCourseAccs.push(getCourseAcc(""));
    }

    for (let c = 0; c < cards.length; c++) {
      const card = cards[c];
      if (!card || card.suspended) continue;
      const lastGrade = outcome(deck.id, card.id);
      const reps = cardSpacedReps(card, lastGrade);
      let dueDays = 0;
      if (reps > 0 && reps < TARGET_SPACED_REPS && card.review?.due_at) {
        const dueMs = Date.parse(card.review.due_at);
        if (Number.isFinite(dueMs)) dueDays = Math.max(0, dayOf(dueMs) - today);
      }
      const focusCard = card.focus === true || (focusTopics !== null && focusTopics.has(card.topic));
      const sp = focusCard ? spFocus : spNormal;

      addCardToAcc(deckAcc, reps, dueDays, sp);
      if (active && !deck.sample) addCardToAcc(libAcc, reps, dueDays, sp);
      for (let k = 0; k < targetCourseAccs.length; k++) {
        addCardToAcc(targetCourseAccs[k], reps, dueDays, sp);
      }
    }

    const deckExam = examDateFor(deckCourse);
    decksOut[deck.id] = compactEntry(finalizeAcc(deckAcc, pace, { now, examDate: deckExam }));
  }

  const coursesOut = {};
  for (const [name, acc] of courseAccs.entries()) {
    const examDate = examDateFor(name);
    coursesOut[name] = compactEntry(finalizeAcc(acc, pace, { now, examDate }));
  }

  return {
    asOf: localDateIso(now, 0),
    pace,
    spacing: { normal: spNormal.totalDays, focus: spFocus.totalDays },
    library: compactEntry(finalizeAcc(libAcc, pace, { now })),
    courses: coursesOut,
    decks: decksOut,
  };
}

const TODAY_MIN_ELAPSED_MS = 3_000;
const TODAY_MAX_ELAPSED_MS = 180_000;

function medianOfSorted(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compact (~100 B) full-history summary for `today-pace.js` (#1323-1/#1323-5),
 * computed once per library revision + local day in `buildRevisionBase()` so
 * daily goals > 100 (or 100 after undo/prerequisite credits) never clip at 100.
 */
export function todayPaceSummary(attempts = [], { now = Date.now() } = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const dayOf = makeLocalDayFn(now);
  const today = dayOf(now);
  let todayCount = 0;
  const todayElapsed = [];
  const priorWeekElapsed = [];

  for (let i = 0; i < list.length; i++) {
    const attempt = list[i];
    if (!isActiveAttempt(attempt) || attempt.implicit || isImportedAttempt(attempt)) continue;
    const rawTs = attempt.timestamp ?? attempt.at;
    const ts = typeof rawTs === "number" ? rawTs : Date.parse(rawTs);
    if (!Number.isFinite(ts)) continue;
    const day = dayOf(ts);
    const age = today - day;
    if (age < 0) continue;
    const rawElapsed = attempt.assessment === 'oral' ? NaN : Number(attempt.elapsed_ms);
    const elapsed = Number.isFinite(rawElapsed) && rawElapsed > 0
      ? Math.min(TODAY_MAX_ELAPSED_MS, Math.max(TODAY_MIN_ELAPSED_MS, rawElapsed))
      : null;
    if (age === 0) {
      todayCount += 1;
      if (elapsed !== null) todayElapsed.push(elapsed);
    } else if (age <= 7 && elapsed !== null) {
      priorWeekElapsed.push(elapsed);
    }
  }

  return {
    date: localDateIso(now, 0),
    todayCount,
    todaySampleCount: todayElapsed.length,
    todayMedianMs: medianOfSorted(todayElapsed),
    weekSampleCount: priorWeekElapsed.length,
    weekMedianMs: medianOfSorted(priorWeekElapsed),
  };
}
