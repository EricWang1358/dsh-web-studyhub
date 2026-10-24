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

/**
 * The page scope of the 原始 PDF view: { kind: 'page', page, sourceId, empty }. `empty` when the page has no saved text (a scanned or
 * picture page, or one skipped on import): nothing can be answered from it, so the panel says so instead of spending a call.
 */
export function pageScopeOf(sources = [], page) {
  const source = sources.find(item => item.document?.page === page);
  const chars = !source ? 0 : typeof source.text === 'string' ? source.text.trim().length : Number(source.chars) || 0;
  return { kind: 'page', page, sourceId: source?.id || '', empty: chars === 0 };
}

/** The selection a page question names (materials.selection.ask with scope 'page'): the document, its revision and the page, no quote. */
export function pageSelection(document, scope) {
  if (scope?.kind !== 'page' || scope.empty) return null;
  return { ...(document?.documentId || document?.id ? { documentId: document.documentId || document.id } : {}),
    ...(document?.revision ? { revision: document.revision } : {}), ...(scope.sourceId ? { sourceId: scope.sourceId } : {}), page: scope.page };
}

/** The key a page's unsaved thread is held under while the reader is open (a passage's is its offsets and words). */
export const pageKey = selection => selection ? `page|${selection.documentId || ''}|${selection.revision || ''}|${selection.sourceId || ''}|${selection.page}` : '';
