/**
 * Tiny pure helpers shared by the selectors, the CLI reports and the host (#1354 D10): one definition each,
 * in a module with no React, Ink or Node I/O imports so `src/selectors/` stays pure.
 */

/** Collapse every whitespace run (newlines and tabs included) to one space and trim; non-strings become ''. */
export function singleLine(value: unknown): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  return text.replace(/\s+/g, ' ').trim();
}

/** Local-calendar `YYYY-MM-DD` key (never UTC), the one "today" every view and CLI report compares against. */
export function todayLocalYmd(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
