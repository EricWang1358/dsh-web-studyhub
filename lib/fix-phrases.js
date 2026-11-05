/* 我的修题语句: the learner's own reusable phrases for the 修题 box (ui/review/FixPhrases.jsx), the pure contract the practice page and the host share
   (browser-safe, no imports). Stored as `settings.practice.fixPhrases` (lib/practice-settings.js), an optional key: absent until the learner saves a phrase.
   A phrase is one line of the learner's own words, trimmed, at most 200 characters; the list holds at most 12, each once, in the order they were saved. */
export const FIX_PHRASE_LIMITS = Object.freeze({ count: 12, length: 200 });

const { count: MAX_COUNT, length: MAX_LENGTH } = FIX_PHRASE_LIMITS;
const fits = text => text.length > 0 && text.length <= MAX_LENGTH;
const unique = list => [...new Set(list)];

/** Forgiving read of a saved or restored list: what is not usable text is left out, and the first 12 phrases stay. */
export const normalizeFixPhrases = raw =>
  (Array.isArray(raw) ? unique(raw.filter(item => typeof item === 'string').map(item => item.trim()).filter(fits)).slice(0, MAX_COUNT) : []);

/** Strict read of a list the caller wants saved: a wrong shape, a phrase over the limit or a 13th phrase fails before the library changes. */
export function validateFixPhrases(value) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid fix phrases: expected a list of text');
  const list = unique(value.map(item => item.trim()).filter(item => item.length > 0));
  if (list.some(item => item.length > MAX_LENGTH)) throw new Error(`Invalid fix phrase: more than ${MAX_LENGTH} characters`);
  if (list.length > MAX_COUNT) throw new Error(`Invalid fix phrases: more than ${MAX_COUNT}`);
  return list;
}

/** Why `text` cannot be saved as a phrase next to `list` ('empty' | 'saved' | 'long' | 'full'), or { ok: true }. */
export function canAddFixPhrase(list, text) {
  const phrase = String(text ?? '').trim();
  if (!phrase) return { ok: false, reason: 'empty' };
  if (list.includes(phrase)) return { ok: false, reason: 'saved' };
  if (phrase.length > MAX_LENGTH) return { ok: false, reason: 'long' };
  if (list.length >= MAX_COUNT) return { ok: false, reason: 'full' };
  return { ok: true };
}

/** `list` with `text` at the end; the same list when the text cannot be saved. Adding it twice ends in the same state. */
export const addFixPhrase = (list, text) => (canAddFixPhrase(list, text).ok ? [...list, String(text).trim()] : list);
/** `list` without `phrase`. */
export const removeFixPhrase = (list, phrase) => list.filter(item => item !== phrase);
