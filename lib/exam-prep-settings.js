/* Personal defaults for 备考补习: the one pure contract the Settings pane, the create form and the host share (browser-safe, no imports).
   Stored as `settings.examPrep` in the library settings, a new optional key: it is absent until the learner saves, and a release that does not
   know it keeps it untouched. The create form reads the resolved object; nothing here starts a model call. */
export const EXAM_PREP_LANGUAGES = Object.freeze(['auto', 'zh', 'en']);
export const EXAM_PREP_DEFAULTS = Object.freeze({
  autoRoles: true,            // guess each material's role (lecture, sample paper, syllabus) from its name and size
  paperWords: Object.freeze([]), // the learner's own words that mark a sample paper, beside the built-in ones
  language: 'auto',           // the language of the list: 'auto' follows the interface language
  showOtherCourses: false,    // list materials of other courses in the create form's pickers
});
export const EXAM_PREP_LIMITS = Object.freeze({ paperWords: Object.freeze({ max: 20, wordMax: 20 }) });

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const sameWord = (left, right) => left.toLowerCase() === right.toLowerCase();
const uniqueWords = words => words.filter((word, at) => words.findIndex(other => sameWord(other, word)) === at);

/** A new word for the list, as the form asks it: { word } to add, or { problem } (empty | long | duplicate | full) saying why not. */
export function checkPaperWord(words, text) {
  const word = typeof text === 'string' ? text.trim() : '';
  const { max, wordMax } = EXAM_PREP_LIMITS.paperWords, list = Array.isArray(words) ? words : [];
  if (!word) return { problem: 'empty' };
  if (word.length > wordMax) return { problem: 'long' };
  if (list.some(other => sameWord(other, word))) return { problem: 'duplicate' };
  return list.length >= max ? { problem: 'full' } : { word };
}

/** The words of a list as saved: text only, trimmed, no repeats (letter case aside), none empty or too long, at most the limit.
    Lenient keeps the good entries; strict gives null unless every entry is fine. */
function wordList(value, lenient) {
  if (!Array.isArray(value)) return null;
  const { max, wordMax } = EXAM_PREP_LIMITS.paperWords;
  const words = value.filter(word => typeof word === 'string').map(word => word.trim());
  const fine = words.filter(word => word && word.length <= wordMax);
  if (!lenient && fine.length !== value.length) return null; // a non-text, empty or too long entry (fine only holds the others)
  const list = uniqueWords(fine);
  return lenient ? list.slice(0, max) : list.length <= max ? list : null;
}

const valid = (key, value) => key === 'paperWords' ? wordList(value, false) !== null
  : key === 'language' ? EXAM_PREP_LANGUAGES.includes(value) : typeof value === 'boolean';
const clean = (key, value) => key === 'paperWords' ? wordList(value, false) : value;

/** Forgiving read of an old or corrupt saved object; valid siblings survive. */
export function normalizeExamPrepSettings(raw) {
  const source = object(raw) ? raw : {};
  return Object.fromEntries(Object.entries(EXAM_PREP_DEFAULTS).map(([key, fallback]) => {
    if (key === 'paperWords') return [key, wordList(source[key], true) ?? []];
    return [key, valid(key, source[key]) ? source[key] : fallback];
  }));
}
/** What a consumer reads: the full settings, whether or not the learner ever saved (`saved` is undefined until then). */
export const resolveExamPrepSettings = saved => normalizeExamPrepSettings(saved);

/** Strict explicit patch: a wrong value must fail before the library changes. */
export function validateExamPrepPatch(patch) {
  if (!object(patch)) throw new Error('exam prep settings must be an object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(EXAM_PREP_DEFAULTS, key)) throw new Error(`Unknown exam prep setting: ${key}`);
    if (!valid(key, value)) throw new Error(`Invalid exam prep setting: ${key}`);
    result[key] = clean(key, value);
  }
  return result;
}
export const mergeExamPrepSettings = (saved, patch) => ({ ...normalizeExamPrepSettings(saved), ...validateExamPrepPatch(patch) });
