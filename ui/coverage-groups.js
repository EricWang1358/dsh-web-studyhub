import { groupSourcesByDocument } from '../lib/source-groups.js';
import { cleanDocumentName } from '../lib/document-title.js';

/* The per-source coverage list of a draft, by document (#201): the rows the generation recorded are one per source (one per PDF page), so a book
   shows up once per page with its whole file name. Grouped, the book is named once (as the 资料 page names it, without the file's extension or
   the site's noise) and its pages are listed under it; the count says 页 when everything counted is a page, 份 otherwise. Pure. */

const PAGE_IN_TITLE = /\s·\s(?:p\.\s?(\d+)|第\s?(\d+)\s?页)$/;

/**
 * `rows` are the draft's coverage rows `{ id, title, planned?, accepted? }`, `sources` the library's sources (how a row's document and page are known).
 * @returns `[{ key, title, rows: [{ id, page, planned, accepted }], accepted, planned, covered }]` in order of first appearance, pages in page order;
 *   `page` is a number for a page of a PDF or a slide deck, null for a material that is a document by itself.
 */
export function coverageGroups(rows, sources) {
  const known = new Map();
  for (const item of groupSourcesByDocument(Array.isArray(sources) ? sources : []))
    for (const entry of item.pages) known.set(entry.sourceId, { key: item.key, title: item.title, page: item.format === 'pdf' || item.format === 'pptx' ? entry.page : null });
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    let meta = known.get(row.id);
    if (!meta) {
      // The source is gone from the library: the page number and the document's name are still in the title it was recorded with.
      const title = String(row.title ?? ''), found = PAGE_IN_TITLE.exec(title);
      meta = found ? { key: `title:${cleanDocumentName(title.replace(PAGE_IN_TITLE, ''))}`, title: title.replace(PAGE_IN_TITLE, ''), page: Number(found[1] || found[2]) }
        : { key: `source:${row.id}`, title, page: null };
    }
    if (!groups.has(meta.key)) groups.set(meta.key, { key: meta.key, title: cleanDocumentName(meta.title), rows: [], accepted: 0, planned: 0, covered: 0 });
    const group = groups.get(meta.key), accepted = Number(row.accepted) || 0, planned = Number(row.planned) || 0;
    group.rows.push({ id: row.id, page: meta.page, planned, accepted });
    group.accepted += accepted; group.planned += planned; if (accepted > 0) group.covered += 1;
  }
  return [...groups.values()].map((group) => ({ ...group, rows: group.rows.map((row, index) => ({ row, index })).sort((a, b) => (a.row.page ?? 0) - (b.row.page ?? 0) || a.index - b.index).map(({ row }) => row) }));
}

/** 页 when every counted row is a page of a document, 份 when any is a material of its own. */
export const coverageUnit = (groups) => (groups.length && groups.every((group) => group.rows.every((row) => row.page !== null)) ? '页' : '份');
