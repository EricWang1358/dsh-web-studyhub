/* Personal defaults for the daily practice: the one pure contract the Settings pane, the practice session and the host share (browser-safe, its only import the pure lib/fix-phrases.js).
   Stored as `settings.practice` in the library settings, a new optional key: it is absent until the learner saves, and a release that does not
   know it keeps it untouched. Nothing here starts a model call.
   fixPhrases (lib/fix-phrases.js): the learner's own reusable 修题 phrases, an optional key like pageLimit in lib/book-settings.js: absent until one is saved, and `null`
   (or an empty list) in a patch takes it away. 恢复默认 keeps them: they are the learner's words, not a default.
   lastRounds (#1010): the last 本轮设置 chosen in each course, {[course name]: {size, range, chapter?}}, another optional key; a patch's `null` for one course takes it away,
   and 恢复默认 forgets them all. A round's size is bounded here and only here (ROUND_SIZE_LIMITS): the popover, review.start and the settings all validate with it. */
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
/** The kinds a round can be limited to (review.start `only`): 到期, 新题, 错题. No limit at all is the mixed day (due, then wrong, then new). */
export const ROUND_ONLY = Object.freeze(['due', 'new', 'wrong']);
export const ROUND_RANGES = Object.freeze(['mixed', ...ROUND_ONLY]);
/** The most courses whose last round is remembered (the oldest goes first) and the longest name or topic kept. */
export const LAST_ROUND_LIMITS = Object.freeze({ courses: 40, text: 300 });
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
/** How many questions one round may hold: the bounds of 每轮题数, which review.start's `size` and the 本轮设置 popover use too (one number, one place). */
export const ROUND_SIZE_LIMITS = PRACTICE_LIMITS.roundSize;
export const isRoundSize = validSize;
/** `value` as a round size, or the same refusal wherever it came from. */
export function checkedRoundSize(value) {
  if (!validSize(value)) throw new Error(`请选择 ${ROUND_SIZE_LIMITS.min}–${ROUND_SIZE_LIMITS.max} 题一轮`);
  return value;
}
/** How many new questions a round of new questions (review.start {mode: 'new', count}) takes: any whole number up to the longest round; the page asks for exactly the settings' number. */
export function checkedNewCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > ROUND_SIZE_LIMITS.max) throw new Error(`请选择 1–${ROUND_SIZE_LIMITS.max} 道新题`);
  return count;
}
/** `value` as a kind of question to limit a round to (undefined: not limited). */
export function checkedRoundOnly(value) {
  if (value === undefined) return undefined;
  if (!ROUND_ONLY.includes(value)) throw new Error('本轮范围应为到期（due）、新题（new）或错题（wrong）');
  return value;
}

const textOf = value => typeof value === 'string' && value.length > 0 && value.length <= LAST_ROUND_LIMITS.text;
const chapterOf = value => object(value) && textOf(value.deckId) && textOf(value.topic) ? { deckId: value.deckId, topic: value.topic } : null;
const lastRoundOf = value => object(value) && validSize(value.size) && ROUND_RANGES.includes(value.range) && (value.chapter === undefined || chapterOf(value.chapter))
  ? { size: value.size, range: value.range, ...(value.chapter ? { chapter: chapterOf(value.chapter) } : {}) } : null;
const roundKeyOk = key => key !== '__proto__' && key.length <= LAST_ROUND_LIMITS.text;
/** Forgiving read of the remembered rounds: a corrupt course costs only itself; undefined when none is left. */
function normalizeLastRounds(raw) {
  const rounds = Object.entries(object(raw) ? raw : {}).flatMap(([key, value]) => { const round = roundKeyOk(key) ? lastRoundOf(value) : null; return round ? [[key, round]] : []; });
  return rounds.length ? Object.fromEntries(rounds.slice(-LAST_ROUND_LIMITS.courses)) : undefined;
}
/** Strict read of a patch: `null` forgets all, an object sets or (value `null`) forgets single courses. */
function checkedLastRounds(value) {
  if (value === null) return null;
  if (!object(value)) throw new Error('Invalid practice setting: lastRounds');
  return Object.fromEntries(Object.entries(value).map(([key, round]) => {
    if (!roundKeyOk(key)) throw new Error('Invalid practice setting: lastRounds');
    const checked = round === null ? null : lastRoundOf(round);
    if (round !== null && !checked) throw new Error('Invalid practice setting: lastRounds');
    return [key, checked];
  }));
}
/** The saved rounds with a patch applied; the course just chosen moves to the end (the newest). */
function mergeLastRounds(current, patch) {
  if (patch === null) return undefined;
  const rounds = new Map(Object.entries(current || {}));
  for (const [key, round] of Object.entries(patch)) { rounds.delete(key); if (round) rounds.set(key, round); }
  return rounds.size ? Object.fromEntries([...rounds].slice(-LAST_ROUND_LIMITS.courses)) : undefined;
}
const valid = (key, value) => key === 'newCardOrder'
  ? NEW_CARD_ORDERS.includes(value)
  : Object.hasOwn(PRACTICE_LIMITS, key) ? inLimits(key, value) : typeof value === 'boolean';

/** Forgiving read of an old or corrupt saved object; valid siblings survive. */
export function normalizePracticeSettings(raw) {
  const source = object(raw) ? raw : {};
  const fixPhrases = normalizeFixPhrases(source.fixPhrases), lastRounds = normalizeLastRounds(source.lastRounds);
  return { ...Object.fromEntries(Object.entries(PRACTICE_DEFAULTS).map(([key, fallback]) => [key, valid(key, source[key]) ? source[key] : fallback])),
    ...(fixPhrases.length ? { fixPhrases } : {}), ...(lastRounds ? { lastRounds } : {}) };
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
    if (key === 'lastRounds') { result[key] = checkedLastRounds(value); continue; }
    if (!Object.hasOwn(PRACTICE_DEFAULTS, key)) throw new Error(`Unknown practice setting: ${key}`);
    if (!valid(key, value)) throw new Error(`Invalid practice setting: ${key}`);
    result[key] = value;
  }
  return result;
}
export function mergePracticeSettings(saved, patch) {
  const base = normalizePracticeSettings(saved), { lastRounds, ...rest } = validatePracticePatch(patch);
  const next = { ...base, ...rest };
  if (!next.fixPhrases?.length) delete next.fixPhrases;
  if (lastRounds !== undefined) {
    const rounds = mergeLastRounds(base.lastRounds, lastRounds);
    if (rounds) next.lastRounds = rounds; else delete next.lastRounds;
  }
  return next;
}

/** The two limits of a daily round (lib/mastery.js planPath): the session holds `size` questions, at most half of them new (20 -> 10, as it always was). */
export const roundLimits = size => {
  const limit = validSize(size) ? size : PRACTICE_DEFAULTS.roundSize;
  return { limit, newLimit: Math.ceil(limit / 2) };
};

/** How many questions a round of NEW questions takes: the new-question limit of the learner's round (10 of the default 20), the 「新题最多 N 道」 of 设置 › 练习.
    One number for the home's 学新题, 「继续下一批新题」 on the result page, 发布并开始练, the host's focus.fresh and review.start {mode: 'new'} without a count (#1009). */
export const freshRoundCount = saved => roundLimits(resolvePracticeSettings(saved).roundSize).newLimit;
