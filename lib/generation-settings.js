/* Durable generation defaults. The UI and workers share this pure contract;
   a queued job receives a resolved snapshot, never a live settings object. */
export const GENERATION_PERFORMANCE_DEFAULTS = Object.freeze({ concurrency: 3, batchSize: 5, jobTimeoutMinutes: 20 });
export const GENERATION_SETTINGS_DEFAULTS = Object.freeze({ ...GENERATION_PERFORMANCE_DEFAULTS,
  kind: 'quiz', count: 10, language: 'auto', difficulty: 'mixed', focus: '' });
export const GENERATION_SETTINGS_LIMITS = Object.freeze({
  concurrency: Object.freeze({ min: 1, max: 6 }), batchSize: Object.freeze({ min: 1, max: 5 }),
  jobTimeoutMinutes: Object.freeze({ min: 5, max: 60 }), count: Object.freeze({ min: 1, max: 30 }),
  focus: Object.freeze({ max: 2000 }),
});
export const GENERATION_KINDS = Object.freeze(['quiz', 'multi', 'flashcard', 'open', 'cloze', 'mixed']);
export const GENERATION_LANGUAGES = Object.freeze(['auto', '中文', 'English', '中英双语']);
export const GENERATION_DIFFICULTIES = Object.freeze(['mixed', 'foundation', 'application', 'advanced']);
const choices = { kind: GENERATION_KINDS, language: GENERATION_LANGUAGES, difficulty: GENERATION_DIFFICULTIES };
const performanceKeys = Object.keys(GENERATION_PERFORMANCE_DEFAULTS);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const valid = (key, value) => choices[key] ? choices[key].includes(value)
  : key === 'focus' ? typeof value === 'string' && value.trim().length <= GENERATION_SETTINGS_LIMITS.focus.max
    : Number.isInteger(value) && value >= GENERATION_SETTINGS_LIMITS[key].min && value <= GENERATION_SETTINGS_LIMITS[key].max;
const clean = (key, value) => key === 'focus' ? value.trim() : value;

/** Forgiving reads of old or corrupt persisted settings; valid siblings survive. */
export function normalizeGenerationSettings(raw) {
  const source = object(raw) ? raw : {};
  return Object.fromEntries(Object.entries(GENERATION_SETTINGS_DEFAULTS).map(([key, fallback]) =>
    [key, valid(key, source[key]) ? clean(key, source[key]) : fallback]));
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
export const mergeGenerationSettings = (saved, patch) => ({ ...normalizeGenerationSettings(saved), ...validateGenerationPatch(patch) });

/** Resolve new work or continued work once. Content choices made explicitly by
    existing API clients remain free-form; settings defaults use the UI enums.
    A continued draft never inherits today's changed library defaults. */
export function resolveGenerationRequest(saved, args = {}, { language, continuation = null } = {}) {
  const current = normalizeGenerationSettings(saved), earlier = object(continuation) ? continuation : null;
  const content = earlier ? { kind: earlier.kind ?? 'quiz', count: GENERATION_SETTINGS_DEFAULTS.count,
    language: earlier.language ?? '中文', difficulty: earlier.difficulty ?? 'mixed', focus: earlier.focus ?? '' } : current;
  const result = Object.fromEntries(['kind', 'count', 'language', 'difficulty', 'focus'].map(key =>
    [key, args[key] !== undefined ? args[key] : content[key]]));
  if (result.language === 'auto') result.language = language === 'en' ? 'English' : '中文';
  const performance = earlier ? normalizeGenerationPerformance(earlier.performance) : normalizeGenerationPerformance(current);
  result.performance = { ...performance, ...(args.performance !== undefined ? validateGenerationPerformance(args.performance) : {}) };
  return result;
}
