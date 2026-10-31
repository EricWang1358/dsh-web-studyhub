/* The learner's answer about a rebuilt outline (#461): course.book.rebuild { course?, action: 'apply' | 'undo', outlineId }. Mutations of the state, no I/O; the op
   (lib/contexts/library/operations.js) reads the state kept before the rebuild (lib/course-book-history.js readRebuild) and runs them in the book's writer queue and one transaction.

   While a rebuild is pending (lib/course-book-files.js, the one gate) what needs the new layout is refused (refuseWhilePending: the book's structure, book.write, book.qa.add); a write
   to a file by its name (course.book.save, .block, .suggestion, a file's .revert, book.qa.remove) lands on that file as it is, moves nothing and answers the preview.

   apply: the moves the learner looked at (`outlineId`), else a conflict; applied once, a second time is the plain book.
   undo takes back ONE rebuilt outline and what it did to the book, nothing else. Two cases, both named by `outlineId` (the outline the learner was looking at; any other answer is a conflict, so a stale page never takes back a later rebuild):
   - the book has not followed the outline yet (the page's preview: 放弃这次整理): only the outlines change places; not one file of the book is touched.
   - the book followed it (撤销): the book goes back to the state kept just before, while it is exactly as that rebuild left it (the revision and the files' print,
     `lastMoves.revisionAfter`, the kept `print`). Any write since refuses it (course-book-rebuild-conflict) and nothing changes: an undo never writes over text.
     A book's marks (读完了 / 已看) move no revision and are not text: those made since stay.
   In both the outline before is current again and the rebuilt one is archived (never deleted; an identical one saved later is current again, sources.ingest); the
   notes written on the rebuilt outline step back too, to the ones they replaced that explain the outline before (else their oldest: an explanation that does not
   match shows as out of date and 更新全书 writes it). There is no redo: organising again makes the outline again. */
import { isCourseOutlineSource } from './course-outline-book.js';
import { currentCourseOutline } from './course-outline-book.js';
import { currentCourseNotes, isCourseNotesSource } from './course-book.js';
import { archiveSources } from './source-archive.js';
import { courseOf, openCourseBook, recordOf } from './course-book-files.js';
import { structureVersionOf } from './course-book-own-titles.js';
import { filesPrint } from './course-book-moves.js';

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const conflict = (zh, en) => fail(`${zh} / ${en}`, 'course-book-rebuild-conflict');
const noUndo = () => fail('没有留下这次整理之前的记录，没法撤销；书没有改动 / Nothing of the book before this rebuild was kept, so it cannot be undone; the book is unchanged', 'course-book-rebuild-no-undo');
const CHANGED = ['这次整理之后书又改过了，撤销会盖掉之后写的内容，所以没有撤销；书没有改动，「未归位」里的内容可以手动放回',
  'The book changed after this rebuild and an undo would overwrite what was written since, so nothing was undone; what waits in Not placed can be put back by hand'];

/** The Jobs that save an outline or notes: an undo under one would leave notes for an archived outline, or two current outlines. (Their constants live in the generation context.) */
export const REBUILD_JOB_KINDS = Object.freeze(['course-outline-build', 'course-book-build']);
export const refuseWhileBuilding = () => fail('这门课正在整理总纲或更新全书；等它结束再撤销，这次没有改动 / An outline or book build of this course is running; undo when it ends. Nothing changed', 'course-book-rebuild-job-running');
/** `opened` (an open's answer) unless a rebuild is pending. */
export function refuseWhilePending(opened) {
  if (opened.status === 'rebuild-pending') fail(`总纲刚重新整理好，等你决定书怎么放：先打开复习全书看一下。这次没有写入 / The outline was organised again and awaits the learner's decision: open the review book first (course.book.open lists the moves; course.book.rebuild {action, outlineId} on their word). Nothing was written`, 'course-book-rebuild-pending');
  return opened;
}

/** The go-ahead: the book follows the outline named `outlineId`, which must be the current one. -> the book (openCourseBook). */
export function applyBookRebuild(state, args = {}) {
  const course = courseOf(state, args), outline = typeof course === 'string' ? currentCourseOutline(state.sources, course) : null;
  if (!outline || typeof args.outlineId !== 'string' || outline.id !== args.outlineId) conflict('总纲在这之后又变过了，请重新看一下；这次没有改动', 'The outline changed since; look at it again. Nothing changed');
  return openCourseBook(state, args, { applyRebuild: true });
}

/** The notes to go back to: down the `supersedes` chain from those written on the rebuilt outline, the first that explain `outlineId`, else the oldest there is. */
function notesBefore(sources, notes, outlineId) {
  const byId = new Map(sources.filter(isCourseNotesSource).map(source => [source.id, source])), seen = new Set([notes.id]);
  let at = notes, oldest = null;
  while (at.courseNotes.supersedes && byId.has(at.courseNotes.supersedes) && !seen.has(at.courseNotes.supersedes)) {
    at = byId.get(at.courseNotes.supersedes);
    seen.add(at.id);
    oldest = at;
    if (at.courseNotes.outlineId === outlineId) return at;
  }
  return oldest;
}

/** The outline `oldId` current again in place of `rebuilt`, the notes written on `rebuilt` stepping back with it. */
function outlineBack(state, course, rebuilt, oldId) {
  const old = state.sources.find(source => source.id === oldId && isCourseOutlineSource(source));
  if (!old) noUndo();
  const others = state.sources.filter(source => isCourseOutlineSource(source) && !source.archived && source.id !== rebuilt.id && source.id !== oldId && source.courseOutline.course === course);
  if (others.length) conflict('这门课还有另一份总纲，没有撤销', 'This course has another outline as well, so nothing was undone');
  const notes = currentCourseNotes(state.sources, course);
  if (notes?.courseNotes.outlineId === rebuilt.id) {
    const before = notesBefore(state.sources, notes, oldId);
    archiveSources(state, { sourceIds: [notes.id], archived: true });
    if (before) archiveSources(state, { sourceIds: [before.id], archived: false });
  }
  archiveSources(state, { sourceIds: [rebuilt.id], archived: true });
  archiveSources(state, { sourceIds: [old.id], archived: false });
}

/** args: { course?, outlineId, snapshot }: `snapshot` is the kept state, { doc, fromOutlineId, toOutlineId, revisionAfter, print }, or null. -> { status: 'undone' | 'discarded' }. */
export function undoBookRebuild(state, args = {}) {
  const course = courseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  if (!record) fail('这门课还没有复习全书 / This course has no review book yet', 'course-book-missing');
  const doc = record.bookDoc, outline = currentCourseOutline(state.sources, course);
  if (!outline || typeof args.outlineId !== 'string' || outline.id !== args.outlineId)
    conflict('总纲在这之后又变过了，这次整理不能再撤销；书没有改动', 'The outline changed since, so this rebuild can no longer be undone; the book is unchanged');
  // Not followed yet: the book's files are as they were; only the outlines change places.
  if (doc.outlineId !== outline.id) {
    outlineBack(state, course, outline, doc.outlineId);
    return { status: 'discarded' };
  }
  const moves = doc.lastMoves, snapshot = args.snapshot;
  if (moves?.outlineId !== outline.id || !Number.isInteger(moves.revisionAfter)) conflict('总纲在这之后又变过了，这次整理不能再撤销；书没有改动', 'The outline changed since, so this rebuild can no longer be undone; the book is unchanged');
  if (doc.revision !== moves.revisionAfter) conflict(...CHANGED);
  if (!snapshot?.doc || snapshot.toOutlineId !== outline.id || snapshot.revisionAfter !== doc.revision || snapshot.doc.course !== doc.course) noUndo();
  if (snapshot.print !== filesPrint(doc.files)) conflict(...CHANGED);
  outlineBack(state, course, outline, snapshot.fromOutlineId);
  const marks = { ...(snapshot.doc.marks || {}) };
  for (const [kind, list] of Object.entries(doc.marks || {})) marks[kind] = { ...(marks[kind] || {}), ...list };
  record.bookDoc = { ...snapshot.doc, revision: doc.revision + 1, updatedAt: new Date().toISOString(), structureVersion: Math.max(structureVersionOf(doc), structureVersionOf(snapshot.doc)) + 1,
    ...(Object.keys(marks).length ? { marks } : {}) };
  return { status: 'undone' };
}
