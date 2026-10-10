/* 复习全书 on the 总纲 page: what `course.outline` says of the course's notes (lib/course-book.js). Pure, no I/O.
   The book's line (`book.notes`): which notes, whether they are current (lib/course-book-inputs.js notesStatus: an explanation is out of date when its texts
   changed, its 考情 when its paper places changed; questions never make it so). A leaf opened with `expand` carries its notes (`open[key].notes`), read-only;
   each cite names its material, so the page can open the original place. */
import { currentCourseNotes } from './course-book.js';
import { notesStatus } from './course-book-inputs.js';

const memo = { key: null, sources: null, value: null };

/**
 * The course's notes and their status against `outline` (the course's outline record); null without notes. Computed once per library revision (or the store's
 * frozen sources, a read through storagePort.view()), notes and outline: the status reads the texts of every leaf.
 */
export function courseNotesOf(state, documents, outline, { root = '' } = {}) {
  const record = currentCourseNotes(state.sources, outline.courseOutline.course);
  if (!record) return null;
  const known = state.revision !== undefined || Object.isFrozen(state.sources), key = JSON.stringify([root, state.revision ?? null, record.id, outline.id]);
  if (known && memo.key === key && memo.sources === state.sources) return memo.value;
  const value = { record, status: notesStatus(state, documents, outline, record) };
  Object.assign(memo, { key, sources: state.sources, value });
  return value;
}

/** The book's line about its notes. `outlineStale`: the course's materials changed since the outline was made (an update organises it again first). */
export const notesOverview = ({ record, status }, outlineStale = false) => ({ id: record.id, createdAt: record.createdAt ?? null, supersedes: record.courseNotes.supersedes ?? null,
  language: record.courseNotes.language, leaves: record.courseNotes.leaves.filter(leaf => leaf.body).length, papers: !!record.courseNotes.papers?.length,
  stale: status.stale || outlineStale, missing: status.missing, changed: status.changed });

/** One leaf's notes as the page shows them, or null: its parts as saved, each cite with the title of its material (the source's own name). */
export function leafNotes(notes, nodeId, byId) {
  const leaf = notes?.record.courseNotes.leaves.find(item => item.id === nodeId);
  if (!leaf || (!leaf.body && !leaf.exam)) return null;
  const body = leaf.body && !leaf.body.empty ? { ...leaf.body, cites: leaf.body.cites.map(cite => ({ ...cite, title: byId.get(cite.sourceId)?.title ?? '' })) } : null;
  return { id: leaf.id, ...(body ? { body } : leaf.body?.empty ? { empty: true } : {}), ...(leaf.exam ? { exam: leaf.exam } : {}) };
}
