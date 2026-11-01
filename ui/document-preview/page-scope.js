import { joinPages, PAGE_RANGE_MAX } from '../../lib/ask-prompt.js';

/*
 * The scope of a question in the learning panel (issue #456). In 阅读 and 原文 it is the selected passage; in 原始 PDF the learner cannot
 * select (the PDF is drawn in a frame whose selection never reaches the page), so the question is about the current page instead: the
 * page our own controls (previous / next / page number) show, never a guess from scrolling inside the frame, which cannot be observed.
 */

/** The number of pages of a paged document: the count its pages carry, else how many there are. */
export const pageCount = (sources = []) => Math.max(0, ...sources.map(item => item.document?.totalPages || 0)) || sources.length;

/** A page number typed or stepped to, kept inside 1..total; null for something that is not a number. */
export function clampPage(value, total) {
  const number = typeof value === 'string' && !value.trim() ? NaN : Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(1, number), Math.max(1, total || 1));
}

const charsOf = source => (!source ? 0 : typeof source.text === 'string' ? source.text.trim().length : Number(source.chars) || 0);

/** The pages a scope names, in order. */
export const pagesOf = scope => (scope?.to ? Array.from({ length: scope.to - scope.page + 1 }, (_, index) => scope.page + index) : [scope?.page]);
/** How a scope's pages are written after 第: 3, or 3–5. */
export const pagesLabel = scope => (scope?.to ? `${scope.page}–${scope.to}` : String(scope?.page));

/**
 * The page scope of the 原始 PDF view: { kind: 'page', page, sourceId, empty }. `empty` when the page has no saved text (a scanned or
 * picture page, or one skipped on import): nothing can be answered from it, so the panel says so instead of spending a call.
 * With `to` (#488) it is a range: { ..., to, emptyPages, chars (what the answer counts: the marked text, pagesText) }, `empty` only when no page of it has text; a page without text is named, and the others are still asked about.
 */
export function pageScopeOf(sources = [], page, to) {
  const at = number => sources.find(item => item.document?.page === number);
  if (!to || to <= page) { const source = at(page); return { kind: 'page', page, sourceId: source?.id || '', empty: charsOf(source) === 0 }; }
  const pages = pagesOf({ page, to }), emptyPages = pages.filter(number => charsOf(at(number)) === 0);
  return { kind: 'page', page, to, sourceId: '', empty: emptyPages.length === pages.length, emptyPages, chars: pagesText(sources, { page, to }).length };
}

/** The end of a range typed on `page`, held to the file and to PAGE_RANGE_MAX: { to, cut } (cut: the limit changed it, the panel says so); null for what is not a number. */
export function clampRangeEnd(value, page, total) {
  const typed = typeof value === 'string' && !value.trim() ? NaN : Math.round(Number(value));
  if (!Number.isFinite(typed)) return null;
  const inFile = Math.max(page, total ? Math.min(typed, total) : typed), to = Math.min(inFile, page + PAGE_RANGE_MAX - 1);
  return { to, cut: to < inFile };
}

/** The saved text a scope names: one page's as it is; a range's with each page marked, as the answer gets it (lib/ask-prompt.js joinPages). */
export function pagesText(sources = [], scope) {
  const textOf = number => sources.find(item => item.document?.page === number)?.text || '';
  if (!scope?.to) return textOf(scope?.page);
  return joinPages(pagesOf(scope).map(page => ({ page, text: textOf(page) })).filter(item => item.text.trim()));
}

/** The selection a page question names (materials.selection.ask with scope 'page'): the document, its revision and the page or the range's two ends, no quote. */
export function pageSelection(document, scope) {
  if (scope?.kind !== 'page' || scope.empty) return null;
  return { ...(document?.documentId || document?.id ? { documentId: document.documentId || document.id } : {}),
    ...(document?.revision ? { revision: document.revision } : {}), ...(scope.sourceId ? { sourceId: scope.sourceId } : {}), page: scope.page, ...(scope.to ? { to: scope.to } : {}) };
}

/** The key a page's unsaved thread is held under while the reader is open (a passage's is its offsets and words). */
export const pageKey = selection => selection ? `page|${selection.documentId || ''}|${selection.revision || ''}|${selection.sourceId || ''}|${selection.page}${selection.to ? `-${selection.to}` : ''}` : '';
