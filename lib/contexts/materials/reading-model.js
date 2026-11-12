/* The pure rules of 已读 (materials.reading.*, #1014): which chapters of a material the learner has read through. No store, no DOM.

   A chapter is named the way the reader names it (ui/document-preview/reader/chapters.js): its id (chapter-N, chapter-front, block-N), its title and
   its pages. A kept read mark counts for a chapter only while all four still match: when the learner applies another outline or the material gets a
   new revision, a chapter that kept its id, title and pages keeps its ✓ and any other mark no longer counts (the #993 rule: what can be matched
   is kept). An entry is keyed by all four (chapterKey), so two chapter lists that share an id (two windows, before and after an outline was
   applied) keep both, and 标为未读 takes back only the chapter as it is shown. The first save in a new revision keeps only what matches; within a
   revision nothing else is dropped (reading-operations.js). */

export const READING_LIMITS = Object.freeze({
  /** Chapters kept for one document revision (a 500-page book in blocks of 20 pages has 25; a book of many short chapters a few hundred). */
  chapters: 2000,
  id: 120,
  title: 200,
  /** Revision records kept per document: the current revision's and the newest writes (reading-operations.js). */
  revisions: 3,
});

const page = value => Number.isSafeInteger(value) && value >= 0;

/** A chapter as the reader names it, checked where it comes in: { id, title, startPage, endPage }, or null when it is not one. */
export function chapterRef(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id || id.length > READING_LIMITS.id || !page(value.startPage) || !page(value.endPage) || value.endPage < value.startPage) return null;
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, READING_LIMITS.title) : '';
  return { id, title, startPage: value.startPage, endPage: value.endPage };
}

/** A chapter's identity in the store: its id, title and pages together. */
export const chapterKey = chapter => `${chapter.id}\u0000${chapter.title || ''}\u0000${chapter.startPage}-${chapter.endPage}`;

/** Whether a kept entry is the same chapter as one the reader shows now. */
export const sameChapter = (kept, chapter) => chapterKey(kept) === chapterKey(chapter);

/** The kept entries that still match one of `chapters` (all of them when the chapters are not known), in the chapters' order. */
export function matchingEntries(entries, chapters) {
  const kept = Array.isArray(entries) ? entries : [];
  if (!Array.isArray(chapters)) return kept;
  const byKey = new Map(kept.map(entry => [chapterKey(entry), entry]));
  return chapters.map(chapter => byKey.get(chapterKey(chapter))).filter(Boolean);
}

/** The ids of the chapters read, among `chapters` (null: every kept entry). */
export const readChapterIds = (entries, chapters) => matchingEntries(entries, chapters).map(entry => entry.id);

/**
 * The entries after a save: the kept ones that still match `chapters` (when given), less `unread` (chapters: only the entry of that id, title and
 * pages), plus `read` (a chapter already read keeps the time it was first read, so saving the same thing twice changes nothing). At most
 * READING_LIMITS.chapters, the newest kept.
 */
export function nextEntries(entries, { chapters = null, read = [], unread = [], now }) {
  const out = new Map(matchingEntries(entries, chapters).map(entry => [chapterKey(entry), entry]));
  for (const chapter of unread) out.delete(chapterKey(chapter));
  for (const chapter of read) if (!out.has(chapterKey(chapter))) out.set(chapterKey(chapter), { ...chapter, at: now });
  const list = [...out.values()];
  return list.length > READING_LIMITS.chapters ? list.slice(list.length - READING_LIMITS.chapters) : list;
}
