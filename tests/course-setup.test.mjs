import test from 'node:test';
import assert from 'node:assert/strict';
import { courseSetup, SETUP_STEP_IDS } from '../lib/course-setup.js';
import { skeletonSummary } from '../lib/skeleton.js';

/* 课程准备: the once-per-course setup as a checklist derived from the library snapshot (no storage, no model calls).
   The function is pure: the snapshot the panel already holds, plus what the search extension reported and the steps the
   learner put off. Done-detection is automatic and containment-aware (a parent course takes in the courses inside it). */

const COURSE = 'Cloud Native';
const page = (n, extra = {}) => ({ id: `book-p${n}`, title: `Textbook · p.${n}`, text: `page ${n}`, courses: [COURSE],
  document: { id: 'a'.repeat(64), materialId: `document-${'a'.repeat(64)}-pdf`, format: 'pdf', page: n, totalPages: 320, extractionVersion: 2, ...extra } });
const book = (extra = {}) => Array.from({ length: 320 }, (_, i) => page(i + 1, extra));
const converted = () => book({ origin: 'converted', converter: 'mineru', chapter: { index: 0, title: 'One', level: 1 } });
const note = (id = 's1', courses = [COURSE]) => ({ id, title: `Note ${id}`, text: 'a note', courses });
const deck = (id, course = COURSE, extra = {}) => ({ id, title: id, course, count: 3, available: 3, archived: false, ...extra });
const progress = (...pairs) => Object.fromEntries(pairs.map(([id, learned, fresh]) => [id, { total: learned + fresh, counts: { mastered: 0, familiar: 0, learning: learned, weak: 0, new: fresh } }]));
const library = (extra = {}) => ({ focus: { mode: 'class', course: COURSE, courseId: 'course-1', courses: [{ name: COURSE }] },
  sources: [], decks: [], drafts: [], courses: [{ id: 'course-1', name: COURSE }], skeletons: [], progress: {}, model: { ready: true }, ...extra });
const step = (setup, id) => setup.steps.find(item => item.id === id);
const ids = setup => setup.steps.map(item => item.id);
const extensionReady = (plan) => ({ status: { extension: { installed: true, canInstall: true }, companion: { running: true }, effective: 'builtin' }, plan });
const indexed = { pages: 320, toIndex: 0, toRemove: 0, unchanged: 320, canIndex: true };
const notIndexed = { pages: 320, toIndex: 320, toRemove: 0, unchanged: 0, canIndex: true };

test('the steps are a fixed vocabulary, each with one primary action', () => {
  assert.deepEqual(SETUP_STEP_IDS, ['materials', 'convert', 'index', 'originals', 'deck', 'goal', 'skeleton']);
  const setup = courseSetup(library({ sources: [note()] }));
  for (const item of setup.steps) assert.match(item.action, /^(import|sources|index|generate|draft|course|skeleton)$/, `${item.id} has an action`);
});

test('a brand-new empty library has no checklist: the welcome page leads', () => {
  assert.equal(courseSetup(library()).mode, 'none');
  assert.equal(courseSetup(library({ focus: { mode: 'class', course: null, courses: [] } })).mode, 'none');
});

test('materials only: add material is done, the first questions are next, the optional steps wait until there are questions', () => {
  const setup = courseSetup(library({ sources: [note()] }));
  assert.deepEqual(ids(setup), ['materials', 'deck']);
  assert.equal(step(setup, 'materials').status, 'done');
  assert.equal(step(setup, 'deck').status, 'todo');
  assert.equal(step(setup, 'deck').action, 'generate');
  assert.deepEqual([setup.done, setup.total], [1, 2]);
  // The library has no questions at all, so the home's own first-run card leads: the checklist is a quiet line.
  assert.equal(setup.mode, 'chip');
});

test('a new course in a library that is already in use shows the full checklist, and generating opens with that course', () => {
  const setup = courseSetup(library({ focus: { mode: 'class', course: 'New course', courseId: 'course-2', courses: [{ name: COURSE }, { name: 'New course' }] },
    sources: [note('s9', ['New course'])], decks: [deck('d1', COURSE)], progress: progress(['d1', 2, 1]) }));
  assert.equal(setup.course, 'New course');
  assert.equal(setup.mode, 'full');
  assert.equal(step(setup, 'materials').status, 'done');
  assert.equal(step(setup, 'deck').status, 'todo', 'another course\'s deck does not count');
});

test('no materials yet: the first step is to add one, and the questions step says why it waits', () => {
  const setup = courseSetup(library({ decks: [deck('other', 'Another')], progress: progress(['other', 1, 1]) }));
  assert.equal(setup.mode, 'full');
  assert.equal(step(setup, 'materials').status, 'todo');
  assert.equal(step(setup, 'materials').action, 'import');
  assert.equal(step(setup, 'deck').blockedBy, 'materials');
});

test('a questions draft waiting for review turns the first-questions step into "check the draft"', () => {
  const setup = courseSetup(library({ sources: [note()], drafts: [{ id: 'dr1', title: 'Draft', course: COURSE, cards: [{}] }] }));
  assert.equal(step(setup, 'deck').action, 'draft');
  assert.equal(step(setup, 'deck').detail.draftId, 'dr1');
});

test('a converted book without a search index asks for the index; with the index it is done', () => {
  const sources = [note(), ...converted()];
  const open = courseSetup(library({ sources, decks: [deck('d1')], progress: progress(['d1', 0, 3]) }), { retrieval: extensionReady(notIndexed) });
  assert.equal(step(open, 'convert').status, 'done');
  assert.equal(step(open, 'index').status, 'todo');
  assert.equal(step(open, 'index').action, 'index');
  assert.equal(open.mode, 'full');
  const built = courseSetup(library({ sources, decks: [deck('d1')], progress: progress(['d1', 0, 3]) }), { retrieval: extensionReady(indexed) });
  assert.equal(step(built, 'index').status, 'done');
});

test('the index step appears only for a big book, and only once the search extension has reported', () => {
  const small = courseSetup(library({ sources: [note()] }), { retrieval: extensionReady(notIndexed) });
  assert.ok(!ids(small).includes('index'));
  const sources = [note(), ...converted()];
  assert.ok(!ids(courseSetup(library({ sources }), { retrieval: null })).includes('index'), 'unknown is not "missing"');
  assert.ok(!ids(courseSetup(library({ sources }), { retrieval: { status: { effective: 'builtin' }, plan: null } })).includes('index'), 'no extension on offer, nothing to build');
});

test('a long book that was never converted asks to be converted and split into chapters', () => {
  const setup = courseSetup(library({ sources: book() }));
  assert.equal(step(setup, 'convert').status, 'todo');
  assert.equal(step(setup, 'convert').action, 'sources');
  assert.equal(step(setup, 'convert').detail.title, 'Textbook');
  assert.equal(step(setup, 'convert').detail.pages, 320);
  assert.ok(!ids(courseSetup(library({ sources: [note()] }))).includes('convert'), 'an ordinary note needs no conversion');
});

test('pages that were imported before originals were kept ask to be re-attached', () => {
  const legacy = Array.from({ length: 3 }, (_, i) => ({ ...page(i + 1), document: { id: 'b'.repeat(64), format: 'pdf', page: i + 1, totalPages: 3, extractionVersion: 1 } }));
  const setup = courseSetup(library({ sources: [note(), ...legacy] }));
  assert.equal(step(setup, 'originals').status, 'todo');
  assert.equal(step(setup, 'originals').detail.count, 1, 'one document, not three pages');
  assert.ok(!ids(courseSetup(library({ sources: [note(), ...book()] }))).includes('originals'));
});

test('goal and exam date are done once the course has an exam profile; both optional steps show only after the first questions', () => {
  const base = { sources: [note()], decks: [deck('d1')], progress: progress(['d1', 0, 3]) };
  const without = courseSetup(library(base));
  assert.equal(step(without, 'goal').status, 'todo');
  assert.equal(step(without, 'goal').action, 'course');
  assert.equal(step(without, 'skeleton').status, 'todo');
  const withExam = courseSetup(library({ ...base, courses: [{ id: 'course-1', name: COURSE, exam: { format: 'closed-book', date: '2026-12-01', sections: [] } }] }));
  assert.equal(step(withExam, 'goal').status, 'done');
  const noRecord = courseSetup(library({ ...base, courses: [], focus: { mode: 'class', course: COURSE, courseId: null, courses: [{ name: COURSE }] } }));
  assert.ok(!ids(noRecord).includes('goal'), 'a course without a record has nowhere to keep a goal');
});

test('the skeleton step is done when a skeleton covers a deck of this course', () => {
  const base = { sources: [note()], decks: [deck('d1'), deck('d2', 'Another')], progress: progress(['d1', 0, 3], ['d2', 0, 3]) };
  const other = courseSetup(library({ ...base, skeletons: [{ id: 'k', deckIds: ['d2'] }] }));
  assert.equal(step(other, 'skeleton').status, 'todo');
  const mine = courseSetup(library({ ...base, skeletons: [{ id: 'k', deckIds: ['d1', 'd2'] }] }));
  assert.equal(step(mine, 'skeleton').status, 'done');
  assert.deepEqual(skeletonSummary({ id: 'k', title: 't', nodes: [], relations: [], scope: [{ deckId: 'd1' }, { deckId: 'd1', cardId: 'c' }, { deckId: 'd2' }] }).deckIds, ['d1', 'd2']);
});

test('everything done: the checklist is complete, and a step that does not apply is not counted', () => {
  const setup = courseSetup(library({ sources: [note()], decks: [deck('d1')], progress: progress(['d1', 1, 2]), skeletons: [{ id: 'k', deckIds: ['d1'] }],
    courses: [{ id: 'course-1', name: COURSE, exam: { date: '2026-12-01', sections: [] } }] }));
  assert.equal(setup.mode, 'done');
  assert.deepEqual([setup.done, setup.total], [4, 4]);
  assert.ok(setup.steps.every(item => item.status === 'done'));
});

test('a course already in use shows the checklist collapsed, never as the full card', () => {
  const setup = courseSetup(library({ sources: [note()], decks: [deck('d1')], progress: progress(['d1', 2, 1]) }));
  assert.equal(setup.practised, true);
  assert.equal(setup.mode, 'chip');
  assert.equal(courseSetup(library({ sources: [note()], decks: [deck('d1')], progress: progress(['d1', 0, 3]) })).mode, 'chip',
    'materials and questions are done: what is left is optional, so the line is quiet');
});

test('containment: a parent course counts the materials and questions of the courses inside it, a lookalike does not', () => {
  const parent = 'Cloud Native Solution Design';
  const data = library({ focus: { mode: 'class', course: parent, courseId: 'course-p', courses: [{ name: parent }, { name: `${parent} / 05 Kubernetes` }, { name: `${parent} Extras` }] },
    sources: [note('s1', [`${parent} / 05 Kubernetes`])], decks: [deck('d5', `${parent} / 05 Kubernetes`)], progress: progress(['d5', 0, 3]) });
  const setup = courseSetup(data);
  assert.equal(step(setup, 'materials').status, 'done');
  assert.equal(step(setup, 'deck').status, 'done');
  const lookalike = courseSetup({ ...data, sources: [note('s1', [`${parent} Extras`])], decks: [deck('d5', `${parent} Extras`)] });
  assert.equal(step(lookalike, 'materials').status, 'todo');
  assert.equal(step(lookalike, 'deck').status, 'todo');
});

test('putting a step off keeps it out of the count; when nothing is left the line is gone', () => {
  const data = library({ sources: [note()], decks: [deck('d1')], progress: progress(['d1', 0, 3]) });
  const later = courseSetup(data, { dismissed: ['goal'] });
  assert.equal(step(later, 'goal').status, 'later');
  assert.equal(later.total, courseSetup(data).total - 1);
  const none = courseSetup(data, { dismissed: ['goal', 'skeleton'] });
  assert.equal(none.mode, 'none', 'all that is left was put off: no nagging, and no "complete" either');
});

test('interview preparation, an archived-only course and the sample course get no checklist', () => {
  assert.equal(courseSetup(library({ focus: { mode: 'interview', course: COURSE, courses: [] }, sources: [note()] })).mode, 'none');
  assert.equal(courseSetup(library({ sources: [note()], sample: { loaded: true, course: COURSE } })).mode, 'none');
  const archived = courseSetup(library({ sources: [note()], decks: [deck('d1', COURSE, { archived: true })] }));
  assert.equal(step(archived, 'deck').status, 'todo', 'an archived deck is not a first batch of questions');
});
