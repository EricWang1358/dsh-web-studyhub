import { currentInventory } from '../../../course-book-inventory.js';
import { foundIn } from './merge.js';
import { courseRanges, inventoryCalls } from './ranges.js';

/* The plan of one inventory, pure: every range of every material of the course, which ranges an earlier inventory already read (same print: no call), and the
   calls for the rest. A range that failed before is asked again; a material that changed has new prints for its changed pages only. */

/**
 * @param documents the course's documents; `papers` a Set of document keys read as sample papers (not inventoried); `onlyDocs` an optional Set of document keys
 *        when filling one point's gaps (unread materials outside that point are left for a whole-book update).
 * @returns { previous (the course's inventory record or null), ranges, documents, reused: Map(print -> found items), calls, steps, onlyDocs? }
 */
export function planInventory(state, documents, { course, language, papers = new Set(), onlyDocs = null }) {
  const previous = currentInventory(state.sources, course), earlier = previous?.courseInventory.language === language ? previous.courseInventory : null;
  const scoped = onlyDocs ? documents.filter(doc => onlyDocs.has(doc.key) || (earlier?.documents || []).some(each => each.key === doc.key)) : documents;
  const { ranges, documents: docs } = courseRanges(state, scoped, { papers, language });
  const reused = new Map();
  for (const range of earlier?.ranges || []) if (range.status === 'read' && !reused.has(range.print)) reused.set(range.print, foundIn(earlier, range.key));
  const calls = inventoryCalls(ranges.filter(range => !reused.has(range.print) && (!onlyDocs || onlyDocs.has(range.doc))));
  return { previous, ranges, documents: docs, reused, calls, steps: calls.length, ...(onlyDocs ? { onlyDocs } : {}) };
}
