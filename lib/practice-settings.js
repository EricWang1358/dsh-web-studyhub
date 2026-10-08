/* Personal defaults for the daily practice: the one pure contract the Settings pane, the practice session and the host share (browser-safe, no imports).
   Stored as `settings.practice` in the library settings, a new optional key: it is absent until the learner saves, and a release that does not
   know it keeps it untouched. Nothing here starts a model call. */
export const PRACTICE_DEFAULTS = Object.freeze({
  autopilot: false, // after a passed question the next one opens by itself, with a short countdown the learner can stop
  roundSize: 20,    // questions in one daily round (the home card's 「N 题待学」 and the round it starts)
  debrief: true,    // the result page's 本轮点评 asks the light model for one sentence; off: the same card from rules only, no model call
});
export const PRACTICE_LIMITS = Object.freeze({ roundSize: Object.freeze({ min: 5, max: 50 }) });

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const { min: SIZE_MIN, max: SIZE_MAX } = PRACTICE_LIMITS.roundSize;
const validSize = value => Number.isInteger(value) && value >= SIZE_MIN && value <= SIZE_MAX;
const valid = (key, value) => key === 'roundSize' ? validSize(value) : typeof value === 'boolean';

/** Forgiving read of an old or corrupt saved object; valid siblings survive. */
export function normalizePracticeSettings(raw) {
  const source = object(raw) ? raw : {};
  return Object.fromEntries(Object.entries(PRACTICE_DEFAULTS).map(([key, fallback]) => [key, valid(key, source[key]) ? source[key] : fallback]));
}
/** What a consumer reads: the full settings, whether or not the learner ever saved (`saved` is undefined until then). */
export const resolvePracticeSettings = saved => normalizePracticeSettings(saved);

/** Strict explicit patch: a wrong value must fail before the library changes. */
export function validatePracticePatch(patch) {
  if (!object(patch)) throw new Error('practice settings must be an object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(PRACTICE_DEFAULTS, key)) throw new Error(`Unknown practice setting: ${key}`);
    if (!valid(key, value)) throw new Error(`Invalid practice setting: ${key}`);
    result[key] = value;
  }
  return result;
}
export const mergePracticeSettings = (saved, patch) => ({ ...normalizePracticeSettings(saved), ...validatePracticePatch(patch) });

/** The two limits of a daily round (lib/mastery.js planPath): the session holds `size` questions, at most half of them new (20 -> 10, as it always was). */
export const roundLimits = size => {
  const limit = validSize(size) ? size : PRACTICE_DEFAULTS.roundSize;
  return { limit, newLimit: Math.ceil(limit / 2) };
};
