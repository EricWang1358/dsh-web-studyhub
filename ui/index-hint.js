import { documentIndexState } from './index-coverage.js';
import { CUSTOM_BOOK_PAGES, offersCustom } from './custom-entry.js';
import { NEEDS_INDEX } from './index-scope.js';
import { openIndexBuilder } from './index-focus.js';
import { readJSON, writeJSON } from './storage.js';

/* The hint that points a book of 150 pages or more at the search index (ui/IndexHint.jsx). Owner 2026-11-06: the index is built in Settings, nobody saw it
   there, and nobody knew what it was for. Wherever a big book is offered 深度定制 or a whole-book run, one quiet line says: build the index first (it runs on this
   computer, uses no tokens, and then a whole-book run reads only the relevant pages), with a button that opens 设置 › 检索扩展 with the book's course chosen.
   The state is the one the badges read (retrieval.index.coverage, ui/index-coverage.js); nothing new is asked of the backend. The decision lives here, pure. */

/** A book is "big" for this hint at the same length from which 深度定制这本书 is offered. */
export const INDEX_HINT_PAGES = CUSTOM_BOOK_PAGES;

/* The offer is made once per document: after the button was pressed or the hint dismissed it is not offered again (the badge on the 资料 page still is).
   A per-browser memory, a convenience only: without storage the hint is simply offered each time. */
const HINTED_KEY = 'studyhub.index.hinted';
const hintedIds = () => { const value = readJSON(HINTED_KEY, []); return Array.isArray(value) ? value : []; };

/** Whether the hint was already used or dismissed for this document. */
export const indexHinted = key => !!key && hintedIds().includes(key);

/** Remembers that the hint was used or dismissed for this document (the newest 200 are kept). */
export function markIndexHinted(key) {
  if (!key) return;
  writeJSON(HINTED_KEY, [...hintedIds().filter(id => id !== key), key].slice(-200));
}

/** A grouped material (groupSourcesByDocument: `pages` is the list) or a finished import's result (`pages` is the count) as the hint reads it: { key, sourceIds, pages (with text), courses }. */
export const hintDocOf = item => ({ key: item?.documentId || item?.key || '', sourceIds: item?.sourceIds ?? [], pages: Array.isArray(item?.pages) ? item.pages.length : Number(item?.pages) || 0, courses: item?.courses ?? [] });

/**
 * The book to name, as { doc, canIndex }, or null when there is nothing to say: no book of INDEX_HINT_PAGES pages or more, its index is built (or being built),
 * the hint was already used for it (unless `once` is false: the menu item of the book keeps offering it), or the coverage is not known (not read yet, or the
 * host has no search component). `canIndex` false: the extension is not installed, so the button leads to its install step.
 */
export function indexHintFor(docs, coverage, { once = true } = {}) {
  if (!coverage) return null;
  for (const doc of docs || []) {
    if (!offersCustom(doc.pages) || (once && indexHinted(doc.key))) continue;
    const info = documentIndexState({ sourceIds: doc.sourceIds }, coverage, { big: true });
    if (info && NEEDS_INDEX.has(info.state)) return { doc, canIndex: coverage.canIndex !== false };
  }
  return null;
}

/** The button: counts as the one offer, then opens 设置 › 检索扩展 with the course of the book chosen (the same navigation as the badge's 建立索引). */
export function goIndex(openSettings, hint) {
  markIndexHinted(hint.doc.key);
  openIndexBuilder(openSettings, hint.doc.courses?.[0] || '');
}
