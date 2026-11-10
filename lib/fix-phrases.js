/* 我的修题语句: the learner's own reusable phrases for the 修题 box (ui/review/FixPhrases.jsx), the pure contract the practice page and the host share
   (browser-safe). Stored as `settings.practice.fixPhrases` (lib/practice-settings.js), an optional key: absent until the learner saves a phrase.
   A phrase is one line of the learner's own words, trimmed, at most 200 characters; the list holds at most 12, each once, in the order they were saved
   (lib/short-text-list.js, the same contract as a course's 出题守则 in lib/course-rules.js). */
import { shortTextList } from './short-text-list.js';

export const FIX_PHRASE_LIMITS = Object.freeze({ count: 12, length: 200 });

const phrases = shortTextList(FIX_PHRASE_LIMITS, { one: 'fix phrase', many: 'fix phrases' });

/** Forgiving read of a saved or restored list: what is not usable text is left out, and the first 12 phrases stay. */
export const normalizeFixPhrases = phrases.normalize;

/** Strict read of a list the caller wants saved: a wrong shape, a phrase over the limit or a 13th phrase fails before the library changes. */
export const validateFixPhrases = phrases.validate;

/** Why `text` cannot be saved as a phrase next to `list` ('empty' | 'saved' | 'long' | 'full'), or { ok: true }. */
export const canAddFixPhrase = phrases.canAdd;

/** `list` with `text` at the end; the same list when the text cannot be saved. Adding it twice ends in the same state. */
export const addFixPhrase = phrases.add;
/** `list` without `phrase`. */
export const removeFixPhrase = phrases.remove;
