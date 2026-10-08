import { BLUEPRINT_LIMITS } from '../../../exam-blueprint-material.js';
import { QUOTE_MIN } from './constants.js';

/* Where a quote of the model is in a material: ONE matcher for the papers and the slides.

   The library's resolver (lib/contexts/materials/positions.js) finds a quote by collapsing white space only. A quote that was only equal after NFKC (half-width brackets
   for full-width ones) would pass a looser check and then be lost at the resolver. So the quote is located here with NFKC and collapsed white space, and what is stored is
   the exact slice of the material's own text (white space collapsed), which the resolver then finds again. */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SPACE = /\s/u;

/** The text as the matcher reads it: every character in NFKC, every run of white space one space; `starts` and `ends` map each unit of `value` back to its range in `text`. */
export function foldText(text) {
  const source = String(text ?? ''), starts = [], ends = [];
  let value = '';
  for (let index = 0; index < source.length;) {
    const size = source.codePointAt(index) > 0xffff ? 2 : 1, char = source.slice(index, index + size);
    if (SPACE.test(char)) {
      let stop = index + size;
      while (stop < source.length && SPACE.test(source[stop])) stop++;
      value += ' '; starts.push(index); ends.push(stop); index = stop;
      continue;
    }
    const folded = char.normalize('NFKC');
    for (let at = 0; at < folded.length; at++) { starts.push(index); ends.push(index + size); }
    value += folded; index += size;
  }
  return { value, starts, ends };
}

/** Is a (folded) quote long enough to be a place, and not just a word that happens to be there? */
export function isMeaningful(folded) {
  const length = [...folded].filter(char => !SPACE.test(char)).length;
  return length >= (CJK.test(folded) ? QUOTE_MIN.cjk : QUOTE_MIN.other);
}

/** @returns { quote, start, end }: `quote` is the slice of `text` the model's quote stands for; null when it is too short, not in the text, or longer than a place may be. */
export function locateQuote(text, quote) {
  const needle = foldText(quote).value.trim();
  if (!isMeaningful(needle)) return null;
  const haystack = foldText(text), at = haystack.value.indexOf(needle);
  if (at < 0) return null;
  const start = haystack.starts[at], end = haystack.ends[at + needle.length - 1];
  const slice = String(text).slice(start, end).replace(/\s+/g, ' ');
  return slice.length <= BLUEPRINT_LIMITS.quoteChars ? { quote: slice, start, end } : null;
}

/** The first of `items` ({ id, text }) that holds the quote: `{ sourceId, quote }` with the quote as the item's own words, else null. */
export function locateIn(items, quote) {
  for (const item of items) {
    const found = quote ? locateQuote(item.text, quote) : null;
    if (found) return { sourceId: item.id, quote: found.quote };
  }
  return null;
}
