/* 复习全书 on the 总纲 page: what `course.outline` says of the course's notes (lib/course-book.js). Pure, no I/O.
   The book's line (`book.notes`): which notes, whether they are current (lib/course-book-inputs.js notesStatus: an explanation is out of date when its texts
   changed, its 考情 when its paper places changed; questions never make it so). A leaf opened with `expand` carries its notes (`open[key].notes`), read-only;
   each cite names its material, so the page can open the original place. */
import { bodyText, currentCourseNotes } from './course-book.js';
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
  stale: status.stale || outlineStale, missing: status.missing, changed: status.changed,
  // 讲解覆盖 over the book: the characters of the points' materials their explanations read, and how many read only some of theirs (读更多 reads on).
  coverage: { read: status.coverage?.read ?? 0, total: status.coverage?.total ?? 0, partial: status.coverage?.partial ?? 0 },
  // The quality workflow's coverage at three levels (materials and pages read, knowledge points complete, concepts covered), and the points still short.
  ...(record.courseNotes.coverage ? { levels: record.courseNotes.coverage } : {}),
  short: record.courseNotes.leaves.filter(leaf => leaf.body?.status === 'short').length, glossary: record.courseNotes.glossary?.length ?? 0 });

/** One point's 覆盖 as the page shows it: pages (or characters) read of its material, and the level 读更多 reads at (null: nothing more to read). */
const coverageView = reading => (reading ? { unit: reading.coverage.unit, read: reading.coverage.read, total: reading.coverage.total,
  ...(reading.coverage.partial ? { partial: reading.coverage.partial } : {}), more: reading.more } : null);

/** One leaf's notes as the page shows them, or null: its parts as saved, each cite with the title of its material (the source's own name), and its 覆盖. */
export function leafNotes(notes, nodeId, byId) {
  const leaf = notes?.record.courseNotes.leaves.find(item => item.id === nodeId);
  if (!leaf || (!leaf.body && !leaf.exam)) return null;
  // The transitions shown above (in) and below (out, or the chapter's wrap-up) the point; notes written before them have none.
  const bridge = leaf.bridge ? Object.fromEntries(['in', 'out', 'wrap'].filter(key => leaf.bridge[key]).map(key => [key, leaf.bridge[key]])) : null;
  // A body of units carries a 3.4 mirror (explain, cites, points) for a rollback: this version shows its units and leaves the mirror out.
  const { read: _read, units: _units, ...all } = leaf.body || {};
  const { explain: _explain, points: _points, cites: _cites, ...mirrorless } = all, saved = leaf.body?.units ? mirrorless : all;
  // A body of the quality workflow is shown as one text (its units joined), with its concept coverage and, when short, what it still misses.
  const joined = leaf.body?.units ? bodyText(leaf.body) : null;
  const cites = (joined ? joined.cites : leaf.body?.cites || []).map(cite => ({ ...cite, title: byId.get(cite.sourceId)?.title ?? '' }));
  const body = leaf.body && !leaf.body.empty ? { ...saved, ...(joined ? { text: joined.text } : {}), cites } : null;
  const own = notes.status?.coverage?.leaves.get(leaf.id);
  const coverage = body && !joined ? coverageView(own) : null, concepts = joined && own?.concepts ? own.concepts : null;
  return { id: leaf.id, ...(body ? { body } : leaf.body?.empty ? { empty: true } : {}), ...(coverage ? { coverage } : {}), ...(concepts ? { concepts } : {}), ...(bridge ? { bridge } : {}),
    ...(leaf.exam ? { exam: leaf.exam } : {}) };
}
