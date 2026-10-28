/* The review scheduler: FSRS-6, pure functions with no Node imports, so the
   scheduler, the answer buttons' interval hints and the Settings preview run
   the same code. lib/domain.js re-exports it. (The file keeps its old name so
   every import stays as it was; it held SM-2 up to 3.7.)
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   Formulas, the 21 default weights, the clamps and the four-candidate interval
   ordering follow ts-fsrs 5.4.2 (FSRS-6) in its long-term mode without fuzz
   (enable_short_term = false, enable_fuzz = false): whole days, the shape this
   library stores. tests/fsrs-parity.test.mjs replays random histories through
   this module and ts-fsrs itself and compares them. Two intended differences:
   days are counted on the learner's local calendar (ts-fsrs counts UTC days, so
   in Beijing 07:50 and 08:10 would be two days), and the maximum interval caps
   every answer.

   FSRS keeps a memory state per question: stability (the days after which the
   chance of still recalling it falls to 90%) and difficulty (1–10). Each answer
   updates both from how long it has really been since the last review, so a
   review answered early teaches the schedule less than one answered on time.
   The next review is placed where the predicted recall falls to the learner's
   target (request_retention).

   A review keeps every field the rest of the library reads (repetitions /
   interval_days / ease_factor / due_at: lib/mastery.js, lib/legacy.js, and an
   older build reading the library after a downgrade) and adds the FSRS memory
   state. A review written by the SM-2 builds is migrated lazily, at its next
   answer: its interval becomes the starting stability and its ease the
   starting difficulty. Until then it is read as it was. */

const S_MIN = 1e-3;
const S_MAX = 36500;
const INIT_S_MAX = 100;
const W17_W18_CEILING = 2;
const FSRS6_DEFAULT_DECAY = 0.1542;
const DAY_MS = 864e5;

/** FSRS-6 default parameters w0..w20 (ts-fsrs default_w). */
export const FSRS6_WEIGHTS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  FSRS6_DEFAULT_DECAY,
]);

/** The two numbers a learner may change, saved flat in the library settings
    beside `generation` / `dailyRecap` / `practice`. */
export const defaults = Object.freeze({
  request_retention: 0.9, // the chance of still recalling a question when it comes back
  maximum_interval: 36500, // days
});
/** The allowed range of each, shared with the Settings pane. */
export const LIMITS = Object.freeze({
  request_retention: Object.freeze({ min: 0.7, max: 0.97 }),
  maximum_interval: Object.freeze({ min: 1, max: S_MAX }),
});

/** The SM-2 keys FSRS replaced: ignored on read, dropped on the next save. */
export const LEGACY_KEYS = Object.freeze(["minimum_ease_factor", "initial_ease_factor", "first_interval_days", "second_interval_days"]);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const roundTo = (num, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
};
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
    5 (轻松掌握) Easy. The passing line (grade >= 3) is where it always was; an auto-graded right answer is 4, Good. */
export const ratingOfGrade = (grade) => (grade <= 2 ? 1 : grade === 3 ? 2 : grade === 4 ? 3 : 4);

/** Ease is no longer the schedule's own number; this keeps a sane one on the review for older readers.
    The inverse of the migration map below (ease 1.3 ↔ difficulty 10, ease 3.5 ↔ difficulty 1). */
const easeFromDifficulty = (d) => Math.round(clamp(1.3 + ((10 - d) * 2.2) / 9, 1.3, 3.5) * 100) / 100;
const difficultyFromEase = (ease) => clamp(10 - ((ease - 1.3) * 9) / 2.2, 1, 10);

/** ts-fsrs clipParameters with enable_short_term = false. */
const clipWeights = (w) => {
  const RANGES = [
    [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX], [S_MIN, INIT_S_MAX],
    [1, 10], [S_MIN, 4], [S_MIN, 4], [S_MIN, 0.75],
    [0, 4.5], [0, 0.8], [S_MIN, 3.5], [S_MIN, 5],
    [S_MIN, 0.25], [S_MIN, 0.9], [0, 4], [0, 1],
    [1, 6], [0, W17_W18_CEILING], [0, W17_W18_CEILING], [0, 0.8], [0.1, 0.8],
  ];
  return RANGES.map(([min, max], i) => clamp(w[i], min, max));
};

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
  const out = { ...c };
  for (const key of LEGACY_KEYS) delete out[key];
  const retention = Number(out.request_retention ?? defaults.request_retention);
  const { min: rMin, max: rMax } = LIMITS.request_retention;
  if (!Number.isFinite(retention) || retention < rMin || retention > rMax)
    throw new Error(`Invalid scheduling value: request_retention (${rMin}–${rMax})`);
  const maximum = Number(out.maximum_interval ?? defaults.maximum_interval);
  const { min: mMin, max: mMax } = LIMITS.maximum_interval;
  if (!Number.isFinite(maximum) || maximum < mMin || maximum > mMax)
    throw new Error(`Invalid scheduling value: maximum_interval (${mMin}–${mMax} days)`);
  if (out.w !== undefined) weightsOf(out);
  out.request_retention = retention;
  out.maximum_interval = Math.round(maximum);
  return out;
}

/** The whole FSRS-6 model for one settings object. Pure; no state carried. */
function algorithm(c) {
  const w = clipWeights(weightsOf(c));
  const decay = -w[20];
  const factor = roundTo(Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1, 8);
  const intervalModifier = roundTo((Math.pow(c.request_retention, 1 / decay) - 1) / factor, 8);
  const maximumInterval = Math.max(1, Math.round(c.maximum_interval));

  const initStability = (g) => Math.max(w[g - 1], 0.1);
  const initDifficulty = (g) => roundTo(w[4] - Math.exp((g - 1) * w[5]) + 1, 8);
  /** The chance of recall after `elapsedDays` with this stability. */
  const forgettingCurve = (elapsedDays, stability) =>
    roundTo(Math.pow(1 + (factor * elapsedDays) / stability, decay), 8);
  /** I(r,S) = (r^(1/DECAY) - 1) / FACTOR * S, at least 1 day, at most the maximum interval. */
  const nextInterval = (s) => Math.min(Math.max(1, Math.round(s * intervalModifier)), maximumInterval);
  const nextRecallStability = (d, s, r, g) => {
    const hardPenalty = g === 2 ? w[15] : 1;
    const easyBonus = g === 4 ? w[16] : 1;
    return roundTo(
      clamp(
        s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) *
          (Math.exp((1 - r) * w[10]) - 1) * hardPenalty * easyBonus),
        S_MIN, S_MAX,
      ), 8,
    );
  };
  const nextForgetStability = (d, s, r) =>
    roundTo(
      clamp(
        w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]),
        S_MIN, S_MAX,
      ), 8,
    );
  const nextDifficulty = (d, g) => {
    const deltaD = -w[6] * (g - 3);
    const damped = d + roundTo((deltaD * (10 - d)) / 9, 8);
    return clamp(roundTo(w[7] * initDifficulty(4) + (1 - w[7]) * damped, 8), 1, 10);
  };
  /** FSRSAlgorithm.next_state with enable_short_term = false. */
  const nextState = (difficulty, stability, t, g, r) => {
    if (difficulty === 0 && stability === 0)
      return { difficulty: clamp(initDifficulty(g), 1, 10), stability: initStability(g) };
    if (difficulty < 1 || stability < S_MIN)
      throw new Error(`Invalid memory state { difficulty: ${difficulty}, stability: ${stability} }`);
    const retrievability = typeof r === "number" ? r : forgettingCurve(t, stability);
    const nextStability =
      g === 1
        // A lapse: the forgetting formula, never above the current stability.
        ? clamp(roundTo(stability, 8), S_MIN, nextForgetStability(difficulty, stability, retrievability))
        : nextRecallStability(difficulty, stability, retrievability, g);
    return { difficulty: nextDifficulty(difficulty, g), stability: nextStability };
  };
  return { forgettingCurve, nextInterval, nextState, maximumInterval };
}

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** The memory state a stored review stands for at `now`: its FSRS state when it has one; otherwise the SM-2 interval
    and ease it carries (any review with an interval: answered at least once); otherwise a new question. */
export function memoryState(before, now = Date.now()) {
  const b = before && typeof before === "object" && !Array.isArray(before) ? before : {};
  const repetitions = count(b.repetitions);
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
      lastReview: Number.isFinite(last) ? last : null,
    };
  }
  const intervalDays = Number(b.interval_days);
  const due = b.due_at ? Date.parse(b.due_at) : NaN;
  if (Number.isFinite(intervalDays) && intervalDays > 0) {
    const ease = Number.isFinite(b.ease_factor) && b.ease_factor > 0 ? b.ease_factor : 2.5;
    return {
      stability: clamp(intervalDays, S_MIN, S_MAX),
      difficulty: difficultyFromEase(ease),
      isNew: false,
      reps: repetitions,
      lapses: 0,
      repetitions,
      // SM-2 stored due = last answer + interval days, so the last answer is derived from it. Without a usable due date
      // (a legacy import can lack one) the question is taken as due now: its streak and interval are kept.
      lastReview: (Number.isFinite(due) ? due : now) - clamp(intervalDays, S_MIN, S_MAX) * DAY_MS,
    };
  }
  return { stability: 0, difficulty: 0, isNew: true, reps: 0, lapses: 0, repetitions: 0, lastReview: null };
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

/** The four candidate outcomes of one answer at `now`, ordered Again <= Hard < Good < Easy as ts-fsrs orders them. */
function candidates(cur, now, c) {
  const alg = algorithm(c);
  const elapsed = cur.isNew || cur.lastReview === null ? 0 : Math.max(0, dayDiff(cur.lastReview, now));
  const retrievability = cur.isNew ? undefined : alg.forgettingCurve(elapsed, cur.stability);
  const next = {};
  for (const g of [1, 2, 3, 4]) next[g] = alg.nextState(cur.difficulty, cur.stability, elapsed, g, retrievability);
  let again = alg.nextInterval(next[1].stability);
  let hard = alg.nextInterval(next[2].stability);
  let good = alg.nextInterval(next[3].stability);
  let easy = alg.nextInterval(next[4].stability);
  again = Math.min(again, hard);
  hard = Math.max(hard, again + 1);
  good = Math.max(good, hard + 1);
  easy = Math.max(easy, good + 1);
  // The maximum is a promise to the learner, so it caps every answer. (ts-fsrs lets the ordering above push Good and
  // Easy a day or two past it; the only place this module differs from it, tests/fsrs-parity.test.mjs.)
  const cap = (days) => Math.min(days, alg.maximumInterval);
  return { elapsed, next, interval: { 1: cap(again), 2: cap(hard), 3: cap(good), 4: cap(easy) } };
}

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
  const { elapsed, next, interval: intervals } = candidates(cur, now, settings);
  const interval = intervals[rating], graded = next[rating];
  return {
    algorithm: "fsrs-6",
    stability: graded.stability,
    difficulty: graded.difficulty,
    reps: cur.reps + 1,
    // A lapse is a question that had been learned and was then forgotten (a new question answered wrong is not one).
    lapses: rating === 1 && !cur.isNew ? cur.lapses + 1 : cur.lapses,
    // The passing streak, as before: 0 after a wrong answer, +1 after a right one (lib/mastery.js reads it).
    repetitions: grade < 3 ? 0 : cur.repetitions + 1,
    interval_days: interval,
    ease_factor: easeFromDifficulty(graded.difficulty),
    elapsed_days: elapsed,
    last_review: new Date(now).toISOString(),
    due_at: new Date(now + interval * DAY_MS).toISOString(),
    // The maximum this gap was capped by, when it is below the default: lib/mastery.js lowers its 熟悉 / 已掌握 lines to
    // it, so a small maximum (an exam close by) never makes 已掌握 unreachable.
    ...(settings.maximum_interval < S_MAX ? { maximum_interval: settings.maximum_interval } : {}),
  };
}

/** The days until the next review for each grade 0–5 if the question were answered at `timestamp`: what the answer
    buttons show. The same `schedule`, so a button never promises a different gap from the one the answer gets. */
export function nextIntervals(before, timestamp, c = defaults) {
  const settings = checkSettings(c);
  checkAnswer(0, timestamp);
  const now = Date.parse(timestamp);
  const { interval } = candidates(memoryState(before, now), now, settings);
  return [0, 1, 2, 3, 4, 5].map((grade) => interval[ratingOfGrade(grade)]);
}

/**
 * The review days a new card would get when every review is answered with the
 * same grade on its due day, replayed through `schedule` itself:
 * [{ review, interval, day, ease }] where `day` counts from the first study.
 * null when the settings are invalid (the form shows no preview until they are).
 */
export function previewSchedule(settings, { grade = 4, reviews = 6 } = {}) {
  try {
    const resolved = checkSettings(settings);
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
