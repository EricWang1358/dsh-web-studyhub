import { parseJson } from '../../../../generation.js';
import { confusableRows } from '../../../../course-book-confusables.js';

/* Reading the answer of one confusable-pairs call (#710 S3). Nothing is trusted: an answer that is not the shape asked for is null (asked once more); a pair id that
   was not asked is ignored, and a pair is answered once, by its first answer; a row with an unknown aspect or a missing cell is dropped (the shared check,
   lib/course-book-confusables.js), and a pair left with no row is not answered (asked again by the next build). */

const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** @returns null, or Map(index of the pair in the call -> its rows [{ aspect, cells: [a, b] }]). */
export function readConfusables(text, batch) {
  let value;
  try { value = parseJson(String(text)); } catch { return null; }
  if (!object(value) || !Array.isArray(value.pairs)) return null;
  const at = new Map(batch.pairs.map((pair, index) => [pair.alias, index])), answers = new Map();
  for (const raw of value.pairs.filter(object)) {
    const index = at.get(String(raw.id ?? '').trim());
    if (index === undefined || answers.has(index)) continue;
    const rows = confusableRows((Array.isArray(raw.rows) ? raw.rows : []).filter(object).map(row => ({ aspect: row.aspect, cells: [row.a, row.b] })));
    if (rows.length) answers.set(index, rows);
  }
  return answers;
}
