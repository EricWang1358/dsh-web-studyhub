/* 复习全书 settings (docs/plans/review-book.md M3): the one contract the Settings pane and the practice page share (browser-safe, no imports). Stored as
   `settings.book` in the library settings, an optional key: absent until the learner saves, and a release that does not know it keeps it untouched.

   qaToBook: 'manual' (default) — a follow-up goes into the book when the learner selects 「加入复习全书」; 'auto' — the practice page adds each NEW
   follow-up or 帮我弄懂 answer itself, through the same op (book.qa.add). Only Q&A made in the practice page are added automatically.
   pageLimit (M6): the most A4 pages the printed book may have (an exam's limit on the CP), a whole number 1–2000; absent (the default) when the learner
   set none, and `null` in a patch takes it away. The export dialog and the book's header compare the export's page estimate with it.
   crunchWindowDays (M7): how many days before a course's exam date its 期末一周 plan shows (the home card, the book's 「今天读哪几节」), a whole number
   1–60; absent (the default, 21 days) until the learner sets one, and `null` in a patch takes it away.
   crunchMinutes (M7): the minutes a day of that plan holds (60, 90, 120, 180 or 240 in 设置 › 练习; any whole number 15–960 is kept), absent = 180. */
export const BOOK_DEFAULTS = Object.freeze({ qaToBook: 'manual' });
export const QA_TO_BOOK = Object.freeze(['manual', 'auto']);
export const PAGE_LIMIT_MAX = 2000;
export const CRUNCH_WINDOW = Object.freeze({ min: 1, max: 60, days: 21 });
export const CRUNCH_MINUTES = Object.freeze({ min: 15, max: 960, minutes: 180 });

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validLimit = value => Number.isInteger(value) && value >= 1 && value <= PAGE_LIMIT_MAX;
const validWindow = value => Number.isInteger(value) && value >= CRUNCH_WINDOW.min && value <= CRUNCH_WINDOW.max;
const validMinutes = value => Number.isInteger(value) && value >= CRUNCH_MINUTES.min && value <= CRUNCH_MINUTES.max;
// The optional keys: absent until set, `null` in a patch takes one away.
const OPTIONAL = Object.freeze({ pageLimit: validLimit, crunchWindowDays: validWindow, crunchMinutes: validMinutes });
const valid = (key, value) => (key === 'qaToBook' && QA_TO_BOOK.includes(value)) || (Object.hasOwn(OPTIONAL, key) && OPTIONAL[key](value));

/** Forgiving read of an old or corrupt saved object; valid siblings survive. */
export function normalizeBookSettings(raw) {
  const source = object(raw) ? raw : {};
  return { ...Object.fromEntries(Object.entries(BOOK_DEFAULTS).map(([key, fallback]) => [key, valid(key, source[key]) ? source[key] : fallback])),
    ...Object.fromEntries(Object.entries(OPTIONAL).filter(([key, check]) => check(source[key])).map(([key]) => [key, source[key]])) };
}
export const resolveBookSettings = saved => normalizeBookSettings(saved);
/** The days before an exam its 期末一周 shows (the saved crunchWindowDays, else 21). */
export const crunchWindow = saved => normalizeBookSettings(saved).crunchWindowDays ?? CRUNCH_WINDOW.days;
/** The minutes a day of 期末一周 holds (the saved crunchMinutes, else 180). */
export const crunchMinutes = saved => normalizeBookSettings(saved).crunchMinutes ?? CRUNCH_MINUTES.minutes;

/** Strict explicit patch: a wrong value fails before the library changes. */
export function validateBookPatch(patch) {
  if (!object(patch)) throw new Error('book settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(BOOK_DEFAULTS, key) && !Object.hasOwn(OPTIONAL, key)) throw new Error(`Unknown book setting: ${key}`);
    if (!(Object.hasOwn(OPTIONAL, key) && value === null) && !valid(key, value)) throw new Error(`Invalid book setting: ${key}`);
  }
  return { ...patch };
}
export function mergeBookSettings(saved, patch) {
  const next = { ...normalizeBookSettings(saved), ...validateBookPatch(patch) };
  for (const key of Object.keys(OPTIONAL)) if (next[key] === null) delete next[key];
  return next;
}
