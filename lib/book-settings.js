/* 复习全书 settings (docs/plans/review-book.md M3): the one contract the Settings pane and the practice page share (browser-safe, no imports). Stored as
   `settings.book` in the library settings, an optional key: absent until the learner saves, and a release that does not know it keeps it untouched.

   qaToBook: 'manual' (default) — a follow-up goes into the book when the learner selects 「加入复习全书」; 'auto' — the practice page adds each NEW
   follow-up or 帮我弄懂 answer itself, through the same op (book.qa.add). Only Q&A made in the practice page are added automatically.
   pageLimit (M6): the most A4 pages the printed book may have (an exam's limit on the CP), a whole number 1–2000; absent (the default) when the learner
   set none, and `null` in a patch takes it away. The export dialog and the book's header compare the export's page estimate with it. */
export const BOOK_DEFAULTS = Object.freeze({ qaToBook: 'manual' });
export const QA_TO_BOOK = Object.freeze(['manual', 'auto']);
export const PAGE_LIMIT_MAX = 2000;

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validLimit = value => Number.isInteger(value) && value >= 1 && value <= PAGE_LIMIT_MAX;
const valid = (key, value) => (key === 'qaToBook' && QA_TO_BOOK.includes(value)) || (key === 'pageLimit' && validLimit(value));

/** Forgiving read of an old or corrupt saved object; valid siblings survive. */
export function normalizeBookSettings(raw) {
  const source = object(raw) ? raw : {};
  return { ...Object.fromEntries(Object.entries(BOOK_DEFAULTS).map(([key, fallback]) => [key, valid(key, source[key]) ? source[key] : fallback])),
    ...(validLimit(source.pageLimit) ? { pageLimit: source.pageLimit } : {}) };
}
export const resolveBookSettings = saved => normalizeBookSettings(saved);

/** Strict explicit patch: a wrong value fails before the library changes. */
export function validateBookPatch(patch) {
  if (!object(patch)) throw new Error('book settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(BOOK_DEFAULTS, key) && key !== 'pageLimit') throw new Error(`Unknown book setting: ${key}`);
    if (!(key === 'pageLimit' && value === null) && !valid(key, value)) throw new Error(`Invalid book setting: ${key}`);
  }
  return { ...patch };
}
export function mergeBookSettings(saved, patch) {
  const next = { ...normalizeBookSettings(saved), ...validateBookPatch(patch) };
  if (next.pageLimit === null) delete next.pageLimit;
  return next;
}
