import { createHash } from 'node:crypto';
import { currentCourseOutline, materialsFingerprint } from '../../../course-outline-book.js';
import { currentCourseNotes } from '../../../course-book.js';
import { buildOutlineIndex } from '../../../course-outline-index.js';
import { planOutline, planPapersOnly } from '../outline/plan.js';
import { notesWork } from './work.js';
import { COVERAGE_LEVELS, bookCoverage } from '../../../book-settings.js';
import { REFUSALS, notesTitle } from './jobs/messages.js';
import { choosePapers } from '../outline/papers.js';
import { planInventory } from '../inventory/plan.js';
import { effortsOf } from '../inventory/policy.js';

/* The plan of one review book build, pure: no model, no library write, no clock. Stage 0 (`planBook`) decides what the outline needs first and refuses (with a code,
   in the learner's words) before any model call. The only precondition is a course with at least one material: no questions, no sample paper, one short material
   and no outline yet are all fine (a missing input removes only its own part).

   The outline first:
     'full'   there is no outline, or the course's materials changed since it was made: the outline build's own plan (map, reduce, papers), run as the first stage;
     'papers' the request names sample papers other than the outline's: the outline keeps its knowledge points and only the papers mark them again (no map, no reduce);
     'keep'   the outline is current: the notes are planned against it now.
   The notes are planned against the outline the first stage makes (book/work.js), so a rebuild asks only what changed. */

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));

/** Is the outline the one the inventory makes? Built from it, or (the quick fallback) from the descriptors while the inventory, unchanged, found nothing. */
const fromInventory = (outline, inventory) => outline.from === 'inventory'
  || (outline.from === 'descriptors' && !inventory.calls.length && !(inventory.previous?.courseInventory.items.length));

/** @param request { course, language?, papers?: [document key], coverage?: 讲解详尽程度 (else the saved settings.book.coverage), point?: the node id 读更多 writes } */
export function planBook(state, request = {}) {
  const language = request.language === 'en' ? 'en' : 'zh', course = request.course;
  const coverage = COVERAGE_LEVELS.includes(request.coverage) ? request.coverage : bookCoverage(state.settings?.book);
  const point = typeof request.point === 'string' && request.point ? request.point : null;
  if (typeof course !== 'string' || course === '*') throw refuse('course-book-no-course', language);
  const documents = buildOutlineIndex(state, { course }).allDocuments;
  if (!documents.length) throw refuse('course-book-no-materials', language);
  const outline = currentCourseOutline(state.sources, course), previous = currentCourseNotes(state.sources, course);
  const own = (outline?.courseOutline.papers || []).map(paper => paper.key);
  // The papers: the learner's, else the outline's own when the learner chose them, else the ones recognised by name (used by default).
  const chosen = choosePapers(documents, { asked: Array.isArray(request.papers) ? request.papers : null, outline: outline?.courseOutline ?? null });
  const asked = chosen.keys;
  // The 清点 runs first, always (an unchanged range costs nothing): the book is checked against it, and its outline is built from it.
  const inventory = planInventory(state, documents, { course, language, papers: new Set(asked) });
  const mode = !outline || outline.courseOutline.fingerprint !== materialsFingerprint(documents) || !fromInventory(outline.courseOutline, inventory) ? 'full'
    : !sameSet(asked, own) ? 'papers' : 'keep';
  const outlineRequest = { course, language, papers: asked, papersBy: chosen.by, inventory: false };
  const outlinePlan = mode === 'full' ? planOutline(state, outlineRequest) : mode === 'papers' ? planPapersOnly(state, outlineRequest) : null;
  // With the outline as it is, the notes are known now; otherwise after the first stage.
  const work = mode === 'keep' ? notesWork(state, documents, outline, previous, language, { coverage, point }) : null;
  const planKey = digest([course, language, outline?.id ?? null, previous?.id ?? null, outlinePlan?.planKey ?? null, materialsFingerprint(documents), coverage, point, inventory.calls.map(call => call.key)]);
  return { course, language, coverage, point, title: notesTitle(language, course), mode, outline, previous, outlinePlan, work, state, documents, planKey, inventory,
    efforts: effortsOf(state.settings), concurrency: request.concurrency, papersBy: chosen.by,
    scopeHash: digest(['course-book', course, outline?.id ?? null, asked]),
    steps: inventory.steps + (outlinePlan?.steps ?? 0) + (work ? work.bodyBatches.length + work.examBatches.length : 0) };
}
