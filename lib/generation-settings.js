import { NOTATIONS, normalizeNotation } from './notation.js';
import { GOAL_QUESTIONS_MAX } from './limits.js';
import { EFFORT_DEFAULTS, EFFORT_STAGES, STAGE_EFFORT_PREFERENCES, effortKey } from './stage-effort.js';
import { GENERATE_KIND_IDS } from './card-kinds.js';
import { cleanLightModel, isLightModelValue } from './job-model.js';
import { normalizeModuleOverrides } from './generation-modules.js';
import { questionLanguage } from './contexts/generation/content-language.js';

/* Durable generation defaults. The UI and workers share this pure contract;
   a queued job receives a resolved snapshot, never a live settings object. */
// The four reasoning levels (planning, review, writing, repair) are relative: lib/model-effort.js resolves them to a level the model really offers.
// applySuggestions (off): after the review, spend one more rewrite call and one more review on the cards that passed with optional suggestions, so the suggestions are used instead of only recorded.
export const GENERATION_PERFORMANCE_DEFAULTS = Object.freeze({ concurrency: 4, batchSize: 5, jobTimeoutMinutes: 20, fillRounds: 2, applySuggestions: false,
  ...Object.fromEntries(EFFORT_STAGES.map((stage) => [effortKey(stage), EFFORT_DEFAULTS[stage]])) });
// kinds (the default question types): the ordered list of 1..5 distinct basic kinds the learner ticked. `kind` stays beside it for libraries rolled back to an older version and for assistants that send only
// `kind`: one kind, 'mixed' for exactly quiz + flashcard, else the first kind; when they disagree, `kinds` wins.
// coverageLevel (the default 覆盖强度 of the 创建题组 form): the level the page plans by (lib/coverage-strength.js). It is read by the form only: a request made without a coverageLevel (an assistant in the
// conversation) is planned by its count as before, so resolveGenerationRequest never hands it on. `count` is that count: the page itself plans by level and ignores it.
export const GENERATION_COVERAGE_LEVELS = Object.freeze(['lean', 'standard', 'full']);
export const GENERATION_SETTINGS_DEFAULTS = Object.freeze({ ...GENERATION_PERFORMANCE_DEFAULTS,
  kind: 'quiz', kinds: Object.freeze(['quiz']), count: 10, selectionCount: 3, language: 'auto', difficulty: 'mixed', focus: '', notation: 'auto', coverageLevel: 'standard', lightModel: '' });
export const GENERATION_SETTINGS_LIMITS = Object.freeze({
  concurrency: Object.freeze({ min: 1, max: 8 }), batchSize: Object.freeze({ min: 1, max: 5 }),
  jobTimeoutMinutes: Object.freeze({ min: 5, max: 180 }), fillRounds: Object.freeze({ min: 0, max: 4 }),
  count: Object.freeze({ min: 1, max: GOAL_QUESTIONS_MAX }), selectionCount: Object.freeze({ min: 1, max: 20 }),
  focus: Object.freeze({ max: 2000 }),
});
/** The kinds a run can be asked for (lib/card-kinds.js), and with them the legacy 'mixed' (quiz + flashcard). */
export const BASIC_KINDS = GENERATE_KIND_IDS;
export const GENERATION_KINDS = Object.freeze([...BASIC_KINDS, 'mixed']);
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

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate explicit per-kind question counts (`{ quiz: 5, open: 2, flashcard: 0 }`). 0-quota kinds stay 0 and never fall back to uniform split (#852). */
export function normalizeKindCounts(kinds, rawCounts, expectedTotal) {
  if (rawCounts === undefined || rawCounts === null) return undefined;
  if (!object(rawCounts) || !Array.isArray(kinds) || kinds.length < 2) throw new Error('Invalid mixed question counts');
  if (Object.keys(rawCounts).some(kind => !kinds.includes(kind))) throw new Error('Invalid mixed question counts');
  const counts = {};
  let sum = 0;
  for (const kind of kinds) {
    const raw = rawCounts[kind] === undefined ? 0 : rawCounts[kind];
    if (!Number.isInteger(raw) || raw < 0) throw new Error('Invalid mixed question counts');
    counts[kind] = raw;
    sum += raw;
  }
  if (sum < 1 || sum > GOAL_QUESTIONS_MAX) throw new Error('Invalid mixed question counts');
  if (Number.isInteger(expectedTotal) && expectedTotal > 0 && sum !== expectedTotal) throw new Error('Invalid mixed question counts');
  return { counts, sum };
}

/**
 * Allocate `total` questions across `kinds` honoring optional non-uniform `kindCounts` ratios via largest-remainder rounding.
 * Kinds explicitly set to 0 in `kindCounts` strictly receive 0 questions.
 */
export function allocateKindShares(kinds, total, kindCounts) {
  if (!Array.isArray(kinds) || !kinds.length) return [];
  if (kinds.length === 1) return [[kinds[0], total]];
  if (!(total > 0)) return kinds.map(kind => [kind, 0]);
  if (!object(kindCounts)) return splitCount(kinds, total);
  const weights = kinds.map(kind => Math.max(0, Number(kindCounts[kind]) || 0));
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum <= 0) return splitCount(kinds, total);
  if (total === weightSum && weights.every(Number.isInteger)) return kinds.map((kind, at) => [kind, weights[at]]);
  const bases = weights.map(w => (w > 0 ? Math.floor((total * w) / weightSum) : 0));
  const left = total - bases.reduce((sum, n) => sum + n, 0);
  const order = kinds
    .map((_, at) => ({ at, rem: weights[at] > 0 ? (total * weights[at]) / weightSum - bases[at] : -1 }))
    .filter(entry => entry.rem >= 0)
    .sort((a, b) => b.rem - a.rem || a.at - b.at);
  for (let i = 0; i < left && order.length; i += 1) {
    bases[order[i % order.length].at] += 1;
  }
  return kinds.map((kind, at) => [kind, bases[at]]);
}

/** The pair as it is saved: the list (valid kinds kept, else what `kind` says, else the default) and the legacy kind that goes with it. */
const chosenKinds = (kind, kinds) => {
  const list = kindList(kinds, true) ?? kindsOfLegacyKind(kind) ?? [...GENERATION_SETTINGS_DEFAULTS.kinds];
  return { kind: legacyKindOf(list), kinds: list };
};
export const GENERATION_LANGUAGES = Object.freeze(['auto', '中文', 'English', '中英双语']);
export const GENERATION_DIFFICULTIES = Object.freeze(['mixed', 'foundation', 'application', 'advanced']);
export const GENERATION_NOTATIONS = NOTATIONS;
const choices = { kind: GENERATION_KINDS, language: GENERATION_LANGUAGES, difficulty: GENERATION_DIFFICULTIES, notation: GENERATION_NOTATIONS, coverageLevel: GENERATION_COVERAGE_LEVELS,
  ...Object.fromEntries(EFFORT_STAGES.map((stage) => [effortKey(stage), STAGE_EFFORT_PREFERENCES])) };
// Optional host concurrency cap hook: lets a non-DSH host (e.g. a desktop CLI backend) cap parallel model calls
// without building a separate parallel queue. DSH registers nothing, so effectiveConcurrencyLimit() returns { min: 1, max: 8 }.
let hostConcurrencyCap = null;

/** Register an optional host concurrency cap (`null` clears; a positive integer caps max; `{ max, default? }` or a getter function is read dynamically). */
export function registerHostConcurrencyCap(cap) { hostConcurrencyCap = cap ?? null; }

function resolveConcurrencyCap(options) {
  const base = GENERATION_SETTINGS_LIMITS.concurrency;
  const explicit = typeof options === 'number' ? { max: options }
    : options?.maxConcurrency !== undefined ? { max: options.maxConcurrency, default: options.defaultConcurrency } : null;
  const raw = explicit ?? (typeof hostConcurrencyCap === 'function' ? hostConcurrencyCap() : hostConcurrencyCap);
  const max = typeof raw === 'number' ? raw : raw?.max;
  if (!Number.isInteger(max) || max < base.min) return null;
  const cappedMax = Math.min(base.max, max);
  const defaultValue = Number.isInteger(raw?.default) && raw.default >= base.min ? Math.min(cappedMax, raw.default) : undefined;
  return { min: base.min, max: cappedMax, defaultValue };
}

/** Effective concurrency `{ min, max }` after applying an optional explicit or host-registered cap. */
export function effectiveConcurrencyLimit(options) {
  const cap = resolveConcurrencyCap(options);
  return cap ? { min: cap.min, max: cap.max } : GENERATION_SETTINGS_LIMITS.concurrency;
}

/** Clamp a concurrency value into the effective `[min, max]` range (using the host cap's default when unset/invalid). */
export function clampConcurrency(value, options) {
  const cap = resolveConcurrencyCap(options);
  const limit = cap || GENERATION_SETTINGS_LIMITS.concurrency;
  const fallback = cap?.defaultValue ?? Math.min(limit.max, GENERATION_PERFORMANCE_DEFAULTS.concurrency);
  const n = Number.isInteger(value) ? value : fallback;
  return Math.max(limit.min, Math.min(limit.max, n));
}

const performanceKeys = Object.keys(GENERATION_PERFORMANCE_DEFAULTS);
const BOOLEAN_KEYS = new Set(['applySuggestions']);
const numericLimit = (key, options) => (key === 'concurrency' ? effectiveConcurrencyLimit(options) : GENERATION_SETTINGS_LIMITS[key]);
const valid = (key, value, options) => key === 'kinds' ? kindList(value) !== null : choices[key] ? choices[key].includes(value)
  : BOOLEAN_KEYS.has(key) ? typeof value === 'boolean'
  : key === 'lightModel' ? isLightModelValue(value)
  : key === 'focus' ? typeof value === 'string' && value.trim().length <= GENERATION_SETTINGS_LIMITS.focus.max
    : Number.isInteger(value) && value >= numericLimit(key, options).min && value <= numericLimit(key, options).max;
const clean = (key, value) => key === 'focus' ? value.trim() : key === 'kinds' ? kindList(value) : key === 'lightModel' ? cleanLightModel(value) : value;

/** Forgiving reads of old or corrupt persisted settings; valid siblings survive. */
export function normalizeGenerationSettings(raw, options) {
  const source = object(raw) ? raw : {};
  const settings = Object.fromEntries(Object.entries(GENERATION_SETTINGS_DEFAULTS).map(([key, fallback]) =>
    [key, valid(key, source[key]) ? clean(key, source[key]) : fallback]));
  const cap = resolveConcurrencyCap(options);
  if (cap) {
    settings.concurrency = Number.isInteger(source.concurrency) && source.concurrency >= cap.min && source.concurrency <= GENERATION_SETTINGS_LIMITS.concurrency.max
      ? Math.min(cap.max, source.concurrency)
      : clampConcurrency(undefined, options);
  }
  // A library of an older version has only `kind`; where the two disagree, `kinds` wins; a list with bad entries keeps the good ones.
  return { ...settings, ...chosenKinds(source.kind, source.kinds) };
}
export function normalizeGenerationPerformance(raw, options) {
  const normalized = normalizeGenerationSettings(raw, options);
  return Object.fromEntries(performanceKeys.map(key => [key, normalized[key]]));
}

const checkedPatch = (patch, allowed, options) => {
  if (!object(patch)) throw new Error('generation settings must be an object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key)) throw new Error(`Unknown generation setting: ${key}`);
    if (!valid(key, value, options)) throw new Error(`Invalid generation setting: ${key}`);
    result[key] = clean(key, value);
  }
  return result;
};
/** Strict explicit patches: invalid values must fail before the library changes. */
export const validateGenerationPatch = (patch, options) => checkedPatch(patch, Object.keys(GENERATION_SETTINGS_DEFAULTS), options);
export const validateGenerationPerformance = (patch, options) => checkedPatch(patch, performanceKeys, options);
export function mergeGenerationSettings(saved, patch, options) {
  const checked = validateGenerationPatch(patch, options), merged = { ...normalizeGenerationSettings(saved, options), ...checked };
  // The pair changes together: a patch with `kind` only (an older assistant) sets the list, a patch with `kinds` sets the kind, and `kinds` wins.
  return 'kind' in checked || 'kinds' in checked ? { ...merged, ...chosenKinds(checked.kind, checked.kinds) } : merged;
}

/** Resolve new work or continued work once. Content choices made explicitly by
    existing API clients remain free-form; settings defaults use the UI enums.
    A continued draft never inherits today's changed library defaults, except the time limit (jobTimeoutMinutes), which is the learner's current patience. */
export function resolveGenerationRequest(saved, args = {}, { language, continuation = null, maxConcurrency, defaultConcurrency } = {}) {
  const capOptions = maxConcurrency !== undefined ? { maxConcurrency, defaultConcurrency } : undefined;
  const current = normalizeGenerationSettings(saved, capOptions), earlier = object(continuation) ? continuation : null;
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
  if (args.kindCounts !== undefined && args.kindCounts !== null) {
    const validated = normalizeKindCounts(result.kinds, args.kindCounts, args.count !== undefined ? result.count : undefined);
    if (args.count === undefined) result.count = validated.sum;
    result.kindCounts = validated.counts;
    result.requestedKindCounts = validated.counts;
  } else if (args.requestedKindCounts && result.kinds?.length >= 2) {
    const inherited = normalizeKindCounts(result.kinds, args.requestedKindCounts);
    if (inherited) result.requestedKindCounts = inherited.counts;
  } else if (earlier?.kindCounts && result.kinds?.length >= 2) {
    try {
      const inherited = normalizeKindCounts(result.kinds, earlier.kindCounts);
      if (inherited) result.requestedKindCounts = inherited.counts;
    } catch { /* ignore malformed legacy kindCounts */ }
  }
  const rawModules = args.moduleOverrides !== undefined ? args.moduleOverrides : earlier?.moduleOverrides;
  if (rawModules !== undefined) {
    const normalizedModules = normalizeModuleOverrides(rawModules, { strict: args.moduleOverrides !== undefined });
    if (normalizedModules) result.moduleOverrides = normalizedModules;
  }
  result.notation = normalizeNotation(result.notation);
  if (result.language === 'auto') result.language = language === 'en' ? 'English' : '中文';
  const performance = earlier ? normalizeGenerationPerformance(earlier.performance, capOptions) : normalizeGenerationPerformance(current, capOptions);
  // What the learner is willing to spend is today's choice, not part of what the draft was written with: the time limit and whether the review's suggestions are applied follow the setting
  // as it is now. Raising the limit in 设置 is how a run that reached it is continued (接着做, a top-up of a published deck); batch size, concurrency, fill rounds and reasoning levels stay as the draft was written.
  if (earlier) { const now = normalizeGenerationPerformance(current, capOptions); performance.jobTimeoutMinutes = now.jobTimeoutMinutes; performance.applySuggestions = now.applySuggestions; }
  result.performance = { ...performance, ...(args.performance !== undefined ? validateGenerationPerformance(args.performance, capOptions) : {}) };
  return result;
}

/** The content language of new questions for an existing deck or made from one of its cards, in the one order of questionLanguage
    (lib/contexts/generation/content-language.js): an `explicit` choice, the deck's record, the `card`'s own, then the 出题语言 setting. Both the choice and the
    setting are resolved as a run's are (auto: the interface language `language`). */
export const deckContentLanguage = (saved, deck, { language, explicit, card } = {}) => questionLanguage({ deck, card,
  asked: explicit === undefined ? undefined : resolveGenerationRequest(saved, { language: explicit }, { language }).language,
  fallback: resolveGenerationRequest(saved, {}, { language }).language });
