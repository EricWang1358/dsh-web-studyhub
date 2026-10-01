/* SM-2 scheduling: pure functions with no Node imports, so the scheduler and
   the Settings preview (WP14) run the same code. lib/domain.js re-exports them. */

export const defaults = Object.freeze({
  minimum_ease_factor: 1.3,
  initial_ease_factor: 2.5,
  first_interval_days: 1,
  second_interval_days: 6,
});
export function checkSettings(c) {
  for (const k of Object.keys(defaults))
    if (!Number.isFinite(c[k]) || c[k] <= 0 || c[k] > 365)
      throw new Error(`Invalid scheduling value: ${k}`);
  if (c.initial_ease_factor < c.minimum_ease_factor)
    throw new Error("Initial ease must be at least minimum ease");
  for (const k of ["first_interval_days", "second_interval_days"])
    if (!Number.isInteger(c[k]))
      throw new Error("Intervals must be whole days");
  return c;
}
export const initialReview = (c = defaults) => ({
  repetitions: 0,
  interval_days: 0,
  ease_factor: c.initial_ease_factor,
  due_at: null,
});
export function schedule(before, grade, timestamp, c = defaults) {
  checkSettings(c);
  if (!Number.isInteger(grade) || grade < 0 || grade > 5)
    throw new Error("Grade must be an integer from 0 to 5");
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error("Invalid timestamp");
  const ease_factor =
    Math.round(
      Math.max(
        c.minimum_ease_factor,
        before.ease_factor + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02),
      ) * 100,
    ) / 100;
  const interval_days =
    grade < 3
      ? 1
      : before.repetitions === 0
        ? c.first_interval_days
        : before.repetitions === 1
          ? c.second_interval_days
          : Math.max(1, Math.round(before.interval_days * ease_factor));
  const due = new Date(timestamp);
  due.setUTCDate(due.getUTCDate() + interval_days);
  return {
    repetitions: grade < 3 ? 0 : before.repetitions + 1,
    interval_days,
    ease_factor,
    due_at: due.toISOString(),
  };
}

/**
 * The review days a new card would get when every review is answered with the
 * same grade, replayed through `schedule` itself: [{ review, interval, day, ease }]
 * where `day` counts from the first study. null when the settings are invalid
 * (the form shows no preview until they are).
 */
export function previewSchedule(settings, { grade = 4, reviews = 6 } = {}) {
  try {
    checkSettings(settings);
    let review = initialReview(settings), at = "2026-01-01T00:00:00.000Z", day = 0;
    const points = [];
    for (let n = 1; n <= reviews; n++) {
      review = schedule(review, grade, at, settings);
      day += review.interval_days;
      points.push({ review: n, interval: review.interval_days, day, ease: review.ease_factor });
      at = review.due_at;
    }
    return points;
  } catch {
    return null;
  }
}
