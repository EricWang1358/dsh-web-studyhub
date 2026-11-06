/* The chapters of a converted book imported under an older chapter rule, read again from its own stored pages, so a book gets the chapters of
   today's rule (lib/heading-levels.js, lib/converted-document.js chaptersOfPages) without being converted again. Pure, no I/O, no Node modules
   (the browser bundle imports lib/source-groups.js and lib/source-query.js, which use it).

   An import stamps each page of a converted book with its chapter (`document.chapter`) and names its revision with the rule's tag
   (`…-conv3`, CONVERTED_REVISION_TAG; restoreRepeated adds `-whole`). A page of an older tag (conv1, conv2) is stamped again here, from the
   texts of all the pages of its revision: only when every page has its text (the panel's snapshot has none: it is stamped before its texts are
   dropped) and the library's document records say every page of that revision is here — a selection of some pages says nothing of the book's
   chapters, so it keeps its stamps (restampSelection reads such a selection with the rest of its book from the library). Without those records
   there is no page count to hold the pages against, so nothing is read again. A page with no such tag (not stored by the materials import), of a
   superseded revision (`historical`) or already read again (`chapterRule`) keeps its stamps. The answers are kept for the last few books read
   (the snapshot is taken on every poll). */
import { chaptersOfPages, chapterIndexForPage } from './converted-document.js';

/** The revision tag of a converted book stamped with today's chapter rule; a smaller one is read again. */
export const CONVERTED_REVISION_TAG = 'conv3';
const RULE = Number(CONVERTED_REVISION_TAG.slice(4));
const TAG = /-conv(\d+)(?:-|$)/;
const KEPT = 16;
const remembered = new Map();

const isStale = source => {
  const document = source?.document;
  const tag = TAG.exec(String(document?.materialRevision ?? ''));
  return document?.origin === 'converted' && Number.isInteger(document.page) && typeof source.id === 'string' && !source.historical
    && document.chapterRule !== CONVERTED_REVISION_TAG && !!tag && Number(tag[1]) < RULE;
};
const bookKey = document => `${document.materialId ?? ''}\u0000${document.materialRevision ?? ''}\u0000${document.id ?? ''}`;

/** Every page of the revision is here, as the library's record of that revision says. No record of it: no page count to hold the pages against, and
    a part of a book says nothing of the book's chapters. */
function whole(pages, documents) {
  const { materialId, materialRevision } = pages[0].document;
  const version = (Array.isArray(documents) ? documents : []).find(document => document?.id === materialId)?.versions?.find(item => item?.revision === materialRevision);
  if (!Array.isArray(version?.sourceIds)) return false;
  const held = new Set(pages.map(source => source.id));
  return version.sourceIds.every(id => held.has(id));
}

/** Map(source id -> { index, title, level } | null (front matter)) for the pages of one book, by today's rule. */
function stampsOf(key, pages) {
  const ordered = [...pages].sort((a, b) => a.document.page - b.document.page);
  const memo = `${key}\u0000${ordered.length}\u0000${ordered.reduce((sum, source) => sum + source.text.length, 0)}`;
  if (remembered.has(memo)) {
    // The most recently read books stay.
    const stamps = remembered.get(memo);
    remembered.delete(memo); remembered.set(memo, stamps);
    return stamps;
  }
  const totalPages = Math.max(0, ...ordered.map(source => Number(source.document.totalPages) || source.document.page));
  const { chapters } = chaptersOfPages(ordered.map(source => ({ page: source.document.page, text: source.text })), totalPages);
  const stamps = new Map(ordered.map(source => {
    const index = chapterIndexForPage(chapters, source.document.page);
    return [source.id, index < 0 ? null : { index, title: chapters[index].title, level: chapters[index].level }];
  }));
  remembered.set(memo, stamps);
  if (remembered.size > KEPT) remembered.delete(remembered.keys().next().value);
  return stamps;
}

/** `sources` with the pages of older converted books stamped with today's chapters and marked read (`chapterRule`, see above; `chapterMoved` on a page
    whose chapter is another one than it was stored with); the same array when there is none to read. */
export function restampConvertedChapters(sources, { documents } = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const books = new Map();
  for (const source of list) {
    if (!isStale(source)) continue;
    const key = bookKey(source.document);
    if (!books.has(key)) books.set(key, []);
    books.get(key).push(source);
  }
  if (!books.size) return sources;
  const stamps = new Map();
  for (const [key, pages] of books) {
    if (!pages.every(source => typeof source.text === 'string') || !whole(pages, documents)) continue;
    for (const [id, stamp] of stampsOf(key, pages)) stamps.set(id, stamp);
  }
  if (!stamps.size) return sources;
  return list.map(source => {
    if (!stamps.has(source?.id) || !isStale(source)) return source;
    const stamp = stamps.get(source.id), { chapter: was, ...document } = source.document;
    // A page whose chapter is another one now (its index or title): a chapter id saved before may name another chapter (lib/custom-skeleton.js chosenChapters).
    const moved = stamp ? !(Number.isInteger(was?.index) && was.index === stamp.index && String(was.title ?? '') === stamp.title) : Number.isInteger(was?.index);
    return { ...source, document: { ...document, ...(stamp ? { chapter: stamp } : {}), chapterRule: CONVERTED_REVISION_TAG, ...(moved ? { chapterMoved: true } : {}) } };
  });
}

/** Some pages (a draft's selection) of older converted books stamped as their whole book reads (`library`: every source of the library). */
export function restampSelection(selection, library, options = {}) {
  const list = Array.isArray(selection) ? selection : [], books = new Set(list.filter(isStale).map(source => bookKey(source.document)));
  if (!books.size) return selection;
  const pages = (Array.isArray(library) ? library : []).filter(source => isStale(source) && books.has(bookKey(source.document)));
  const read = new Map(restampConvertedChapters(pages, options).map(source => [source.id, source]));
  return list.map(source => read.get(source?.id) ?? source);
}
