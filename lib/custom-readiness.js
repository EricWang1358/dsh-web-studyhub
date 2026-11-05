import { courseOf as bookCourseOf } from './course-book-files.js';
import { courseRowsOf } from './course-outline.js';
import { bookKey } from './course-outline-book-view.js';
import { currentCourseOutline, leafPapers } from './course-outline-book.js';
import { currentCourseNotes } from './course-book.js';
import { bookParts } from './course-book-parts.js';
import { refKey } from './course-outline-index.js';
import { chosenChapters, courseSkeleton } from './custom-skeleton.js';
import { isMasteryAttempt } from './mastery.js';
import { localDate } from './board-model.js';

/* 章节准备度 (深度定制 S5): how ready each chapter of a course is, read from what the library holds. Pure, no model call, nothing written; the ops
   (lib/contexts/library/operations.js) call it, and 补齐 (lib/custom-fill.js) reads the same model to decide what to start.

   course.custom.readiness { course? }
   -> { status: 'ok' | 'no-course' | 'no-book', course, basis: 'outline' | 'documents', plan: boolean, counted: { explained, questions }, unknownChapters: [id],
        chapters: [chapter], total: { points, explained, asked, practised, solid, readiness }, quality: { dropped: null } }
   chapter: { id, title, built, points, explained, asked, drafted, practised, solid, weak, readiness, quality: { sentBack }, todo: { explain, questions, weak } }
   THE CHAPTERS. With a 定制方案 its scope's chapters (lib/custom-skeleton.js: the outline's top-level nodes when the course has a current outline, else the materials'
   chapters, which have no points yet: built false, nothing counted); without one every chapter of the review book. `built` is whether any point of the chapter has a
   written explanation (the book's 未生成 is its opposite). A scope id that names nothing is listed in `unknownChapters`.
   THE COUNTS, per knowledge point (a leaf of the outline; the questions of a point are the ones lib/course-outline.js places on its row, published ones only):
     explained  the point has a written explanation              (counted only when the plan ticks the explanations; no plan: counted)
     asked      at least one question                            (the three below are counted only when the plan ticks questions)
     practised  at least one question has a graded answer
     solid      see SOLID below
   A part the plan did not tick is `null`, never 0: nothing was promised there. `drafted` are the points with a question waiting in a draft (the points with neither a published nor a drafted question are the ones to ask);
   `quality.sentBack` the questions in those drafts that the independent review sent back and that wait for repair. `quality.dropped` is null because it is not recorded:
   the candidates a review or the program checks dropped are kept per draft with no chapter, and a published draft is deleted, so there is nothing to say per chapter.
   SOLID is defined here and nowhere else. A question is solid when its level is 已掌握 (the schedule's own call, lib/mastery.js) or it was answered right on at least
   SOLID_DAYS different days (a second right answer on a later day is the first proof that it was kept, not only seen), and its last answer was not wrong. A point is
   solid when at least half of its questions are and none is weak. The 21-day 已掌握 alone is unreachable in the week before a class or an exam, so a preview or a
   crunch could never reach "ready"; the second right answer on another day is. A 已掌握 question stays solid however few days it was answered on.
   READINESS of a chapter is the weighted share of its solid points: weight 1, or TESTED_WEIGHT for a point a sample paper tested (the one importance the book has,
   lib/course-outline-book.js leafPapers); null when questions are not counted or the chapter has no point. */

/** Different days a question must be answered right on to be solid (unless the schedule already calls it 已掌握). */
export const SOLID_DAYS = 2;
/** The weight of a point a sample paper tested, against 1 for the others. */
export const TESTED_WEIGHT = 2;
const RIGHT = 3;

const leavesOf = node => (node.children?.length ? node.children.flatMap(leavesOf) : [node]);
const share = (list, pick) => Math.round(list.reduce((sum, item) => sum + (pick(item) ? item.weight : 0), 0) / list.reduce((sum, item) => sum + item.weight, 0) * 100) / 100;

/** A question is solid: 已掌握, or right on SOLID_DAYS days; never when its last answer was wrong or it was never answered. */
export const cardSolid = (level, rightDays) => level !== 'weak' && level !== 'new' && (level === 'mastered' || rightDays >= SOLID_DAYS);
/** A point is solid: at least half of its questions are, none is weak. `cards`: [{ solid, weak }]. */
export const pointSolid = cards => cards.length > 0 && !cards.some(card => card.weak) && cards.filter(card => card.solid).length * 2 >= cards.length;
/** The weighted share of solid points, 0–1 with two decimals; null for no point. `points`: [{ solid, weight }]. */
export const readinessOf = points => (points.length ? share(points, point => point.solid) : null);

/** deck|card -> { answered, days: the days it was answered right on }, from the answers that count for mastery. */
function answersOf(attempts) {
  const answers = new Map();
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (!isMasteryAttempt(attempt) || !Number.isFinite(attempt.grade)) continue;
    const key = refKey(attempt.deckId, attempt.quiz_id), found = answers.get(key) ?? { days: new Set() };
    answers.set(key, found);
    const at = Date.parse(attempt.timestamp);
    if (attempt.grade >= RIGHT && Number.isFinite(at)) found.days.add(localDate(new Date(at)));
  }
  return answers;
}

/** The refs of the draft questions the review sent back: `<draft id>|<card id>`. */
const sentBackRefs = drafts => new Set((Array.isArray(drafts) ? drafts : []).flatMap(draft => Object.keys(draft?.editorial?.rejectedIssues || {}).map(cardId => refKey(draft.id, cardId))));

const courseRecord = (state, name) => (state.courses || []).find(item => item && item.name === name) ?? null;
const empty = (status, course = null) => ({ status, course, basis: 'outline', plan: false, counted: { explained: false, questions: false }, unknownChapters: [], chapters: [],
  total: { points: 0, explained: null, asked: null, practised: null, solid: null, readiness: null }, quality: { dropped: null } });

/** One chapter of the outline with its points read. `detail` is what 补齐 needs and the answer does not carry: the point ids and the weak questions. */
function chapterOf(part, { wants, rowOf, entriesOf, index, answers, sentBack, nodes, papers, notesBody }) {
  const points = part.leaves.map(id => {
    const row = rowOf(bookKey(id)), entries = row ? entriesOf(row) : [];
    const cards = entries.map(entry => ({ entry, right: answers.get(refKey(entry.deckId, entry.cardId))?.days.size ?? 0, answered: answers.has(refKey(entry.deckId, entry.cardId)) }))
      .map(card => ({ ...card, solid: cardSolid(card.entry.level, card.right), weak: card.entry.level === 'weak' }));
    const drafts = row ? row.nodes.flatMap(node => [...(index.draftNodes.get(node) || [])]) : [];
    const node = nodes.get(id), tested = papers.length && node ? leafPapers(node, papers) > 0 : false;
    return { id, explained: notesBody.has(id), questions: cards.length, practised: cards.some(card => card.answered), solid: pointSolid(cards), weak: cards.filter(card => card.weak).map(card => card.entry),
      drafted: drafts.length, sentBack: drafts.filter(ref => sentBack.has(ref)).length, weight: tested ? TESTED_WEIGHT : 1 };
  });
  const count = pick => points.filter(pick).length, ask = wants.questions;
  const explained = count(point => point.explained);
  const open = points.filter(point => !point.questions && !point.drafted);
  return { id: part.id, title: part.title, built: explained > 0, points: points.length, explained: wants.explain ? explained : null, asked: ask ? count(point => point.questions) : null,
    drafted: ask ? count(point => point.drafted) : null, practised: ask ? count(point => point.practised) : null, solid: ask ? count(point => point.solid) : null,
    weak: ask ? count(point => point.weak.length) : null, readiness: ask ? readinessOf(points) : null, quality: { sentBack: points.reduce((sum, point) => sum + point.sentBack, 0) },
    todo: { explain: wants.explain ? points.length - explained : 0, questions: ask ? open.length : 0, weak: ask ? count(point => point.weak.length) : 0 },
    detail: { explain: wants.explain ? points.filter(point => !point.explained).map(point => point.id) : [], questions: ask ? open.map(point => point.id) : [],
      weak: ask ? points.flatMap(point => point.weak) : [], points } };
}

/** The chapter of a material when the course has no outline yet: nothing is written or asked of it by point, so nothing is counted. */
const unbuilt = (id, title) => ({ id, title, built: false, points: 0, explained: null, asked: null, drafted: null, practised: null, solid: null, weak: null, readiness: null, quality: { sentBack: 0 },
  todo: { explain: 0, questions: 0, weak: 0 }, detail: { explain: [], questions: [], weak: [], points: [] } });

const sum = (chapters, key) => (chapters.every(chapter => chapter[key] === null) ? null : chapters.reduce((total, chapter) => total + (chapter[key] ?? 0), 0));

/** The model with the detail 补齐 needs; `customReadiness` is the answer without it. */
export function readinessModel(state, args = {}) {
  const course = bookCourseOf(state, args);
  if (course === null || course === undefined) return empty('no-course');
  const record = courseRecord(state, course), custom = record?.custom ?? null, outline = currentCourseOutline(state.sources, course);
  const skeleton = custom ? courseSkeleton(state, course) : null;
  // A name no course record and no material carries is no course (a typo), as course.custom.preview says.
  if (!record && !(skeleton ?? courseSkeleton(state, course)).documents.length) return empty('no-course', course);
  if (!custom && !outline) return empty('no-book', course);
  const wants = { explain: !custom || (custom.book.make && custom.book.parts.includes('explain')), questions: !custom || custom.questions.make };
  const base = { status: 'ok', course, plan: !!custom, counted: { explained: wants.explain, questions: wants.questions }, quality: { dropped: null } };
  if (skeleton && skeleton.basis !== 'outline') {
    const { chosen, unknown } = chosenChapters(skeleton, custom.scope, { stored: true }), titles = new Map(skeleton.documents.flatMap(doc => doc.chapters.map(chapter => [chapter.id, chapter.title])));
    const chapters = chosen.map(row => unbuilt(row.id, titles.get(row.id) ?? row.id));
    return { ...base, basis: 'documents', unknownChapters: unknown, chapters, total: { points: 0, explained: null, asked: null, practised: null, solid: null, readiness: null } };
  }
  const notes = currentCourseNotes(state.sources, course), notesBody = new Set((notes?.courseNotes.leaves || []).filter(leaf => leaf.body && !leaf.body.empty).map(leaf => leaf.id));
  const parts = bookParts(outline.courseOutline.nodes), byId = new Map(parts.map(part => [part.id, part]));
  const named = custom?.scope.kind === 'chapters' ? custom.scope.chapters : parts.map(part => part.id);
  const nodes = new Map(outline.courseOutline.nodes.flatMap(top => [top, ...leavesOf(top)]).map(node => [node.id, node]));
  const { index, rowOf, entriesOf } = courseRowsOf(state, course), papers = outline.courseOutline.papers || [];
  const context = { wants, rowOf, entriesOf, index, answers: answersOf(state.attempts), sentBack: sentBackRefs(state.drafts), nodes, papers, notesBody };
  const chapters = named.filter(id => byId.has(id)).map(id => chapterOf(byId.get(id), context));
  const everyPoint = chapters.flatMap(chapter => chapter.detail.points);
  const total = { points: sum(chapters, 'points') ?? 0, explained: sum(chapters, 'explained'), asked: sum(chapters, 'asked'), practised: sum(chapters, 'practised'), solid: sum(chapters, 'solid'),
    readiness: wants.questions ? readinessOf(everyPoint) : null };
  return { ...base, basis: 'outline', unknownChapters: named.filter(id => !byId.has(id)), chapters, total };
}

/** course.custom.readiness (see the top of this file). */
export function customReadiness(state, args = {}) {
  const model = readinessModel(state, args);
  return { ...model, chapters: model.chapters.map(({ detail: _detail, ...chapter }) => chapter) };
}
