import { chapterKey, courseDocuments } from './course-outline-index.js';
import { currentCourseOutline, materialsFingerprint } from './course-outline-book.js';
import { bookParts } from './course-book-parts.js';
import { displayTitle } from './document-title.js';
import { detectedPapers } from './contexts/generation/outline/papers.js';
import { charsOfPoints } from './contexts/generation/outline/estimate.js';

/* The skeleton of a course for a 定制方案 (深度定制, lib/custom-plan.js): its materials and their chapters as the library holds them BEFORE any model call, so
   the learner can be asked "which chapters?" without anything spent. Read only.

   skeleton(state, course) -> { basis: 'outline' | 'documents',
                                documents: [{ key, documentId, title, pages, chars, chapters: [{ id, title, pages: [from, to], chars }], paper?, copyOf? }],
                                outline?: { id, stale, chapters: [{ id, title, points }] } }
   WHAT A SCOPE NAMES (`basis`). With a current course outline (it exists and its materials are as they were: the rule generation.courseBook.build holds a
   chapter pick to) the choosable chapters are the outline's top-level nodes, `outline.chapters[].id`, exactly what generation.courseBook.build {chapters} takes;
   the sizes are the outline's own (its points, at the cut's characters a point). Without one (none yet, or the materials changed since) they are the chapters
   of the materials, `documents[].chapters[].id`, which exist before the outline: after the outline is built the chat maps them to its chapters by title and page range.
   The document list is always there, with the pages, for that mapping.
   documents: the course's materials (lib/course-outline-index.js courseDocuments: the same rule the outline and its cost use); `documentId` is the id the import
     list calls the material. A chapter is one lib/source-groups.js gives a material (the converter's headings or the learner's own segmentation), the front matter
     before the first left out, its id `chapterKey(document key, chapter index)`; a material with no chapters is one chapter named by its document key.
     pages: how many pages the material has (the converter's total, else the pages held).
     paper: a sample paper by name (the outline's own rule, detectedPapers): it is not taught, so a whole-course scope leaves it out and the answer kit reads it.
     copyOf: the key of the material this one repeats (the same name, size and chapters, e.g. the same file imported twice): a whole-course scope counts it once. */

const pagesOf = doc => doc.totalPages || doc.pages.length;

function chaptersOf(doc) {
  const own = (doc.chapters || []).filter(chapter => !chapter.front);
  if (!own.length) return [{ id: doc.key, title: displayTitle(doc.title), pages: [1, Math.max(1, pagesOf(doc))], chars: doc.chars }];
  return own.map(chapter => ({ id: chapterKey(doc.key, chapter.index), title: chapter.title, pages: [chapter.startPage, chapter.endPage], chars: chapter.chars }));
}

const sameAs = doc => JSON.stringify([displayTitle(doc.title), doc.chars, (doc.chapters || []).map(chapter => [chapter.title, chapter.chars])]);

function outlineOf(state, course, candidates) {
  const record = currentCourseOutline(state.sources, course);
  if (!record) return null;
  const chapters = bookParts(record.courseOutline.nodes).map(({ id, title, points }) => ({ id, title, points }));
  return { id: record.id, stale: record.courseOutline.fingerprint !== materialsFingerprint(candidates), chapters };
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
  return { basis: outline && !outline.stale && outline.chapters.length ? 'outline' : 'documents', documents, ...(outline ? { outline } : {}) };
}

/** What a scope chooses of a skeleton: { chosen: [{ id, doc, index, chars }], paperChars, unknown: [ids that name no chapter now] }. A whole-course scope (all, or the
    exam range, which only the learner can name) is every chapter; of the materials' chapters, the materials that are not a paper or a copy. Named chapters are
    counted wherever they are. */
export function chosenChapters(skeleton, scope) {
  const rows = skeleton.basis === 'outline'
    ? skeleton.outline.chapters.map((chapter, index) => ({ id: chapter.id, doc: chapter.id, index, chars: charsOfPoints(chapter.points), taught: true }))
    : skeleton.documents.flatMap(doc => doc.chapters.map((chapter, index) => ({ id: chapter.id, doc: doc.key, index, chars: chapter.chars, taught: !doc.paper && !doc.copyOf })));
  const paperChars = skeleton.documents.filter(doc => doc.paper).reduce((sum, doc) => sum + doc.chars, 0);
  if (scope.kind !== 'chapters') return { chosen: rows.filter(row => row.taught), paperChars, unknown: [] };
  const byId = new Map(rows.map(row => [row.id, row]));
  return { chosen: scope.chapters.filter(id => byId.has(id)).map(id => byId.get(id)), paperChars, unknown: scope.chapters.filter(id => !byId.has(id)) };
}
