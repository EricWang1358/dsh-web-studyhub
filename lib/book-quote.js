/* Where a quote of the 复习全书 stands in its materials: shared by the book build (lib/contexts/generation/book/read.js, the model's quotes) and the main
   chat's book.write (lib/book-agent-write.js, the footnotes it writes). A quote is kept only when it is found WORD FOR WORD in one of the passages
   (lib/quote-locate.js: as written, else by its letters and digits), and then it is the original's own words and place. Pure. */
import { createLocator } from './quote-locate.js';
import { NOTES_LIMITS } from './course-book.js';

/** A quote with fewer characters than this (spaces left out) is not a place: it would be found anywhere. */
export const BOOK_QUOTE_MIN = 8;

/**
 * Where `quote` stands in one of `segments` ([{ sourceId, start, text }]; `first` is tried first): { sourceId, quote (the original's words, spaces
 * squashed), start, end } in the source's own offsets, or null (too short, not found, or the original's words longer than `max`).
 */
export function locateQuote(segments, quote, { first = null, min = BOOK_QUOTE_MIN, max = NOTES_LIMITS.quoteChars } = {}) {
  const wanted = (typeof quote === 'string' ? quote.trim().slice(0, max) : '').replace(/\s+/g, ' ');
  if (wanted.replace(/\s/g, '').length < min) return null;
  const list = Array.isArray(segments) ? segments : [];
  for (const segment of first ? [first, ...list.filter(part => part !== first)] : list) {
    const at = createLocator(segment.text)(wanted);
    if (!at) continue;
    const words = segment.text.slice(at.start, at.end).replace(/\s+/g, ' ').trim();
    if (words.length > max) continue;
    return { sourceId: segment.sourceId, quote: words, start: (segment.start || 0) + at.start, end: (segment.start || 0) + at.end };
  }
  return null;
}
