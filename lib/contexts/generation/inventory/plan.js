import { currentInventory } from '../../../course-book-inventory.js';
import { foundIn } from './merge.js';
import { courseRanges, inventoryCalls } from './ranges.js';
import { readsRange } from '../book/pick-pages.js';

/* The plan of one inventory, pure: every range of every material of the course, which ranges an earlier inventory already read (same print: no call), and the
   calls for the rest. A range that failed before is asked again; a material that changed has new prints for its changed pages only. */

/**
 * @param documents the course's documents; `papers` a Set of document keys read as sample papers (not inventoried); `only` an optional scope (book/pick-pages.js:
 *        Map(document key -> its pages, or null for all of them)) when a build reads only some points or chapters (what else is unread is left for a later build).
 * @returns { previous (the course's inventory record or null), ranges, documents, reused: Map(print -> found items), calls, steps, onlyDocs? }
 */
export function planInventory(state, documents, { course, language, papers = new Set(), only = null }) {
  const onlyDocs = only ? new Set(only.keys()) : null, previous = currentInventory(state.sources, course), earlier = previous?.courseInventory.language === language ? previous.courseInventory : null;
  const scoped = onlyDocs ? documents.filter(doc => onlyDocs.has(doc.key) || (earlier?.documents || []).some(each => each.key === doc.key)) : documents;
  const { ranges, documents: docs } = courseRanges(state, scoped, { papers, language });
  const reused = new Map();
  for (const range of earlier?.ranges || []) if (range.status === 'read' && !reused.has(range.print)) reused.set(range.print, foundIn(earlier, range.key));
  const calls = inventoryCalls(ranges.filter(range => !reused.has(range.print) && (!only || readsRange(only, range))));
  return { previous, ranges, documents: docs, reused, calls, steps: calls.length, ...(onlyDocs ? { onlyDocs } : {}) };
}
