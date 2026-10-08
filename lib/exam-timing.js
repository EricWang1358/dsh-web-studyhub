export const EXAM_LIMIT_MS = 30 * 60 * 1000;

/** The accepted time limit of a written exam, in whole minutes: the same range as a course's saved 作答时间 (lib/courses.js). */
export const LIMIT_MINUTES = Object.freeze({ min: 1, max: 1440 });
const DEFAULT_MINUTES = EXAM_LIMIT_MS / 60000;
const validMinutes = (value) => Number.isInteger(value) && value >= LIMIT_MINUTES.min && value <= LIMIT_MINUTES.max;

/**
 * The limit a request asks for, in whole minutes: undefined/null = no choice (the default), a number or a numeric text is checked,
 * anything else is refused with `fail(message)` rather than guessed.
 */
export function checkedLimitMinutes(value, fail = (message) => { throw new Error(message); }) {
  if (value === undefined || value === null) return undefined;
  const minutes = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!validMinutes(minutes)) return fail(`限时需为 ${LIMIT_MINUTES.min}–${LIMIT_MINUTES.max} 分钟的整数`);
  return minutes;
}

/** A case paper (WP12) carries its own limit (reading + writing); paper practice has none on the server. A written exam keeps the limit chosen at its start (30 minutes before that existed). */
export const examLimitMs = (run) => run?.paper ? run.paper.limitMs || null : run?.limitMs > 0 ? run.limitMs : EXAM_LIMIT_MS;

export function examExpired(run, now = Date.now()) {
  const startedAt = Date.parse(run?.startedAt), limit = examLimitMs(run);
  return !!limit && Number.isFinite(startedAt) && now - startedAt >= limit;
}

/**
 * The limit the written exam's setup starts on: the course's own 作答时间 when the learner saved one for the course picked on the page,
 * else 30 minutes. `source` says which, so the card can show why. Several courses (`*`) have no single profile.
 */
export function defaultLimitMinutes(data, course) {
  const record = course && course !== "*" ? (data?.courses || []).find((item) => item && (item.name === course || item.id === course || item.courseId === course)) : null;
  const minutes = record?.exam?.writingMinutes;
  return validMinutes(minutes) ? { minutes, source: "course" } : { minutes: DEFAULT_MINUTES, source: "default" };
}

/** The one-click limits on the setup: a few round times, and the course's own when it is not one of them. */
export const limitPresets = (defaultMinutes = DEFAULT_MINUTES) => [...new Set([15, 30, 45, 60, defaultMinutes])].sort((a, b) => a - b);
