/* The digits of clocks, ordinals and day keys: no words, no interface language, so the logic modules that run in plain Node can use them.
   ui/format.js re-exports every name here; pages import from there. */

const pad = (value) => String(value).padStart(2, '0');

/**
 * The clock of a running or counted-down thing: m:ss, h:mm:ss from one hour. Whole seconds, rounded DOWN, so a clock
 * never shows a second that has not finished (a countdown reads 0:00 only when it is over by a whole second).
 */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** A position in a list as two digits: 1 -> "01", 12 -> "12" (a step number, a chapter number). */
export const formatIndex = (position) => pad(Math.max(0, Math.floor(Number(position) || 0)));

/** A local calendar day as YYYY-MM-DD: the key of a day, not text for the learner. */
export const isoDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
