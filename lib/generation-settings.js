import { NOTATIONS, normalizeNotation } from './notation.js';
import { GOAL_QUESTIONS_MAX } from './limits.js';
import { EFFORT_DEFAULTS, EFFORT_STAGES, STAGE_EFFORT_PREFERENCES, effortKey } from './stage-effort.js';

/* Durable generation defaults. The UI and workers share this pure contract;
   a queued job receives a resolved snapshot, never a live settings object. */
// The four reasoning levels (planning, review, writing, repair) are relative: lib/model-effort.js resolves them to a level the model really offers.
// applySuggestions (off): after the review, spend one more rewrite call and one more review on the cards that passed with optional suggestions, so the suggestions are used instead of only recorded.
export const GENERATION_PERFORMANCE_DEFAULTS = Object.freeze({ concurrency: 4, batchSize: 5, jobTimeoutMinutes: 20, fillRounds: 2, applySuggestions: false,
  ...Object.fromEntries(EFFORT_STAGES.map((stage) => [effortKey(stage), EFFORT_DEFAULTS[stage]])) });
// kinds (the default question types): the ordered list of 1..5 distinct basic kinds the learner ticked. `kind` stays beside it for libraries rolled back to an older version and for assistants that send only
// `kind`: one kind, 'mixed' for exactly quiz + flashcard, else the first kind; when they disagree, `kinds` wins.
export const GENERATION_SETTINGS_DEFAULTS = Object.freeze({ ...GENERATION_PERFORMANCE_DEFAULTS,
  kind: 'quiz', kinds: Object.freeze(['quiz']), count: 10, language: 'auto', difficulty: 'mixed', focus: '', notation: 'auto' });
export const GENERATION_SETTINGS_LIMITS = Object.freeze({
  concurrency: Object.freeze({ min: 1, max: 8 }), batchSize: Object.freeze({ min: 1, max: 5 }),
  jobTimeoutMinutes: Object.freeze({ min: 5, max: 180 }), fillRounds: Object.freeze({ min: 0, max: 4 }), count: Object.freeze({ min: 1, max: GOAL_QUESTIONS_MAX }),
  focus: Object.freeze({ max: 2000 }),
});
export const GENERATION_KINDS = Object.freeze(['quiz', 'multi', 'flashcard', 'open', 'cloze', 'mixed']);
export const BASIC_KINDS = Object.freeze(['quiz', 'multi', 'flashcard', 'open', 'cloze']);
const isBasic = value => BASIC_KINDS.includes(value);
/** The distinct basic kinds of a list, in the order given; null unless the list has at least one. Strict: any other entry makes it null; lenient: other entries are dropped. */
const kindList = (value, lenient = false) => {
  if (!Array.isArray(value)) return null;
  const known = value.filter(isBasic), list = [...new Set(known)];
  return list.length && (lenient || known.length === value.length) ? list : null;
};
/** What the old single `kind` says as a list ('mixed' was quiz + flashcard); null for a kind that is not one of them (a case paper, anything free-form). */
export const kindsOfLegacyKind = kind => (kind === 'mixed' ? ['quiz', 'flashcard'] : isBasic(kind) ? [kind] : null);
/** The legacy `kind` of a list: its only kind, 'mixed' for exactly quiz + flashcard, else the first kind (so an older version still writes a valid single-kind draft). */
export const legacyKindOf = kinds => (kinds.length === 2 && kinds.includes('quiz') && kinds.includes('flashcard') ? 'mixed' : kinds[0]);
/** The kinds a request asks for, in order: its list, else what its legacy kind says. */
export const requestKinds = request => kindList(request?.kinds) ?? kindsOfLegacyKind(request?.kind || 'quiz') ?? [request.kind];
/** `count` questions shared as evenly as possible over `kinds`, the remainder going to the first kinds in the order given: [[kind, n], ...]. A kind may get 0 (fewer questions than kinds). For quiz + flashcard this is what 'mixed' always did. */
export function splitCount(kinds, count) {
  if (kinds.length === 1) return [[kinds[0], count]];
  const each = Math.floor(count / kinds.length), extra = count % kinds.length;
  return kinds.map((kind, at) => [kind, each + (at < extra ? 1 : 0)]);
}
/** The pair as it is saved: the list (valid kinds kept, else what `kind` says, else the default) and the legacy kind that goes with it. */
const chosenKinds = (kind, kinds) => {
  const list = kindList(kinds, true) ?? kindsOfLegacyKind(kind) ?? [...GENERATION_SETTINGS_DEFAULTS.kinds];
  return { kind: legacyKindOf(list), kinds: list };
};
export const GENERATION_LANGUAGES = Object.freeze(['auto', '中文', 'English', '中英双语']);
export const GENERATION_DIFFICULTIES = Object.freeze(['mixed', 'foundation', 'application', 'advanced']);
export const GENERATION_NOTATIONS = NOTATIONS;
const choices = { kind: GENERATION_KINDS, language: GENERATION_LANGUAGES, difficulty: GENERATION_DIFFICULTIES, notation: GENERATION_NOTATIONS,
  ...Object.fromEntries(EFFORT_STAGES.map((stage) => [effortKey(stage), STAGE_EFFORT_PREFERENCES])) };
const performanceKeys = Object.keys(GENERATION_PERFORMANCE_DEFAULTS);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const BOOLEAN_KEYS = new Set(['applySuggestions']);
const valid = (key, value) => key === 'kinds' ? kindList(value) !== null : choices[key] ? choices[key].includes(value)
  : BOOLEAN_KEYS.has(key) ? typeof value === 'boolean'
  : key === 'focus' ? typeof value === 'string' && value.trim().length <= GENERATION_SETTINGS_LIMITS.focus.max
    : Number.isInteger(value) && value >= GENERATION_SETTINGS_LIMITS[key].min && value <= GENERATION_SETTINGS_LIMITS[key].max;
const clean = (key, value) => key === 'focus' ? value.trim() : key === 'kinds' ? kindList(value) : value;

/** Forgiving reads of old or corrupt persisted settings; valid siblings survive. */
export function normalizeGenerationSettings(raw) {
  const source = object(raw) ? raw : {};
  const settings = Object.fromEntries(Object.entries(GENERATION_SETTINGS_DEFAULTS).map(([key, fallback]) =>
    [key, valid(key, source[key]) ? clean(key, source[key]) : fallback]));
  // A library of an older version has only `kind`; where the two disagree, `kinds` wins; a list with bad entries keeps the good ones.
  return { ...settings, ...chosenKinds(source.kind, source.kinds) };
}
export function normalizeGenerationPerformance(raw) {
  const normalized = normalizeGenerationSettings(raw);
  return Object.fromEntries(performanceKeys.map(key => [key, normalized[key]]));
}

const checkedPatch = (patch, allowed) => {
  if (!object(patch)) throw new Error('generation settings must be an object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key)) throw new Error(`Unknown generation setting: ${key}`);
    if (!valid(key, value)) throw new Error(`Invalid generation setting: ${key}`);
    result[key] = clean(key, value);
  }
  return result;
};
/** Strict explicit patches: invalid values must fail before the library changes. */
export const validateGenerationPatch = patch => checkedPatch(patch, Object.keys(GENERATION_SETTINGS_DEFAULTS));
export const validateGenerationPerformance = patch => checkedPatch(patch, performanceKeys);
export function mergeGenerationSettings(saved, patch) {
  const checked = validateGenerationPatch(patch), merged = { ...normalizeGenerationSettings(saved), ...checked };
  // The pair changes together: a patch with `kind` only (an older assistant) sets the list, a patch with `kinds` sets the kind, and `kinds` wins.
  return 'kind' in checked || 'kinds' in checked ? { ...merged, ...chosenKinds(checked.kind, checked.kinds) } : merged;
}

/** Resolve new work or continued work once. Content choices made explicitly by
    existing API clients remain free-form; settings defaults use the UI enums.
    A continued draft never inherits today's changed library defaults, except the time limit (jobTimeoutMinutes), which is the learner's current patience. */
export function resolveGenerationRequest(saved, args = {}, { language, continuation = null } = {}) {
  const current = normalizeGenerationSettings(saved), earlier = object(continuation) ? continuation : null;
  const content = earlier ? { kind: earlier.kind ?? 'quiz', kinds: earlier.kinds, count: GENERATION_SETTINGS_DEFAULTS.count,
    language: earlier.language ?? '中文', difficulty: earlier.difficulty ?? 'mixed', focus: earlier.focus ?? '', notation: earlier.notation ?? 'auto' } : current;
  const result = Object.fromEntries(['kind', 'count', 'language', 'difficulty', 'focus', 'notation'].map(key =>
    [key, args[key] !== undefined ? args[key] : content[key]]));
  // The kinds: an explicit list wins, then an explicit `kind` (as before: that kind, 'mixed' for quiz + flashcard), then the list of the saved settings or of the draft (an older draft has only `kind`).
  // A case paper or a free-form kind has no list.
  if (args.kinds !== undefined) {
    const list = kindList(args.kinds);
    if (!list) throw new Error('Unknown question kind');
    Object.assign(result, { kind: legacyKindOf(list), kinds: list });
  } else {
    const list = args.kind !== undefined ? kindsOfLegacyKind(args.kind) : kindList(content.kinds) ?? kindsOfLegacyKind(result.kind);
    if (list) { result.kinds = list; if (args.kind === undefined) result.kind = legacyKindOf(list); }
  }
  result.notation = normalizeNotation(result.notation);
  if (result.language === 'auto') result.language = language === 'en' ? 'English' : '中文';
  const performance = earlier ? normalizeGenerationPerformance(earlier.performance) : normalizeGenerationPerformance(current);
  // What the learner is willing to spend is today's choice, not part of what the draft was written with: the time limit and whether the review's suggestions are applied follow the setting
  // as it is now. Raising the limit in 设置 is how a run that reached it is continued (接着做, a top-up of a published deck); batch size, concurrency, fill rounds and reasoning levels stay as the draft was written.
  if (earlier) { const now = normalizeGenerationPerformance(current); performance.jobTimeoutMinutes = now.jobTimeoutMinutes; performance.applySuggestions = now.applySuggestions; }
  result.performance = { ...performance, ...(args.performance !== undefined ? validateGenerationPerformance(args.performance) : {}) };
  return result;
}
