/* The pure rules of the reader's marks (materials.marks.*): the learner's own underline, bold and highlighter strokes on a passage, and the
   passages put aside for one later question run (待出题). No store, no model, no DOM: the backend (contexts/materials/mark-operations.js) and the
   reader (ui/document-preview/marks/) share these, as lib/annotation.js is shared by the 批注.

   A mark is anchored exactly like an annotation: by source and stored offsets, checked by the hash of the words between them, kept per document
   REVISION beside the document's own records. One passage holds at most one mark of each style; marking it again in the same style is a no-op. */
import { passageKey } from '../../annotation.js';
import { textHash } from '../../passage-translation.js';

/** underline / bold / highlight are drawn on the text; queue is a passage waiting for 一次性出题 (drawn quietly, listed under 待出题). */
export const MARK_STYLES = Object.freeze(['underline', 'bold', 'highlight', 'queue']);
export const DRAWN_STYLES = Object.freeze(['underline', 'bold', 'highlight']);

export const MARK_LIMITS = Object.freeze({
  /** Marks kept in one document revision (all styles); a full revision refuses more with a plain message. */
  items: 600,
  /** Passages waiting in one material's 待出题 list. */
  queue: 40,
  quote: 4000, context: 80, stale: 20,
});

export { passageKey, textHash };

/** The style a caller asked for, or a plain Error. */
export function markStyle(value) {
  if (!MARK_STYLES.includes(value)) throw new Error(`style must be one of ${MARK_STYLES.join(', ')}`);
  return value;
}

/** The id of a mark: its passage and its style, so the same stroke twice is one mark. */
export const markId = (key, style) => `${style}|${key}`;

/** A stored mark as the reader gets it; `resolved` says whether the passage is still where the mark says (its words hash the same). */
export const markView = (item, resolved) => ({ id: item.id, key: item.key, style: item.style,
  selection: { sourceId: item.sourceId, start: item.start, end: item.end, quote: item.quote, prefix: item.prefix || '', suffix: item.suffix || '', ...(item.page ? { page: item.page } : {}) },
  status: resolved ? 'resolved' : 'stale', at: item.at });

/** Stored marks in reading order: by the order of the document's sources, then by where they start. */
export function readingOrder(items, sourceOrder = new Map()) {
  return [...items].sort((a, b) => (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0) || a.start - b.start || a.end - b.end || String(a.at).localeCompare(String(b.at)));
}
