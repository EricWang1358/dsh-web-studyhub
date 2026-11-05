import { chapterKey, courseDocuments } from './course-outline-index.js';
import { displayTitle } from './document-title.js';
import { detectedPapers } from './contexts/generation/outline/papers.js';

/* The skeleton of a course for a 定制方案 (深度定制, lib/custom-plan.js): its materials and their chapters as the library holds them BEFORE any model call, so
   the learner can be asked "which chapters?" without anything spent. Read only. The documents are the course's (lib/course-outline-index.js courseDocuments: the
   same rule the outline and its cost use), the chapters the ones lib/source-groups.js gives a document (the converter's own headings or the learner's
   segmentation, the front matter before the first one left out), and a chapter's id is `chapterKey(document key, chapter index)`, the id a 定制方案's scope
   names. A material with no chapters is one chapter named by its document key.

   skeleton(state, course) -> { documents: [{ key, title, pages, chars, chapters: [{ id, title, pages: [from, to], chars }], paper?, copyOf? }] }
     pages:  how many pages the material has (the converter's total, else the pages held).
     paper:  a sample paper by name (the outline's own rule, detectedPapers): it is not taught, so a whole-course scope leaves it out and the answer kit reads it.
     copyOf: the key of the material this one repeats (the same name, size and chapters, e.g. the same file imported twice): a whole-course scope counts it once. */

const pagesOf = doc => doc.totalPages || doc.pages.length;

function chaptersOf(doc) {
  const own = (doc.chapters || []).filter(chapter => !chapter.front);
  if (!own.length) return [{ id: doc.key, title: displayTitle(doc.title), pages: [1, Math.max(1, pagesOf(doc))], chars: doc.chars }];
  return own.map(chapter => ({ id: chapterKey(doc.key, chapter.index), title: chapter.title, pages: [chapter.startPage, chapter.endPage], chars: chapter.chars }));
}

const sameAs = doc => JSON.stringify([displayTitle(doc.title), doc.chars, (doc.chapters || []).map(chapter => [chapter.title, chapter.chars])]);

export function courseSkeleton(state, course) {
  const { candidates } = courseDocuments(state, course), papers = new Set(detectedPapers(candidates)), first = new Map();
  return { documents: candidates.map(doc => {
    const copy = first.get(sameAs(doc));
    if (!copy) first.set(sameAs(doc), doc.key);
    return { key: doc.key, title: displayTitle(doc.title), pages: pagesOf(doc), chars: doc.chars, chapters: chaptersOf(doc),
      ...(papers.has(doc.key) ? { paper: true } : {}), ...(copy ? { copyOf: copy } : {}) };
  }) };
}

/** What a scope chooses of a skeleton: { chosen: [{ id, doc, index, chars }], paperChars, unknown: [ids that name no chapter now] }. A whole-course scope (all, or the
    exam range, which only the learner can name) is every chapter of every material that is not a paper or a copy; named chapters are counted wherever they are. */
export function chosenChapters(skeleton, scope) {
  const rows = skeleton.documents.flatMap(doc => doc.chapters.map((chapter, index) => ({ id: chapter.id, doc: doc.key, index, chars: chapter.chars, taught: !doc.paper && !doc.copyOf })));
  const paperChars = skeleton.documents.filter(doc => doc.paper).reduce((sum, doc) => sum + doc.chars, 0);
  if (scope.kind !== 'chapters') return { chosen: rows.filter(row => row.taught), paperChars, unknown: [] };
  const byId = new Map(rows.map(row => [row.id, row]));
  return { chosen: scope.chapters.filter(id => byId.has(id)).map(id => byId.get(id)), paperChars, unknown: scope.chapters.filter(id => !byId.has(id)) };
}
