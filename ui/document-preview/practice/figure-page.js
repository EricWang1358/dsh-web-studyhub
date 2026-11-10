/* 看原页图 on a question card (issue #897, slice S1): which cited page of a question has a figure and an original to show. Pure apart from the
   backend calls it is handed. The same figure the reader marks with 看原页 (a lone placeholder paragraph: peek/peek-logic.js isFigurePlaceholder, the
   paragraphs of reader/text-sections.js), and the original the source dialog would find (materials.original.status). */
import { usableCitations, citationTarget } from './citations.js';
import { splitParagraphs } from '../reader/text-sections.js';
import { isFigurePlaceholder } from '../peek/peek-logic.js';

/** Whether the text of one page holds a figure placeholder of its own, exactly as the reader draws it. */
export const pageHasFigure = text => splitParagraphs(text).some(paragraph => isFigurePlaceholder(paragraph.text));

/** The material a page belongs to: what one answer about its original covers. */
const materialOf = source => source.document?.materialId || source.document?.id || source.id;

/**
 * The cited pages of `card` that can have an original page, in the order they are cited and once each: `{ source, quote, page }`, `source` carrying the
 * selection as a citation does. A PDF's pages only (a slide, a recording or a pasted text has no original page to look at).
 */
export function citedPages(card, sources = []) {
  const seen = new Set(), found = [];
  for (const citation of usableCitations(card, sources)) {
    const { document } = citation.source;
    if (!Number.isInteger(document?.page) || document.page < 1 || (citation.source.format || document.format || 'pdf') !== 'pdf' || seen.has(citation.source.id)) continue;
    seen.add(citation.source.id);
    found.push({ ...citationTarget(citation), page: document.page });
  }
  return found;
}

/**
 * The first cited page that has a figure while its material still has an original file: `{ source, quote, page }`, else null. Reads only what it needs:
 * nothing for a card with no cited page; one `source.get` per page until the first hit; `materials.original.status` (which hashes the whole kept file)
 * only for a page that does have a figure, once per material, so a native PDF, whose pages never hold a figure placeholder, never pays for it; once a
 * material is known to have no original its other pages are not read. A call that fails counts as "no" (the entry is a shortcut, never a gate).
 * `call(name, params)` is the study context's.
 */
export async function findFigurePage({ pages, call }) {
  const originals = new Map();
  const hasOriginal = async source => {
    const key = materialOf(source);
    if (!originals.has(key)) originals.set(key, Promise.resolve().then(() => call('materials.original.status', { sourceId: source.id })).then(value => value?.status === 'ok', () => false));
    return originals.get(key);
  };
  for (const found of pages) {
    const known = originals.get(materialOf(found.source));
    if (known && !await known) continue;
    const read = await Promise.resolve().then(() => call('source.get', { id: found.source.id })).catch(() => null);
    if (read && pageHasFigure(read.text) && await hasOriginal(found.source)) return found;
  }
  return null;
}
