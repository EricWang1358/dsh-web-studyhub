import { chapterKey, courseDocuments } from './course-outline-index.js';
import { currentCourseOutline, outlineStale } from './course-outline-book.js';
import { bookParts } from './course-book-parts.js';
import { displayTitle } from './document-title.js';
import { detectedPapers } from './contexts/generation/outline/papers.js';
import { charsOfPoints } from './contexts/generation/outline/estimate.js';
import { CUSTOM_LIMITS } from './custom-plan.js';

/* The skeleton of a course for a 定制方案 (深度定制, lib/custom-plan.js): its materials and their chapters as the library holds them BEFORE any model call, so
   the learner can be asked "which chapters?" without anything spent. Read only.

   skeleton(state, course) -> { basis: 'outline' | 'documents',
                                documents: [{ key, documentId, title, pages, chars, chapters: [{ id, title, pages: [from, to], chars, reread? }], paper?, copyOf? }],
                                outline?: { id, stale, chapters: [{ id, title, points }], parts? } }
   WHAT A SCOPE NAMES (`basis`). With a current course outline (it exists and its materials are as they were: the rule generation.courseBook.build holds a
   chapter pick to) the choosable chapters are the outline's top-level nodes, `outline.chapters[].id`, exactly what generation.courseBook.build {chapters} takes;
   the sizes are the outline's own (its points, at the cut's characters a point). Without one (none yet, or the materials changed since) they are the chapters
   of the materials, `documents[].chapters[].id`, which exist before the outline: after the outline is built the chat maps them to its chapters by title and page range.
   The document list is always there, with the pages, for that mapping. An outline built BY CHAPTERS (深度定制 S2: a first build of some chapters, no whole outline;
   lib/contexts/generation/book/part-outline.js) keeps basis 'documents': its chapters are those of the materials, and the build maps each id to its node
   (`outline.parts`: [{ key, node }]), so a saved scope stays valid and the chapters not built yet can still be picked.
   documents: the course's materials (lib/course-outline-index.js courseDocuments: the same rule the outline and its cost use); `documentId` is the id the import
     list calls the material. A chapter is one lib/source-groups.js gives a material (the converter's headings or the learner's own segmentation), the front matter
     before the first left out, its id `chapterKey(document key, chapter index)`; a material with no chapters is one chapter named by its document key.
     pages: how many pages the material has (the converter's total, else the pages held).
     paper: a sample paper by name (the outline's own rule, detectedPapers): it is not taught, so a whole-course scope leaves it out and the answer kit reads it.
     copyOf: the key of the material this one repeats (the same name, size and chapters, e.g. the same file imported twice): a whole-course scope counts it once.
     reread (a chapter): of a converted book stored under an older chapter rule, a chapter that holds a page whose chapter was another one (lib/converted-chapter-stamps.js):
     its id may name another chapter than when a plan was saved, so chosenChapters holds a saved plan to the titles it saved. */

const pagesOf = doc => doc.totalPages || doc.pages.length;

function chaptersOf(doc) {
  const own = (doc.chapters || []).filter(chapter => !chapter.front);
  if (!own.length) return [{ id: doc.key, title: displayTitle(doc.title), pages: [1, Math.max(1, pagesOf(doc))], chars: doc.chars }];
  return own.map(chapter => ({ id: chapterKey(doc.key, chapter.index), title: chapter.title, pages: [chapter.startPage, chapter.endPage], chars: chapter.chars,
    ...(chapter.reread ? { reread: true } : {}) }));
}

const sameAs = doc => JSON.stringify([displayTitle(doc.title), doc.chars, (doc.chapters || []).map(chapter => [chapter.title, chapter.chars])]);

function outlineOf(state, course, candidates) {
  const record = currentCourseOutline(state.sources, course);
  if (!record) return null;
  const chapters = bookParts(record.courseOutline.nodes).map(({ id, title, points }) => ({ id, title, points }));
  const parts = record.courseOutline.parts?.map(({ key, node }) => ({ key, node }));
  return { id: record.id, stale: outlineStale(record.courseOutline, candidates), chapters, ...(parts ? { parts } : {}) };
}

export function courseSkeleton(state, course) {
  const { candidates } = courseDocuments(state, course), papers = new Set(detectedPapers(candidates)), first = new Map();
  const documents = candidates.map(doc => {
    const copy = first.get(sameAs(doc));
    if (!copy) first.set(sameAs(doc), doc.key);
    return { key: doc.key, documentId: doc.documentId ?? null, title: displayTitle(doc.title), pages: pagesOf(doc), chars: doc.chars, chapters: chaptersOf(doc),
      ...(papers.has(doc.key) ? { paper: true } : {}), ...(copy ? { copyOf: copy } : {}) };
  });
  const outline = outlineOf(state, course, candidates);
  return { basis: outline && !outline.stale && outline.chapters.length && !outline.parts ? 'outline' : 'documents', documents, ...(outline ? { outline } : {}) };
}

/** The title a scope keeps for a chapter (course.save writes it beside the id, lib/custom-plan.js scope.titles). */
export const savedChapterTitle = title => String(title ?? '').slice(0, CUSTOM_LIMITS.chapterId);

const chaptersById = skeleton => new Map([...(skeleton.outline?.chapters ?? []), ...skeleton.documents.flatMap(doc => doc.chapters)].map(chapter => [chapter.id, chapter]));

/** The titles course.save keeps with a scope's ids (scope.titles), never moving an id the plan had to another chapter: a title the caller names is kept (the chat
    names a chapter again so); else an id the course's saved scope (`before`) already had keeps what it had: its title, or none (null) when it was saved
    without one and its chapter was read again (`reread`, it stays unconfirmed); else the chapter's title now (null: the id names none). */
export function scopeTitles(skeleton, scope, before) {
  const chapters = chaptersById(skeleton), had = before?.kind === 'chapters' && Array.isArray(before.chapters) ? before.chapters : [];
  return scope.chapters.map((id, at) => {
    const given = Array.isArray(scope.titles) ? scope.titles[at] : undefined, kept = had.indexOf(id);
    if (typeof given === 'string') return given;
    if (kept >= 0 && typeof before.titles?.[kept] === 'string') return before.titles[kept];
    if (kept >= 0 && chapters.get(id)?.reread) return null;
    return chapters.has(id) ? savedChapterTitle(chapters.get(id).title) : null;
  });
}

/** What a scope chooses of a skeleton: { chosen: [{ id, doc, index, chars }], paperChars, unknown: [ids that name no chapter now] }. A whole-course scope (all, or the
    exam range, which only the learner can name) is every chapter; of the materials' chapters, the materials that are not a paper or a copy. Named chapters are
    counted wherever they are. A named id never moves to another chapter silently: one saved with a title (scope.titles) that names a chapter of another title now is
    unknown, and so, for a `stored` plan (a course's saved 定制方案, not the ids the chat just read from this skeleton), is one saved without a title that names a
    chapter read again (`reread`): the learner picks those chapters again. */
export function chosenChapters(skeleton, scope, { stored = false } = {}) {
  const rows = skeleton.basis === 'outline'
    ? skeleton.outline.chapters.map((chapter, index) => ({ id: chapter.id, doc: chapter.id, index, chars: charsOfPoints(chapter.points), taught: true }))
    : skeleton.documents.flatMap(doc => doc.chapters.map((chapter, index) => ({ id: chapter.id, doc: doc.key, index, chars: chapter.chars, taught: !doc.paper && !doc.copyOf })));
  const paperChars = skeleton.documents.filter(doc => doc.paper).reduce((sum, doc) => sum + doc.chars, 0);
  if (scope.kind !== 'chapters') return { chosen: rows.filter(row => row.taught), paperChars, unknown: [] };
  const byId = new Map(rows.map(row => [row.id, row])), titles = Array.isArray(scope.titles) ? scope.titles : null;
  const named = chaptersById(skeleton);
  const holds = (id, at) => {
    if (!byId.has(id)) return false;
    const was = titles?.[at];
    if (typeof was === 'string') return was === savedChapterTitle(named.get(id)?.title);
    return !(stored && named.get(id)?.reread);
  };
  return { chosen: scope.chapters.filter(holds).map(id => byId.get(id)), paperChars, unknown: scope.chapters.filter((id, at) => !holds(id, at)) };
}
