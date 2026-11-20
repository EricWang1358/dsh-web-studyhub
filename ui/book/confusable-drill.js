// @ts-check

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ASCII_WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Pure 0-token masker for 「速查页 › 易混概念」 opt-in self-check (`settings.book.confusableDrill`).
 * Replaces pair concept names inside table cells before reveal so learners identify concepts by
 * "when to use / key difference / common mistake" cues first. Leading/trailing ASCII word characters
 * enforce word boundaries so single letters ("A" vs "an array") or mixed labels ("(foo) bar" vs "barbie") stay safe.
 *
 * @param {string} text
 * @param {string[]} names
 * @param {string} [placeholder]
 * @returns {string}
 */
export function maskConceptNames(text, names, placeholder = '___') {
  const input = String(text ?? '');
  if (!input || !Array.isArray(names) || !names.length) return input;
  const cleaned = [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  if (!cleaned.length) return input;
  const parts = cleaned.map((term) => {
    const escaped = escapeRe(term);
    const lead = ASCII_WORD_CHAR.test(term[0]) ? '\\b' : '';
    const tail = ASCII_WORD_CHAR.test(term[term.length - 1]) ? '\\b' : '';
    return `${lead}${escaped}${tail}`;
  });
  const pattern = new RegExp(parts.join('|'), 'gi');
  return input.replace(pattern, placeholder);
}

/** Supported self-check mask modes on C001 confusable tables (`settings.book.confusableDrill`). */
export const CONFUSABLE_MASK_MODES = Object.freeze(['names', 'difference', 'mistake']);

/** True when at least one confusable pair contains a row for `aspect`. */
export const hasConfusableAspect = (confusables, aspect) => Array.isArray(confusables)
  && confusables.some(pair => Array.isArray(pair?.rows) && pair.rows.some(row => row?.aspect === aspect));

/**
 * Mask one cell of a C001 confusable table according to `mode`:
 * - `'names'`: masks concept names inside every cell (original #1145 behavior);
 * - `'difference'` / `'mistake'`: keeps concept names visible and masks the target column's cells before reveal.
 */
export function maskConfusableCell({ aspect, cell, names, mode = 'names', placeholder = '___' }) {
  if (mode === 'names') return maskConceptNames(cell, names, placeholder);
  return aspect === mode ? placeholder : String(cell ?? '');
}
