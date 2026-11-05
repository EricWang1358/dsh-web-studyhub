import { courseOf as bookCourseOf } from './course-book-files.js';
import { CUSTOM_PURPOSES, checkedCustom, customDefaults, filledCustom } from './custom-plan.js';
import { chosenChapters, courseSkeleton } from './custom-skeleton.js';
import { estimateCustom } from './custom-estimate.js';
import { currentCourseNotes } from './course-book.js';
import { planBook } from './contexts/generation/book/plan.js';

/* course.custom.preview { course?, custom? } (深度定制, lib/custom-plan.js): the read-only question the main chat asks BEFORE anything is spent. No model call, no
   write, no price.
     -> { status: 'ok' | 'no-course', course, skeleton, defaults, estimate, filled, saved, unknownChapters }
     skeleton   the course's materials and chapters as the library holds them now (lib/custom-skeleton.js). skeleton.basis says what scope.chapters names: 'outline',
                the top-level nodes of the course's current outline (skeleton.outline.chapters[].id: what generation.courseBook.build {chapters} takes), or 'documents',
                the chapters of the materials (skeleton.documents[].chapters[].id; they exist before the outline, and carry `pages` to be mapped to the outline's chapters
                by title and page range once it is built).
     defaults   customDefaults(purpose) for every purpose, the one table.
     estimate   { book: { points, calls, readTokens, inventory? }, questions: { count, calls, readTokens }, total: { calls, readTokens }, rough } for `filled`; only the
                chosen chapters and the ticked parts count (lib/custom-estimate.js). rough: the points rest on characters, not on an inventory; `book.inventory` is
                exact: the inventory calls the build's own plan makes now (the pages of the chosen chapters only, nothing read before; 深度定制 S2).
     filled     the plan the estimate is for: `custom` when given, completed from the defaults of its purpose where it is partial (so the chat can ask the preview with
                {purpose} or {purpose, scope} while it is still asking; a purpose that wants chapters and has none yet is estimated for the whole course, scope {kind:'all'});
                else the course's saved one; else the review defaults. Only course.save needs the complete, strict record.
     saved      the course's own 定制方案 as saved, or null.
     unknownChapters  the chapter ids of `filled` that name no chapter of the skeleton now (they are left out of the estimate). */

const courseRecord = (state, name) => (state.courses || []).find(item => item && item.name === name) ?? null;
const defaults = () => Object.fromEntries(CUSTOM_PURPOSES.map(purpose => [purpose, customDefaults(purpose)]));

const nothing = (course = null) => ({ status: 'no-course', course, skeleton: { basis: 'documents', documents: [] }, defaults: defaults(), estimate: null, filled: null, saved: null, unknownChapters: [] });

/** The plan to estimate: the caller's (completed), else the saved one, else the review defaults; chapters not named yet count as the whole course. */
function planOf(asked, saved) {
  const filled = filledCustom(asked ?? saved ?? customDefaults('review'));
  const open = filled.scope?.kind === 'chapters' && !filled.scope.chapters?.length;
  return checkedCustom(open ? { ...filled, scope: { kind: 'all' } } : filled);
}

/** The inventory calls the book of this plan would make now: the build's own stage 0 (book/plan.js, the pages the chosen chapters read and nothing already read),
    without a sample (it narrows only the first build's reading). null when the build would refuse (the estimate then counts characters). */
function inventoryCalls(state, course, filled, chosen) {
  if (!filled.book.make) return null;
  const chapters = filled.scope.kind === 'chapters' ? chosen.map(row => row.id) : null;
  const language = currentCourseNotes(state.sources, course)?.courseNotes.language === 'en' ? 'en' : 'zh';
  try { return planBook(state, { course, language, sample: 'skip', ...(chapters ? { chapters } : {}) }).inventory.calls.length; } catch { return null; }
}

export function customPreview(state, args = {}) {
  const name = bookCourseOf(state, args);
  if (name === null || name === undefined) return nothing();
  const record = courseRecord(state, name), saved = record?.custom ?? null, filled = planOf(args.custom ?? null, saved), skeleton = courseSkeleton(state, name);
  // A name no course record and no material of the library carries is no course (a typo), not an empty one.
  if (!record && !skeleton.documents.length) return nothing(name);
  const picked = chosenChapters(skeleton, filled.scope), inventory = inventoryCalls(state, name, filled, picked.chosen);
  return { status: 'ok', course: name, skeleton, defaults: defaults(), estimate: estimateCustom({ ...picked, inventory }, filled, state.settings?.generation), filled,
    saved: structuredClone(saved),
    unknownChapters: picked.unknown };
}
