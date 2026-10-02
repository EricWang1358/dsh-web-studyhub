/* 课程准备 (the once-per-course setup, derived from the library; docs/feature-tiers.md).

   Some things are done once at the start of a course (add and convert the materials, split a long book into chapters,
   build the search index for a big textbook, re-attach the originals of old imports, make the first questions, set the
   exam date, draw the skeleton) and then never again; the rest of the product is for every day. This module says which
   of those one-time steps a course has behind it and which are still open. Nothing here stores anything or calls a
   model: it reads the snapshot the panel already holds (plus, for the index, what the search extension reported, and the
   steps the learner put off) and every step is detected, never ticked by hand.

   Containment is the same as everywhere else (lib/course-tree.js): the current course takes in the materials and
   questions of the courses inside it, and a name that merely starts the same does not belong. Pure, isomorphic. */
import { courseScope } from './course-tree.js';
import { knownCourseNames, sourceMatchesCourse } from './source-courses.js';
import { groupSourcesByDocument } from './source-groups.js';
import { bigDocuments } from './large-documents.js';

/** The steps, in the order they are done in. */
export const SETUP_STEP_IDS = Object.freeze(['materials', 'convert', 'index', 'originals', 'deck', 'goal', 'skeleton']);

/** What each step needs before it can be called done by the learner (the rest are optional). */
const REQUIRED = new Set(['materials', 'convert', 'index', 'originals', 'deck']);
const ACTION = { materials: 'import', convert: 'sources', index: 'index', originals: 'sources', deck: 'generate', goal: 'course', skeleton: 'skeleton' };

const live = deck => deck && !deck.archived && !deck.systemKind;
const courseOfDeck = deck => deck.course ?? deck.folder ?? '';
const hasExam = exam => !!exam && typeof exam === 'object' && !!(exam.date || exam.format || exam.totalMarks || exam.writingMinutes || exam.sections?.length);

/** Do the course's materials contain a book large enough that whole-book questions need the search index? */
export function hasBigBook(data, course = data?.focus?.course) {
  if (course === undefined || course === null) return false;
  const known = knownCourseNames(data || {}), within = courseScope(course, known);
  return bigDocuments(groupSourcesByDocument((data?.sources || []).filter(source => sourceMatchesCourse(source, within, known)))).length > 0;
}

/**
 * @param data       the library snapshot (sources, decks, drafts, courses, progress, skeletons, focus, sample, model)
 * @param options    { course } the course to read (default: the current one);
 *                   { retrieval } what the search extension reported: { status: retrieval.status, plan: retrieval.index.plan } or null while unknown;
 *                   { dismissed } ids of the steps the learner put off
 * @returns { course, mode, steps, done, total, practised, leading }
 *   mode: 'none' (nothing to show) | 'full' (the card) | 'chip' (one quiet line) | 'done' (everything is done)
 *   step: { id, required, status: 'done' | 'todo' | 'later', action, detail, blockedBy? }
 *   done / total count the steps that apply and were not put off.
 */
export function courseSetup(data, { course = data?.focus?.course, retrieval = null, dismissed = [] } = {}) {
  const none = (extra = {}) => ({ course: course ?? null, mode: 'none', steps: [], done: 0, total: 0, practised: false, leading: false, ...extra });
  if (!data || data.focus?.mode === 'interview' || course === undefined || course === null) return none();
  if (data.sample?.loaded && data.sample.course === course) return none();
  const decksAll = (data.decks || []).filter(live), draftsAll = (data.drafts || []).filter(live);
  // A library with nothing in it is the welcome page's business.
  if (!(data.sources || []).length && !decksAll.length && !draftsAll.length) return none();

  const known = knownCourseNames(data), within = courseScope(course, known);
  const items = groupSourcesByDocument((data.sources || []).filter(source => sourceMatchesCourse(source, within, known)));
  const decks = decksAll.filter(deck => within(courseOfDeck(deck)));
  const drafts = draftsAll.filter(deck => within(courseOfDeck(deck)));
  const practised = decks.some(deck => { const row = data.progress?.[deck.id]; return !!row && (row.total ?? 0) - (row.counts?.new ?? 0) > 0; });
  // No questions anywhere yet: the home's own first-run card is the lead and this stays a quiet line.
  const leading = decksAll.length === 0;
  const off = new Set(dismissed);

  const steps = [];
  const add = (id, status, detail = {}, extra = {}) => steps.push({ id, required: REQUIRED.has(id), status: off.has(id) && status === 'todo' ? 'later' : status, action: ACTION[id], detail, ...extra });

  add('materials', items.length ? 'done' : 'todo', { documents: items.length });

  const chaptered = items.filter(item => item.converted || item.chapters?.length);
  const unconverted = bigDocuments(items).filter(item => !item.converted && !item.chapters?.length);
  if (chaptered.length) add('convert', 'done', { documents: chaptered.length });
  else if (unconverted.length) add('convert', 'todo', { title: unconverted[0].title, pages: Math.max(unconverted[0].pages.length, unconverted[0].totalPages || 0), documents: unconverted.length });

  // The index only exists as an idea for a big book, and only once the search extension has said what it has built.
  if (bigDocuments(items).length && retrieval?.status?.extension) {
    const plan = retrieval.plan;
    const built = !!plan && plan.pages > 0 && plan.toIndex === 0 && plan.toRemove === 0;
    if (plan) add('index', built ? 'done' : 'todo', { pages: plan.pages, missing: plan.toIndex ?? 0, installed: !!retrieval.status.extension.installed, running: !!retrieval.status.companion?.running });
  }

  const legacy = items.filter(item => item.format === 'pdf' && (String(item.documentId || '').startsWith('legacy-') || item.warnings?.includes('legacy-extraction')));
  if (legacy.length) add('originals', 'todo', { count: legacy.length, title: legacy[0].title });

  const hasDeck = decks.length > 0;
  add('deck', hasDeck ? 'done' : 'todo', { decks: decks.length, drafts: drafts.length, ...(drafts[0] ? { draftId: drafts[0].id } : {}), needsModel: data.model ? data.model.ready === false : data.modelReady === false },
    { ...(!hasDeck && !items.length ? { blockedBy: 'materials' } : {}), ...(!hasDeck && drafts.length ? { action: 'draft' } : {}) });

  // Goal and skeleton are about a course that already has questions; before that they only add noise.
  if (hasDeck) {
    const record = (data.courses || []).find(item => item.id && item.id === data.focus?.courseId) || (data.courses || []).find(item => item.name === course);
    if (record?.id) add('goal', hasExam(record.exam) ? 'done' : 'todo', { courseId: record.id, ...(record.exam?.date ? { date: record.exam.date } : {}) });
    const mine = new Set(decks.map(deck => deck.id));
    add('skeleton', (data.skeletons || []).some(skeleton => (skeleton.deckIds || []).some(id => mine.has(id))) ? 'done' : 'todo');
  }

  const active = steps.filter(item => item.status !== 'later');
  const done = active.filter(item => item.status === 'done').length;
  const pending = active.filter(item => item.status === 'todo');
  const result = { course, steps, done, total: active.length, practised, leading };
  if (!pending.length) return { ...result, mode: steps.some(item => item.status === 'later') ? 'none' : 'done' };
  const requiredOpen = pending.some(item => item.required);
  return { ...result, mode: practised || leading || !requiredOpen ? 'chip' : 'full' };
}
