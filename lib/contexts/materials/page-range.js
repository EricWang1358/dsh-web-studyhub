import { PAGE_RANGE_MAX } from './ask-prompt.js';

/* A page question about several pages (#488, the 原始 PDF view). The range is named by its two ends, and held to PAGE_RANGE_MAX pages here too. Unlike one page, a page
   without saved text does not refuse the question (a picture on page 3 and the text on page 5 is the case this exists for): it is named, and only a range with
   no text at all is refused. */

/**
 * pageRangeState({ documentId, revision, records, from, to }) -> { status: 'resolved', selection, pages: [{ page, text }], emptyPages } | missing (reason empty) | ambiguous.
 * records: the sources of the document's current revision.
 */
export function pageRangeState({ documentId, revision, records, from, to }) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) throw new Error('A page range runs from a page to a later page');
  const last = Math.min(to, from + PAGE_RANGE_MAX - 1, Math.max(from, ...records.map(source => source.document?.page || 0)));
  const inRange = records.filter(source => source.document?.page >= from && source.document?.page <= last)
    .sort((one, other) => one.document.page - other.document.page);
  if (new Set(inRange.map(source => source.document.page)).size !== inRange.length)
    return { status: 'ambiguous', currentRevision: revision, message: 'More than one source has one of these pages.' };
  const withText = inRange.filter(source => (source.text || '').trim());
  if (!withText.length) return { status: 'missing', reason: 'empty', currentRevision: revision, page: from, message: 'These pages have no saved text to answer from.' };
  const told = new Set(withText.map(source => source.document.page));
  return { status: 'resolved', currentRevision: revision, pages: withText.map(source => ({ page: source.document.page, sourceId: source.id, text: source.text })),
    emptyPages: Array.from({ length: last - from + 1 }, (_, index) => from + index).filter(page => !told.has(page)),
    selection: { documentId, revision, sourceId: withText[0].id, start: 0, end: withText[0].text.length, page: from, to: last } };
}
