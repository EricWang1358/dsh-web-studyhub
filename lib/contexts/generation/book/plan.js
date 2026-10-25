import { createHash } from 'node:crypto';
import { currentCourseOutline, materialsFingerprint } from '../../../course-outline-book.js';
import { currentCourseNotes } from '../../../course-book.js';
import { buildOutlineIndex } from '../../../course-outline-index.js';
import { planOutline, planPapersOnly } from '../outline/plan.js';
import { COVERAGE_LEVELS, bookCoverage } from '../../../book-settings.js';
import { REFUSALS, notesTitle } from './jobs/messages.js';
import { choosePapers } from '../outline/papers.js';
import { planInventory } from '../inventory/plan.js';
import { effortsOf } from '../inventory/policy.js';

/* The plan of one review book build, pure: no model, no library write, no clock. Stage 0 (`planBook`) decides what the inventory reads (every range that is
   not known yet) and what the outline needs, and refuses (with a code, in the learner's words) before any model call. The only precondition is a course with
   at least one material.

   The outline:
     'full'   there is none, the course's materials changed since it was made, or it was not built from the inventory: the outline build's own plan, built from
              the inventory the first stage reads (outline/jobs/inventory-stages.js);
     'papers' the sample papers changed (the learner's, else the ones recognised by name): only the papers mark the leaves again;
     'keep'   the outline is current.
   The points are planned once the inventory and the outline are known (book/work.js), so a rebuild asks only what changed. */

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));

/** Is the outline the one the inventory makes? Built from it, or (the quick fallback) from the descriptors while the inventory, unchanged, found nothing. */
const fromInventory = (outline, inventory) => outline.from === 'inventory'
  || (outline.from === 'descriptors' && !inventory.calls.length && !(inventory.previous?.courseInventory.items.length));

/** @param request { course, language?, papers?: [document key, document id or page id], coverage?: the detail level (else the saved settings.book.coverage),
    point?: the node id whose gaps are filled, concurrency?: the learner's text concurrency } */
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
  // A paper only guessed by its name that has no text is left out here too, so the outline's papers and these agree (no re-reading on every update).
  const readable = key => { const doc = documents.find(item => item.key === key), byId = new Map((state.sources || []).map(source => [source.id, source]));
    return !!doc && doc.sourceIds.some(id => String(byId.get(id)?.text ?? '').trim()); };
  const asked = chosen.by === 'auto' ? chosen.keys.filter(readable) : chosen.keys;
  // The inventory runs first, always (an unchanged range costs nothing): the book is checked against it, and its outline is built from it.
  const inventory = planInventory(state, documents, { course, language, papers: new Set(asked) });
  // An outline of an older version (not built from the inventory) is made again only when the learner says so (`rebuildOutline`): the book keeps it, and its
  // notes are built on it, until then (the page offers it once, saying the learner's notes follow by place).
  const rebuild = !!outline && !fromInventory(outline.courseOutline, inventory) && (request.rebuildOutline === true || outline.courseOutline.from === 'descriptors');
  const mode = !outline || outline.courseOutline.fingerprint !== materialsFingerprint(documents) || rebuild ? 'full' : !sameSet(asked, own) ? 'papers' : 'keep';
  const outlineRequest = { course, language, papers: asked, papersBy: chosen.by, inventory: false };
  const outlinePlan = mode === 'full' ? planOutline(state, outlineRequest) : mode === 'papers' ? planPapersOnly(state, outlineRequest) : null;
  const planKey = digest([course, language, outline?.id ?? null, previous?.id ?? null, outlinePlan?.planKey ?? null, materialsFingerprint(documents), coverage, point,
    inventory.calls.map(call => call.key)]);
  return { course, language, coverage, point, title: notesTitle(language, course), mode, outline, previous, outlinePlan, state, documents, planKey, inventory,
    efforts: effortsOf(state.settings), concurrency: request.concurrency, papersBy: chosen.by, scopeHash: digest(['course-book', course, outline?.id ?? null, asked]),
    steps: inventory.steps + (outlinePlan?.steps ?? 0) };
}
