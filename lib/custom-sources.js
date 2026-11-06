import { courseDocuments } from './course-outline-index.js';
import { currentCourseOutline } from './course-outline-book.js';
import { anchorSources, documentIndex, outlineLeaves } from './course-book-inputs.js';
import { chosenChapters } from './custom-skeleton.js';

/* What a 定制方案's scope READS (深度定制, lib/custom-plan.js): the sources of each chosen chapter, so the questions of a plan are asked of those chapters' pages and
   of nothing else. Pure, read only; one function, beside the skeleton it reads.

   scopeUnits(state, course, skeleton, scope) -> { units: [{ id, title, sourceIds, chars, cut }], unknown }
   units: the chapters scope.chapters names (in the order named), or, for a whole-course scope, every chapter chosenChapters counts (a sample paper and a second import of
     the same lecture are not taught). `sourceIds` are the page sources the chapter stands for, in reading order: for a chapter of the materials (skeleton.basis
     'documents') the pages its anchor (the chapter id) names; for a chapter of the outline ('outline') the pages the anchors of its points name, the same reading the
     review book is written from (lib/course-book-inputs.js anchorSources). `cut` says whether those sources are the chapter and nothing more: a chapter that lies inside
     one text no page holds (a Markdown file with headings) can only be read whole, so its unit names that text and `cut` is false (the plan says it did not cut).
   unknown: the ids of scope.chapters that name no chapter now (the preview says the same, `unknownChapters`). */

const anchorsOfOutlineChapter = node => outlineLeaves([node]).flatMap(({ node: leaf }) => leaf.anchors || []);
const whole = (found, length) => found.every(range => range.start === 0 && range.end >= length(range.sourceId));

export function scopeUnits(state, course, skeleton, scope) {
  // The scope is a course's saved plan (course.custom.apply): held to the chapters it saved.
  const { chosen, unknown } = chosenChapters(skeleton, scope, { stored: true });
  const docs = documentIndex(courseDocuments(state, course).candidates), byId = new Map((state.sources || []).map(source => [source.id, source]));
  const length = id => byId.get(id)?.text?.length ?? 0;
  const outline = skeleton.basis === 'outline' ? currentCourseOutline(state.sources, course)?.courseOutline.nodes ?? [] : [];
  const nodes = new Map(outline.map(node => [node.id, node]));
  const titles = new Map(skeleton.documents.flatMap(doc => doc.chapters.map(chapter => [chapter.id, chapter.title])));
  const units = chosen.map(row => {
    const node = nodes.get(row.id), anchors = node ? anchorsOfOutlineChapter(node) : [row.id];
    const found = anchors.flatMap(anchor => anchorSources(docs, anchor, length)), ids = [...new Set(found.map(range => range.sourceId))].filter(id => byId.has(id));
    return { id: row.id, title: node?.title ?? titles.get(row.id) ?? row.id, sourceIds: ids, chars: row.chars, cut: whole(found, length) };
  }).filter(unit => unit.sourceIds.length);
  return { units, unknown };
}
