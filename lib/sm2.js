/* The review scheduler: FSRS-6 powered by `ts-fsrs` (MIT), pure functions with
   no Node imports so the scheduler, answer-button interval hints and Settings
   preview run the exact same code. lib/domain.js re-exports it. (The file keeps
   its historical name so every import stays unchanged; it held SM-2 up to 3.7.)

   Scheduling runs `ts-fsrs` in long-term whole-day mode (`enable_short_term: false`)
   with two deliberate StudyHub invariants preserved on top of `ts-fsrs`:
   1. Local calendar days: `dayDiff` counts whole days on the learner's local
      calendar (rather than UTC), so 07:50 and 08:10 in Beijing are the same day
      and 23:00 -> 07:00 the next morning are two days (tests/fsrs-local-days.test.mjs).
   2. Hard maximum interval cap: `maximum_interval` caps every answer (including
      Good/Easy when ts-fsrs's monotonic ordering would otherwise push them past it).

   Fuzzing (`enable_fuzz`) defaults to `false` for deterministic tests and
   button hints, and `previewSchedule` always forces `enable_fuzz: false`.
   Real reviews can opt into `enable_fuzz: true` via settings.
   Same-day repeats (`elapsed === 0`) always run with `enable_short_term: false`
   and default to `isolate_same_day: true` (opt out via `isolate_same_day: false`):
   - Same-day passes after an earlier pass today freeze `difficulty` (preventing
     Difficulty Hell), preserve `stability` / `interval_days` / `due_at` / peak
     `last_grade` (no regression, e.g. Easy -> Good stays mastered), and keep
     `spaced_reps` & `repetitions` capped at +1 per local calendar day.
   - Same-day passes after an earlier failure today apply a bounded short-term
     stability recovery and schedule next-day (1-2 days) verification.
   - Multiple failures on the same local calendar day cap `lapses` to at most +1
     per day without repeatedly crushing `stability` or spiking `difficulty`.

   A review keeps every field the rest of the library reads (repetitions /
   interval_days / ease_factor / due_at) and adds the FSRS memory state. A review
   written by SM-2 builds migrates lazily at its next answer.

   Exam alignment (#882): when `exam_date` is set on a later local day, a gap
   reaching it becomes due at local 00:00 of the exam day while `interval_days`
   keeps FSRS's earned gap and `unaligned_due_at` records the original due date. */

import {
  FSRS6_DEFAULT_DECAY,
  Rating,
  S_MAX,
  S_MIN,
  State,
  clamp,
  clipParameters,
  computeDecayFactor,
  createEmptyCard,
  default_w,
  fsrs,
  generatorParameters,
  roundTo,
} from "ts-fsrs";
import { preserveUnknownKeys } from "./preserve-unknown-keys.js";

const DAY_MS = 864e5;
const RATING_BY_NUM = Object.freeze({
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
  4: Rating.Easy,
});

/** FSRS-6 default parameters w0..w20 (ts-fsrs default_w). */
export const FSRS6_WEIGHTS = Object.freeze([...default_w]);

/** The two numbers a learner may change, saved flat in the library settings
    beside `generation` / `dailyRecap` / `practice`. */
export const defaults = Object.freeze({
  request_retention: 0.9, // the chance of still recalling a question when it comes back
  maximum_interval: S_MAX, // days
});
/** The allowed range of each, shared with the Settings pane. */
export const LIMITS = Object.freeze({
  request_retention: Object.freeze({ min: 0.7, max: 0.97 }),
  maximum_interval: Object.freeze({ min: 1, max: S_MAX }),
});

/** Target-recall boost for highlighted ("重点") cards: ~2x review frequency at default 0.90 -> 0.94 while keeping pure FSRS-6 stability & difficulty. */
export const FOCUS_RETENTION_BOOST = 0.04;

/** Effective scheduling settings for one question: raises target recall when `isFocus` is true (unless `focus_boost === false`). */
export function focusScheduleSettings(c = defaults, { isFocus = false } = {}) {
  if (!isFocus || (c && typeof c === "object" && c.focus_boost === false)) return c;
  const checked = checkSettings(c ?? defaults);
  const boosted = Math.min(LIMITS.request_retention.max, Math.round((checked.request_retention + FOCUS_RETENTION_BOOST) * 1000) / 1000);
  return boosted > checked.request_retention ? { ...checked, request_retention: boosted } : checked;
}

/** The SM-2 keys FSRS replaced: ignored on read, dropped on the next save. */
export const LEGACY_KEYS = Object.freeze(["minimum_ease_factor", "initial_ease_factor", "first_interval_days", "second_interval_days"]);

/** The local calendar date of an instant, as a day number: the learner's own day, in the time zone of the machine
    StudyHub runs on (the learner's). */
const localDay = (ms) => {
  const day = new Date(ms);
  return Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) / DAY_MS;
};
/** Whole local calendar days between two instants. ts-fsrs (dateDiffInDays) counts UTC days; this is the one deliberate
    change: "the same day" is the learner's day, so answering again at 08:10 after 07:50 in Beijing is the same day,
    and 23:00 then 07:00 the next morning are two (tests/fsrs-local-days.test.mjs). */
const dayDiff = (fromMs, toMs) => Math.round(localDay(toMs) - localDay(fromMs));

/** The 0–5 grade every call site passes, as an FSRS rating 1–4: 0–2 Again, 3 (勉强答对) Hard, 4 (熟练) Good,
    5 (轻松掌握) Easy. The passing line (grade >= 3) is where it always was; an auto-graded right answer is 4, Good, or 3, Hard, when the hint was used (lib/study-progress.js autoGradeOf). */
export const ratingOfGrade = (grade) => (grade <= 2 ? 1 : grade === 3 ? 2 : grade === 4 ? 3 : 4);

/** Ease is no longer the schedule's own number; this keeps a sane one on the review for older readers.
    The inverse of the migration map below (ease 1.3 ↔ difficulty 10, ease 3.5 ↔ difficulty 1). */
const easeFromDifficulty = (d) => Math.round(clamp(1.3 + ((10 - d) * 2.2) / 9, 1.3, 3.5) * 100) / 100;
const difficultyFromEase = (ease) => clamp(10 - ((ease - 1.3) * 9) / 2.2, 1, 10);

/** The weights in play: the settings' own `w` (21 numbers, for a learner who optimised them elsewhere), else the FSRS-6 defaults. */
export function weightsOf(c) {
  const w = Array.isArray(c?.w) ? c.w : FSRS6_WEIGHTS;
  if (w.length !== 21 || w.some((x) => !Number.isFinite(x)))
    throw new Error("Invalid scheduling value: w (21 finite FSRS-6 weights)");
  return w;
}

/** The scheduling settings, checked: a missing value takes its default, a value outside its range fails before the
    library changes, a whole-day maximum typed as 365.0 is rounded, and the old SM-2 keys are dropped. Other keys
    (generation, practice, ...) pass through untouched: the library keeps all its settings in one object. */
export function checkSettings(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("Invalid scheduling settings");
  const retention = Number(c.request_retention ?? defaults.request_retention);
  const { min: rMin, max: rMax } = LIMITS.request_retention;
  if (!Number.isFinite(retention) || retention < rMin || retention > rMax)
    throw new Error(`Invalid scheduling value: request_retention (${rMin}–${rMax})`);
  const maximum = Number(c.maximum_interval ?? defaults.maximum_interval);
  const { min: mMin, max: mMax } = LIMITS.maximum_interval;
  if (!Number.isFinite(maximum) || maximum < mMin || maximum > mMax)
    throw new Error(`Invalid scheduling value: maximum_interval (${mMin}–${mMax} days)`);
  if (c.w !== undefined) weightsOf(c);
  if (c.exam_alignment !== undefined && typeof c.exam_alignment !== "boolean")
    throw new Error("Invalid scheduling value: exam_alignment (true or false)");
  if (c.enable_fuzz !== undefined && typeof c.enable_fuzz !== "boolean")
    throw new Error("Invalid scheduling value: enable_fuzz (true or false)");
  if (c.isolate_same_day !== undefined && typeof c.isolate_same_day !== "boolean")
    throw new Error("Invalid scheduling value: isolate_same_day (true or false)");
  const known = {
    request_retention: retention,
    maximum_interval: Math.round(maximum),
    ...(c.w !== undefined ? { w: [...c.w] } : {}),
    ...(c.exam_alignment !== undefined ? { exam_alignment: c.exam_alignment } : {}),
    ...(c.enable_fuzz !== undefined ? { enable_fuzz: c.enable_fuzz } : {}),
    ...(c.isolate_same_day !== undefined ? { isolate_same_day: c.isolate_same_day } : {}),
  };
  return preserveUnknownKeys(c, known, LEGACY_KEYS);
}

/** Build a configured ts-fsrs engine in long-term whole-day mode. */
function buildEngine(c, { allowFuzz = false } = {}) {
  const maximumInterval = Math.max(1, Math.round(c.maximum_interval));
  const enableFuzz = allowFuzz && c.enable_fuzz === true;
  const params = generatorParameters({
    request_retention: c.request_retention,
    maximum_interval: maximumInterval,
    w: [...weightsOf(c)],
    enable_fuzz: enableFuzz,
    enable_short_term: false,
    learning_steps: [],
    relearning_steps: [],
  });
  return { engine: fsrs(params), maximumInterval };
}

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** Cross-day effective passing streak on a review (lazily initializes from `repetitions` on legacy cards). */
export function spacedRepsOf(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return 0;
  if (Number.isFinite(review.spaced_reps) && review.spaced_reps >= 0) return Math.floor(review.spaced_reps);
  return count(review.repetitions);
}

/** Whether `review` records a passing answer on the same local calendar day as `now`. */
export function isPassedToday(review, now = Date.now()) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return false;
  const ts = review.last_review ? Date.parse(review.last_review) : NaN;
  if (!Number.isFinite(ts)) return false;
  return dayDiff(ts, instant(now)) === 0 && spacedRepsOf(review) > 0;
}

/** The memory state a stored review stands for at `now`: its FSRS state when it has one; otherwise the SM-2 interval
    and ease it carries (any review with an interval: answered at least once); otherwise a new question. */
export function memoryState(before, now = Date.now()) {
  const b = before && typeof before === "object" && !Array.isArray(before) ? before : {};
  const repetitions = count(b.repetitions);
  const spacedReps = spacedRepsOf(b);
  const lastGrade = Number.isInteger(b.last_grade) && b.last_grade >= 0 && b.last_grade <= 5 ? b.last_grade : null;
  const lastLapse = b.last_lapse_at ? Date.parse(b.last_lapse_at) : NaN;
  const lastLapseAt = Number.isFinite(lastLapse) ? lastLapse : null;
  const intervalDays = Number(b.interval_days);
  const storedInterval = Number.isFinite(intervalDays) && intervalDays > 0 ? Math.round(intervalDays) : 0;
  const stability = Number(b.stability), difficulty = Number(b.difficulty);
  if (Number.isFinite(stability) && stability > 0 && Number.isFinite(difficulty) && difficulty > 0) {
    const last = b.last_review ? Date.parse(b.last_review) : NaN;
    return {
      stability: clamp(stability, S_MIN, S_MAX),
      difficulty: clamp(difficulty, 1, 10),
      isNew: false,
      reps: Number.isFinite(b.reps) && b.reps >= 0 ? Math.floor(b.reps) : repetitions,
      lapses: count(b.lapses),
      repetitions,
      spacedReps,
      intervalDays: storedInterval,
      lastGrade,
      lastLapseAt,
      lastReview: Number.isFinite(last) ? last : null,
    };
  }
  // An exam may have moved due_at earlier (lib/exam-alignment.js); the SM-2 due date it came from is unaligned_due_at.
  const ownDue = b.unaligned_due_at ?? b.due_at;
  const due = ownDue ? Date.parse(ownDue) : NaN;
  if (Number.isFinite(intervalDays) && intervalDays > 0) {
    const ease = Number.isFinite(b.ease_factor) && b.ease_factor > 0 ? b.ease_factor : 2.5;
    return {
      stability: clamp(intervalDays, S_MIN, S_MAX),
      difficulty: difficultyFromEase(ease),
      isNew: false,
      reps: repetitions,
      lapses: 0,
      repetitions,
      spacedReps,
      intervalDays: storedInterval,
      lastGrade,
      lastLapseAt,
      // SM-2 stored due = last answer + interval days, so the last answer is derived from it. Without a usable due date
      // (a legacy import can lack one) the question is taken as due now: its streak and interval are kept.
      lastReview: (Number.isFinite(due) ? due : now) - clamp(intervalDays, S_MIN, S_MAX) * DAY_MS,
    };
  }
  return {
    stability: 0,
    difficulty: 0,
    isNew: true,
    reps: 0,
    lapses: 0,
    repetitions: 0,
    spacedReps: 0,
    intervalDays: 0,
    lastGrade: null,
    lastLapseAt: null,
    lastReview: null,
  };
}

/** A question nobody has answered yet: the same four fields as ever (memoryState reads it as new), so a new card, and every
    prompt or export that carries one, is byte for byte what it was. The argument (the library settings) is accepted for the
    old call sites and not needed. */
export const initialReview = () => ({
  repetitions: 0,
  interval_days: 0,
  ease_factor: 2.5,
  due_at: null,
});

/** Whole local days from the last review to `now`, as an answer at `now` counts them: 0 for a new question, and 0 for one whose last
    review is unknown (an FSRS record without `last_review`). */
const elapsedDays = (cur, now) => (cur.isNew || cur.lastReview === null ? 0 : Math.max(0, dayDiff(cur.lastReview, now)));

/** Convert StudyHub's memory state into a ts-fsrs Card whose UTC day difference matches local `elapsed`. */
function toTsFsrsCard(cur, reviewDate, elapsed) {
  if (cur.isNew) return createEmptyCard(reviewDate);
  const lastReviewDate = new Date(reviewDate.getTime() - elapsed * DAY_MS);
  return {
    ...createEmptyCard(lastReviewDate),
    state: State.Review,
    stability: cur.stability,
    difficulty: cur.difficulty,
    reps: cur.reps,
    lapses: cur.lapses,
    elapsed_days: elapsed,
    scheduled_days: Math.max(1, Math.round(cur.stability)),
    last_review: lastReviewDate,
    due: reviewDate,
  };
}

/** The four candidate outcomes of one answer at `now`, computed by ts-fsrs in long-term mode with local-calendar elapsed days. */
function candidates(cur, now, c, { allowFuzz = false } = {}) {
  const { engine, maximumInterval } = buildEngine(c, { allowFuzz });
  const elapsed = elapsedDays(cur, now);
  // Map the learner's local calendar date to UTC 00:00 + sub-day offset so ts-fsrs's UTC dayDiff equals local dayDiff
  // while preserving distinct sub-day timestamps for deterministic fuzz seeding when `enable_fuzz` is explicitly enabled.
  const localMidnightMs = localDay(now) * DAY_MS;
  const subDayMs = ((now - new Date(now).getTimezoneOffset() * 60e3) % DAY_MS + DAY_MS) % DAY_MS;
  const reviewDate = new Date(localMidnightMs + subDayMs);
  const card = toTsFsrsCard(cur, reviewDate, elapsed);
  const preview = engine.repeat(card, reviewDate);
  const cap = (days) => Math.min(days, maximumInterval);
  const sameDay = !cur.isNew && cur.lastReview !== null && elapsed === 0;
  const isolateSameDay = sameDay && c.isolate_same_day !== false;
  const alreadyPassedToday = sameDay && (cur.spacedReps > 0 || cur.repetitions > 0);
  const lastFailedToday = sameDay && !alreadyPassedToday;
  const alreadyLapsedToday = sameDay && (cur.lastLapseAt !== null ? dayDiff(cur.lastLapseAt, now) === 0 : lastFailedToday);
  const w = weightsOf(c);
  const next = {};
  const interval = {};
  for (const g of [1, 2, 3, 4]) {
    const outCard = preview[RATING_BY_NUM[g]].card;
    if (isolateSameDay && alreadyPassedToday && g >= 2) {
      // Same-day repeat pass: freeze difficulty (no Difficulty Hell) and guard stability/interval against regression.
      next[g] = { difficulty: cur.difficulty, stability: cur.stability };
      interval[g] = cur.intervalDays > 0 ? cap(cur.intervalDays) : cap(outCard.scheduled_days);
    } else if (isolateSameDay && lastFailedToday && g >= 2) {
      // Same-day recovery after earlier failure: bounded short-term stability recovery + next-day (1-2d) verification.
      const targetS = g === 2 ? roundTo(w[1] * 0.5, 8) : g === 3 ? roundTo(w[2] * 0.65, 8) : roundTo(w[2] * 0.75, 8);
      next[g] = { difficulty: cur.difficulty, stability: clamp(Math.max(cur.stability, targetS), S_MIN, S_MAX) };
      interval[g] = cap(g === 4 ? 2 : 1);
    } else if (isolateSameDay && alreadyLapsedToday && g === 1) {
      // Same-day repeat failure: cap lapses at 1/day without repeatedly crushing stability or spiking difficulty.
      next[g] = { difficulty: cur.difficulty, stability: cur.stability };
      interval[g] = cap(1);
    } else {
      next[g] = { difficulty: outCard.difficulty, stability: outCard.stability };
      interval[g] = cap(outCard.scheduled_days);
    }
  }
  return { elapsed, next, interval, isolateSameDay, alreadyPassedToday, alreadyLapsedToday };
}

/** Whole local days from the answer at `now` to the exam day `exam_date` (YYYY-MM-DD on the learner's calendar), or null
    without one. */
const daysToExam = (examDate, now) => {
  if (typeof examDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) return null;
  const [year, month, day] = examDate.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS - localDay(now));
};
/** The gap an answer at `now` really gets: FSRS's `interval`, or the days left to an exam on a later day when that is less. */
const alignedGap = (interval, examDays) => (examDays !== null && examDays >= 1 ? Math.min(interval, examDays) : interval);
/** Local 00:00 of the exam day (from the calendar fields, so a daylight-saving change in between moves nothing): a question
    due then is served all day long, whatever the time of the answer that scheduled it. The exam-day band (lib/exam-day-band.js)
    projects recall to this same instant. */
export const examDayStart = (examDate) => {
  const [year, month, day] = examDate.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
};

const checkAnswer = (grade, timestamp) => {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) throw new Error("Grade must be an integer from 0 to 5");
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("Invalid timestamp");
};

export function schedule(before, grade, timestamp, c = defaults) {
  const settings = checkSettings(c);
  checkAnswer(grade, timestamp);
  const now = Date.parse(timestamp);
  const cur = memoryState(before, now);
  const rating = ratingOfGrade(grade);
  const { elapsed, next, interval: intervals, isolateSameDay, alreadyPassedToday, alreadyLapsedToday } = candidates(cur, now, settings, { allowFuzz: settings.enable_fuzz === true });
  const interval = intervals[rating], graded = next[rating];
  const prevUnalignedDue = before?.unaligned_due_at ? Date.parse(before.unaligned_due_at) : NaN;
  const prevDue = before?.due_at ? Date.parse(before.due_at) : NaN;
  const prevBaseDue = Number.isFinite(prevUnalignedDue) ? prevUnalignedDue : prevDue;
  const preserveDue = isolateSameDay && alreadyPassedToday && rating >= 2 && cur.intervalDays <= settings.maximum_interval;
  const due = preserveDue && Number.isFinite(prevBaseDue)
    ? Math.max(now + interval * DAY_MS, prevBaseDue)
    : now + interval * DAY_MS;
  const examDays = daysToExam(settings.exam_date, now);
  // A gap that reaches the exam day is due from the start of that day; the date FSRS gave is kept only when it was later.
  const aligned = examDays !== null && examDays >= 1 && interval >= examDays ? examDayStart(settings.exam_date) : null;
  const moved = aligned !== null && localDay(due) > localDay(aligned);
  // A lapse is a question that had been learned and was then forgotten (a new question answered wrong is not one),
  // capped to at most 1 per local calendar day under default same-day isolation.
  const lapses = rating === 1 && !cur.isNew && !(isolateSameDay && alreadyLapsedToday) ? cur.lapses + 1 : cur.lapses;
  // Cross-day effective passing streak: resets to 0 on failure and advances at most once per local calendar day.
  const spacedReps = grade < 3 ? 0 : alreadyPassedToday ? Math.max(1, cur.spacedReps) : cur.spacedReps + 1;
  // Passing streak kept in lockstep with cross-day passes under default same-day isolation (prevents same-day inflation).
  const repetitions = grade < 3 ? 0 : (isolateSameDay && alreadyPassedToday) ? Math.max(1, cur.repetitions) : cur.repetitions + 1;
  // Peak passing grade on the current day so same-day Good/Hard after Easy(5) never downgrades cardLevel().
  const lastGrade = grade < 3 ? grade : (isolateSameDay && alreadyPassedToday && cur.lastGrade !== null) ? Math.max(cur.lastGrade, grade) : grade;
  const lastLapseAt = rating === 1
    ? new Date(now).toISOString()
    : (isolateSameDay && alreadyLapsedToday)
      ? new Date(cur.lastLapseAt ?? cur.lastReview).toISOString()
      : null;
  return {
    algorithm: "fsrs-6",
    stability: graded.stability,
    difficulty: graded.difficulty,
    reps: cur.reps + 1,
    lapses,
    repetitions,
    spaced_reps: spacedReps,
    last_grade: lastGrade,
    interval_days: interval,
    ease_factor: easeFromDifficulty(graded.difficulty),
    elapsed_days: elapsed,
    last_review: new Date(now).toISOString(),
    due_at: new Date(aligned ?? due).toISOString(),
    ...(lastLapseAt ? { last_lapse_at: lastLapseAt } : {}),
    ...(moved ? { unaligned_due_at: new Date(due).toISOString() } : {}),
    // The maximum this gap was capped by, when it is below the default: lib/mastery.js lowers its 熟悉 / 已掌握 lines to
    // it, so a small maximum (an exam close by) never makes 已掌握 unreachable.
    ...(settings.maximum_interval < S_MAX ? { maximum_interval: settings.maximum_interval } : {}),
  };
}

/** The days until the next review for each grade 0–5 if the question were answered at `timestamp`: what the answer
    buttons show. Matches `schedule` deterministically (`enable_fuzz: false` unless explicitly enabled on `c`). */
export function nextIntervals(before, timestamp, c = defaults) {
  const settings = checkSettings(c);
  checkAnswer(0, timestamp);
  const now = Date.parse(timestamp);
  const { interval } = candidates(memoryState(before, now), now, settings, { allowFuzz: settings.enable_fuzz === true });
  const examDays = daysToExam(settings.exam_date, now);
  return [0, 1, 2, 3, 4, 5].map((grade) => alignedGap(interval[ratingOfGrade(grade)], examDays));
}

/** An instant in milliseconds, from a number, an ISO time or a Date; anything else fails. */
const instant = (at) => {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error("Invalid timestamp");
  return ms;
};

/**
 * Retrievability under one settings object, built once: `(review, at) => R`, for a pass that asks it of many questions
 * (it builds the model once, not once per question). R is the chance of still recalling the question at `at`
 * (milliseconds, an ISO time or a Date): ts-fsrs's forgetting_curve over whole local days since the last review.
 */
export function retrievabilityAt(c = defaults) {
  const clipped = clipParameters([...weightsOf(c)], 0, false);
  const { decay, factor } = computeDecayFactor(clipped[20] ?? FSRS6_DEFAULT_DECAY);
  return (review, at = Date.now()) => {
    const now = instant(at);
    const cur = memoryState(review, now);
    if (cur.isNew || cur.lastReview === null) return 0;
    return roundTo(Math.pow(1 + (factor * elapsedDays(cur, now)) / cur.stability, decay), 8);
  };
}

/** The chance of recalling one question at `at` under the library settings `c` (retrievabilityAt). A pass over many questions
    builds retrievabilityAt(c) once instead. */
export const retrievability = (review, at = Date.now(), c = defaults) => retrievabilityAt(c)(review, at);

/**
 * The review days a new card would get when every review is answered with the
 * same grade on its due day, replayed through `schedule` with `enable_fuzz: false`
 * for deterministic Settings previews:
 * [{ review, interval, day, ease }] where `day` counts from the first study.
 * null when the settings are invalid (the form shows no preview until they are).
 */
export function previewSchedule(settings, { grade = 4, reviews = 6 } = {}) {
  try {
    const resolved = { ...checkSettings(settings), enable_fuzz: false };
    let review = initialReview(), at = "2026-01-01T00:00:00.000Z", day = 0;
    const points = [];
    for (let n = 1; n <= reviews; n++) {
      review = schedule(review, grade, at, resolved);
      day += review.interval_days;
      points.push({ review: n, interval: review.interval_days, day, ease: review.ease_factor });
      at = review.due_at;
    }
    return points;
  } catch {
    return null;
  }
}
