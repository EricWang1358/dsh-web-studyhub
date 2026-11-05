import { isPagedFormat } from '../lib/office/limits.js';
import { readJSON, writeJSON } from './storage.js';

/* 深度定制 (skills/study-custom): when the import list and the 解析历史 offer 「深度定制这本书」. The one decision lives here: a document of this many pages or
   more is a book worth asking about before anything is generated from it. The review book's 更多 menu offers 深度定制… for every course, whatever the pages. */
export const CUSTOM_BOOK_PAGES = 150;

/** Whether a document of `pages` pages is long enough to offer 深度定制这本书 on its row. */
export const offersCustom = pages => Number.isFinite(pages) && pages >= CUSTOM_BOOK_PAGES;

/**
 * The input of the custom.start hand-off for a finished import result of the import list ({ kind, format, documentId, pages, courses }), or null when the
 * row offers nothing: not a document, not a paged one (a pasted text has no pages to speak of), too short, or nothing to name the document by.
 */
export function customOfferOf(result) {
  if (result?.kind !== 'document' || !isPagedFormat(result.format) || !offersCustom(result.pages) || !result.documentId) return null;
  return { course: result.courses?.[0] ?? '', document: result.documentId, pages: result.pages };
}

/** The one wording of the offer on a document's row, and what its Tooltip says first (the hand-off adds its own rule after it). */
export const CUSTOM_BOOK_LABEL = '深度定制这本书';
export const CUSTOM_BOOK_WHAT = '让主会话问你几个选项，再决定这本书做什么；确认之前不生成任何东西';

/* The offer is made once: after the learner pressed 「深度定制这本书」 on a document's row, that row does not offer it again (the review book's 更多 still does).
   A per-browser memory, a convenience only: without storage the row simply offers it each time. */
const OFFERED_KEY = 'studyhub.custom.offered';
const offeredIds = () => { const value = readJSON(OFFERED_KEY, []); return Array.isArray(value) ? value : []; };

/** Whether 深度定制这本书 was already pressed for this document. */
export const customOffered = documentId => !!documentId && offeredIds().includes(documentId);

/** Remembers that it was pressed for this document (the newest 200 are kept). */
export function markCustomOffered(documentId) {
  if (!documentId) return;
  writeJSON(OFFERED_KEY, [...offeredIds().filter(id => id !== documentId), documentId].slice(-200));
}
