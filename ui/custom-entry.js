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

/* The entry that stays: a document of CUSTOM_BOOK_PAGES pages or more has 「深度定制」 on its 资料 row all the time, not once (ui/Sources.jsx, beside 查看 N 章). Once its
   course has a plan (the course record's `custom`) the same place reads 「查看/修改定制」 and the hand-off asks only about what changed. */
export const CUSTOM_ROW_LABEL = '深度定制';
export const CUSTOM_ROW_EDIT_LABEL = '查看/修改定制';
export const CUSTOM_ROW_EDIT_WHAT = '这门课已经有定制方案：让主会话先说给你听，只问你想改的地方；确认之前不改任何东西';

/** The pages of a document row (the pages that have text, as the row says them): 0 for anything that is not a paged document or is archived. */
const pagesOfRow = item => (item && !item.archived && isPagedFormat(item.format) ? item.pages?.length || 0 : 0);
const planOf = (records, name) => (Array.isArray(records) ? records.find(record => record?.name === name)?.custom : undefined);

/**
 * The input of the custom.start hand-off for a document's 资料 row ({ course, document, pages, hasCustom }), or null when the row offers nothing (not a paged
 * document, too short, archived). Of several courses the one that already has a plan is named, else the first; in none, ''.
 */
export function customRowOffer(item, records) {
  const pages = pagesOfRow(item);
  if (!offersCustom(pages)) return null;
  const names = item.courses ?? [], planned = names.find(name => planOf(records, name));
  return { course: planned ?? names[0] ?? '', document: item.documentId || item.key, pages, hasCustom: planned !== undefined };
}

/**
 * Whether the whole-book buttons of the 总纲 page (生成总纲, 生成复习全书) ask first: `course` has a document of CUSTOM_BOOK_PAGES pages or more (`items`: the
 * documents of lib/source-groups.js; `within(item)`: whether one belongs to the course) and no custom plan (`records`: the course records). -> { pages (the largest),
 * document (the key, when there is exactly one such document, else ''), docPages (its pages, else 0) } or null.
 */
export function customGateOf({ items, course, records, within }) {
  if (typeof course !== 'string' || planOf(records, course)) return null;
  const big = (items ?? []).filter(item => within(item) && offersCustom(pagesOfRow(item)));
  if (!big.length) return null;
  const pages = Math.max(...big.map(pagesOfRow));
  return big.length === 1 ? { pages, document: big[0].documentId || big[0].key, docPages: pages } : { pages, document: '', docPages: 0 };
}
