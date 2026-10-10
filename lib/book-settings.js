/* 复习全书 settings (docs/plans/review-book.md M3): the one contract the Settings pane and the practice page share (browser-safe, no imports). Stored as
   `settings.book` in the library settings, an optional key: absent until the learner saves, and a release that does not know it keeps it untouched.

   qaToBook: 'manual' (default) — a follow-up goes into the book when the learner selects 「加入复习全书」; 'auto' — the practice page adds each NEW
   follow-up or 帮我弄懂 answer itself, through the same op (book.qa.add). Only Q&A made in the practice page are added automatically. */
export const BOOK_DEFAULTS = Object.freeze({ qaToBook: 'manual' });
export const QA_TO_BOOK = Object.freeze(['manual', 'auto']);

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const valid = (key, value) => key === 'qaToBook' && QA_TO_BOOK.includes(value);

/** Forgiving read of an old or corrupt saved object; valid siblings survive. */
export function normalizeBookSettings(raw) {
  const source = object(raw) ? raw : {};
  return Object.fromEntries(Object.entries(BOOK_DEFAULTS).map(([key, fallback]) => [key, valid(key, source[key]) ? source[key] : fallback]));
}
export const resolveBookSettings = saved => normalizeBookSettings(saved);

/** Strict explicit patch: a wrong value fails before the library changes. */
export function validateBookPatch(patch) {
  if (!object(patch)) throw new Error('book settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(BOOK_DEFAULTS, key)) throw new Error(`Unknown book setting: ${key}`);
    if (!valid(key, value)) throw new Error(`Invalid book setting: ${key}`);
  }
  return { ...patch };
}
export const mergeBookSettings = (saved, patch) => ({ ...normalizeBookSettings(saved), ...validateBookPatch(patch) });
