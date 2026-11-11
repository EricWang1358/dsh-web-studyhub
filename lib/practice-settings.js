/* Personal defaults for the daily practice: the one pure contract the Settings pane, the practice session and the host share (browser-safe, its only import the pure lib/fix-phrases.js).
   Stored as `settings.practice` in the library settings, a new optional key: it is absent until the learner saves, and a release that does not
   know it keeps it untouched. Nothing here starts a model call.
   fixPhrases (lib/fix-phrases.js): the learner's own reusable 修题 phrases, an optional key like pageLimit in lib/book-settings.js: absent until one is saved, and `null`
   (or an empty list) in a patch takes it away. 恢复默认 keeps them: they are the learner's words, not a default. */
import { normalizeFixPhrases, validateFixPhrases } from './fix-phrases.js';
export const NEW_CARD_ORDERS = Object.freeze(['reading', 'focus', 'shuffle']);
export const PRACTICE_DEFAULTS = Object.freeze({
  autopilot: false, // after a passed question the next one opens by itself, with a short countdown the learner can stop
  roundSize: 20,    // questions in one daily round (the home card's 「N 题待学」 and the round it starts)
  newCardOrder: 'reading', // 'reading' (source p.1 -> p.N default) | 'focus' (focus topics first) | 'shuffle' (interleaved)
  debrief: true,    // the result page's 本轮点评 asks the light model for one sentence; off: the same card from rules only, no model call
  // 顽固题 (lib/leech.js): a question is a leech when it was failed this many times in all, or when this share (per cent) of its latest `leechWindow` attempts failed
  leechFailures: 4,
  leechWindow: 5,
  leechRate: 60,
});
/** The whole-number settings and their inclusive limits; every other key is a switch. */
export const PRACTICE_LIMITS = Object.freeze({
  roundSize: Object.freeze({ min: 5, max: 50 }),
  leechFailures: Object.freeze({ min: 2, max: 20 }),
  leechWindow: Object.freeze({ min: 3, max: 20 }),
  leechRate: Object.freeze({ min: 50, max: 100 }),
});

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const inLimits = (key, value) => Number.isInteger(value) && value >= PRACTICE_LIMITS[key].min && value <= PRACTICE_LIMITS[key].max;
const validSize = value => inLimits('roundSize', value);
const valid = (key, value) => key === 'newCardOrder'
  ? NEW_CARD_ORDERS.includes(value)
  : Object.hasOwn(PRACTICE_LIMITS, key) ? inLimits(key, value) : typeof value === 'boolean';

/** Forgiving read of an old or corrupt saved object; valid siblings survive. */
export function normalizePracticeSettings(raw) {
  const source = object(raw) ? raw : {};
  const fixPhrases = normalizeFixPhrases(source.fixPhrases);
  return { ...Object.fromEntries(Object.entries(PRACTICE_DEFAULTS).map(([key, fallback]) => [key, valid(key, source[key]) ? source[key] : fallback])),
    ...(fixPhrases.length ? { fixPhrases } : {}) };
}
/** What a consumer reads: the full settings, whether or not the learner ever saved (`saved` is undefined until then). */
export const resolvePracticeSettings = saved => normalizePracticeSettings(saved);

const checkedPhrases = value => { try { return validateFixPhrases(value); } catch (cause) { throw new Error(`Invalid practice setting: fixPhrases (${cause.message})`); } };

/** Strict explicit patch: a wrong value must fail before the library changes. */
export function validatePracticePatch(patch) {
  if (!object(patch)) throw new Error('practice settings must be an object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'fixPhrases') { result[key] = value === null ? null : checkedPhrases(value); continue; }
    if (!Object.hasOwn(PRACTICE_DEFAULTS, key)) throw new Error(`Unknown practice setting: ${key}`);
    if (!valid(key, value)) throw new Error(`Invalid practice setting: ${key}`);
    result[key] = value;
  }
  return result;
}
export function mergePracticeSettings(saved, patch) {
  const next = { ...normalizePracticeSettings(saved), ...validatePracticePatch(patch) };
  if (!next.fixPhrases?.length) delete next.fixPhrases;
  return next;
}

/** The two limits of a daily round (lib/mastery.js planPath): the session holds `size` questions, at most half of them new (20 -> 10, as it always was). */
export const roundLimits = size => {
  const limit = validSize(size) ? size : PRACTICE_DEFAULTS.roundSize;
  return { limit, newLimit: Math.ceil(limit / 2) };
};
