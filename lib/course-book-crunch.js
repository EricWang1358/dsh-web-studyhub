/* 期末一周 of the review book (docs/plans/review-book.md M7): the plan of a course's last days before its exam (lib/crunch-plan.js) made from the book,
   the 翻看 marks, and the mock paper of some points. No I/O, no model call; the ops (lib/contexts/library/operations.js) call these on the library.

   book.crunch { course?, date?, minutesPerDay?, daysOff?, reviewDays? } -> { status, course, examDate, daysLeft, window, revision, plan, points }
     status: 'ok' (an exam date within `window` days, settings.book.crunchWindowDays, default 21), 'far' (later), 'past', 'no-exam' (the course has no
     exam date: no plan, the book still works; `plan.order.flip` is still the 翻看 order), 'no-book', 'no-course'. `date` is the learner's today.
     points: [{ id (the heading id), key, code, number, title, order, tested, weakness, questions, weak, due, fresh, size, pitfalls, done, seen }] in
       reading order. tested: the sample papers that tested it (the 总纲's 样卷考过); weakness 0–1 from its questions (a weak one 1, new 0.6, learning
       0.5, familiar 0.25, mastered 0, a due one 0.25 more; no question: 0.6); size: the characters of its files; pitfalls: its 易错点 (lib/book-flip.js).
       done: the first day (from the exam date less the window, up to today) on which at least min(5, its questions) of its questions were answered,
       for a point without questions the day it was marked 读完了; seen: the day it was marked 已看 in 翻看.
   book.crunch { all: true, date? } -> { status: 'ok', today, window, courses: [{ course, examDate, daysLeft, reviewDays, flipStart, mockDate, today: day,
     points: [point of the day] }] }: every course with an exam date within its window and a review book (the home's 期末一周 card).
   book.crunch.mark { course?, hid, kind: 'read' | 'seen', on?: true, date? }: the learner's 读完了 / 已看 of one point, kept in the book's record
     (`bookDoc.marks`, a day per point; never a file, never exported).
   book.mock.plan / book.mock { course?, pointIds?, count?, limitMinutes? }: a mock paper over the questions of those points (default: today's points of
     the plan, else every point), through the ordinary exam mode: 1–200 questions, single and multiple choice only (the exam mode's kinds), due and weak
     first (a practice round's order). The plan says how many questions the points have, how many can go in and how many are left out by kind. */
import { openCourseBook, recordOf, courseOf as bookCourseOf } from './course-book-files.js';
import { courseRowsOf } from './course-outline.js';
import { currentCourseOutline, leafPapers } from './course-outline-book.js';
import { BOOK_PREFIX } from './course-outline-book-view.js';
import { codeOf } from './course-book-lookup.js';
import { crunchPlan, addDays, daysBetween, isDate, CRUNCH } from './crunch-plan.js';
import { pointMistakes } from './book-flip.js';
import { crunchMinutes, crunchWindow } from './book-settings.js';
import { courseActivityRules } from './course-active.js';
import { localDate } from './board-model.js';
import { planPath, latestOutcomes } from './mastery.js';
import { isExamQuestionCount, EXAM_QUESTION_COUNT } from './limits.js';
import { LIMIT_MINUTES } from './exam-timing.js';

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const LEVEL_WEAKNESS = Object.freeze({ new: 0.6, weak: 1, learning: 0.5, familiar: 0.25, mastered: 0 });
/** The kinds the exam mode takes (lib/contexts/study/operations.js review.start mode exam). */
export const MOCK_KINDS = Object.freeze(['quiz', 'multi']);
/** How many questions a mock paper has when the learner does not say. */
export const MOCK_COUNT = 20;
const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));
const todayOf = args => (args.date === undefined ? localDate() : isDate(args.date) ? args.date : fail('date must be a YYYY-MM-DD day', 'book-crunch-date'));
const courseRecord = (state, course) => (state.courses || []).find(item => item && item.name === course) ?? null;
const examDateOf = (state, course) => { const date = courseRecord(state, course)?.exam?.date; return isDate(date) ? date : null; };
const marksOf = record => ({ read: { ...(record?.bookDoc?.marks?.read || {}) }, seen: { ...(record?.bookDoc?.marks?.seen || {}) } });

/** The points of an open book with what the plan weighs them by (see the top of this file). */
export function crunchPoints(state, book, { today, from, marks }) {
  const { rowOf, entriesOf } = courseRowsOf(state, book.course);
  const outline = currentCourseOutline(state.sources, book.course)?.courseOutline, papers = outline?.papers || [], nodes = new Map();
  const walk = list => (list || []).forEach(node => { nodes.set(node.id, node); walk(node.children); });
  walk(outline?.nodes);
  const mistakes = pointMistakes(book);
  // The days each question was answered, inside [from, today].
  const answered = new Map();
  for (const attempt of Array.isArray(state.attempts) ? state.attempts : []) {
    const at = Date.parse(attempt?.timestamp), date = Number.isFinite(at) ? localDate(new Date(at)) : null;
    if (!date || date < from || date > today) continue;
    const key = `${attempt.deckId}|${attempt.quiz_id}`;
    if (!answered.has(key)) answered.set(key, new Set());
    answered.get(key).add(date);
  }
  return leavesOf(book.nodes).map((leaf, order) => {
    const row = rowOf(leaf.key), entries = row && row !== 'unplaced' ? entriesOf(row) : [], node = nodes.get(String(leaf.key).slice(BOOK_PREFIX.length));
    const weakness = entries.length ? Math.round(entries.reduce((sum, entry) => sum + Math.min(1, (LEVEL_WEAKNESS[entry.level] ?? 0.6) + (entry.due ? 0.25 : 0)), 0) / entries.length * 100) / 100 : 0.6;
    let done = null;
    if (entries.length) {
      const need = Math.min(CRUNCH.practise, entries.length), perDay = new Map();
      for (const entry of entries) for (const date of answered.get(`${entry.deckId}|${entry.cardId}`) || []) perDay.set(date, (perDay.get(date) || 0) + 1);
      done = [...perDay].filter(([, count]) => count >= need).map(([date]) => date).sort()[0] ?? null;
    } else if (isDate(marks.read[leaf.hid])) done = marks.read[leaf.hid];
    return { id: leaf.hid, key: leaf.key, code: codeOf(leaf.hid), number: leaf.number, title: leaf.title, order,
      tested: node && papers.length ? leafPapers(node, papers) : 0, weakness, questions: entries.length,
      weak: entries.filter(entry => entry.level === 'weak').length, due: entries.filter(entry => entry.due).length, fresh: entries.filter(entry => entry.level === 'new').length,
      size: `${leaf.gen || ''}${leaf.mine || ''}${leaf.qa || ''}`.length, pitfalls: mistakes.get(leaf.hid)?.length || 0,
      done, seen: isDate(marks.seen[leaf.hid]) ? marks.seen[leaf.hid] : null };
  });
}

/* One answer per course, library revision, book revision, day and arguments: the home asks on every snapshot revision, and a book is rebuilt (its
   files, lookup and answer cards) only when something changed. Without a library revision (a plain state in a test) nothing is kept. */
const memo = new Map(), MEMO_KEPT = 16;
let computed = 0;
/** How many times book.crunch was really computed (the tests read it to see the memo work). */
export const crunchComputations = () => computed;

/** book.crunch of one course (see the top of this file). `root` keys the memo (one per library folder). */
export function bookCrunch(state, args = {}, { root = '' } = {}) {
  const today = todayOf(args), course = bookCourseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  const key = state?.revision === undefined ? null : JSON.stringify([root, state.revision, course ?? null, record?.bookDoc?.revision ?? null, today, state.settings?.book ?? null,
    args.minutesPerDay ?? null, args.daysOff ?? null, args.reviewDays ?? null, (state.courses || []).find(item => item?.name === course)?.exam ?? null]);
  if (key && memo.has(key)) return memo.get(key);
  const value = computeCrunch(state, args, today);
  if (key) { memo.set(key, value); if (memo.size > MEMO_KEPT) memo.delete(memo.keys().next().value); }
  return value;
}

function computeCrunch(state, args, today) {
  computed += 1;
  const window = crunchWindow(state.settings?.book);
  const course = bookCourseOf(state, args);
  if (course === null || course === undefined) return { status: 'no-course', course: null, today, window };
  const examDate = examDateOf(state, course), record = recordOf(state, course);
  const book = record ? openCourseBook(state, { course }, { write: false, applyRebuild: true }) : null;
  if (book?.status !== 'ok') return { status: 'no-book', course, examDate, today, window };
  const marks = marksOf(record), from = examDate ? addDays(examDate, -window) : today;
  const points = crunchPoints(state, book, { today, from, marks });
  const plan = crunchPlan({ points, papers: book.papers, examDate, today, daysOff: args.daysOff, minutesPerDay: args.minutesPerDay ?? crunchMinutes(state.settings?.book), reviewDays: args.reviewDays,
    done: Object.fromEntries(points.filter(point => point.done).map(point => [point.id, point.done])),
    seen: Object.fromEntries(points.filter(point => point.seen).map(point => [point.id, point.seen])) });
  const status = plan.status === 'ok' && plan.daysLeft > window ? 'far' : plan.status;
  return { status, course, examDate, daysLeft: plan.daysLeft, today, window, revision: book.revision, plan, points };
}

/** book.crunch { all: true }: the courses whose exam is within their window and that have a review book, the soonest first; a parked (or archived)
    course is left out, as everything a parked course would push at the learner (lib/course-active.js). */
export function crunchCourses(state, args = {}, options = {}) {
  const today = todayOf(args), window = crunchWindow(state.settings?.book), courses = [], rules = courseActivityRules(state);
  for (const record of Array.isArray(state.courses) ? state.courses : []) {
    const date = record?.exam?.date;
    if (!record?.name || record.archived || !rules.status(record.name).active) continue;
    if (!isDate(date) || daysBetween(today, date) < 0 || daysBetween(today, date) > window || !recordOf(state, record.name)) continue;
    const one = bookCrunch(state, { course: record.name, date: today, ...(args.minutesPerDay !== undefined ? { minutesPerDay: args.minutesPerDay } : {}),
      ...(args.daysOff !== undefined ? { daysOff: args.daysOff } : {}), ...(args.reviewDays !== undefined ? { reviewDays: args.reviewDays } : {}) }, options);
    if (one.status !== 'ok') continue;
    const byId = new Map(one.points.map(point => [point.id, point])), flips = one.plan.days.filter(day => day.mode === 'flip');
    courses.push({ course: one.course, examDate: one.examDate, daysLeft: one.daysLeft, reviewDays: one.plan.reviewDays, flipStart: one.plan.flipStart,
      mockDate: flips.find(day => day.mock)?.date ?? null, revision: one.revision, today: one.plan.today,
      points: (one.plan.today?.points || []).map(id => byId.get(id)).filter(Boolean) });
  }
  courses.sort((a, b) => a.daysLeft - b.daysLeft || (a.course < b.course ? -1 : a.course > b.course ? 1 : 0));
  return { status: 'ok', today, window, courses };
}

/** book.crunch.mark (see the top of this file): a mutation of the state. -> { status: 'marked' | 'cleared' | 'unchanged', course } */
export function markCrunch(state, args = {}) {
  const course = bookCourseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  if (!record) fail('这门课还没有复习全书 / This course has no review book yet', 'book-crunch-no-book');
  if (args.kind !== 'read' && args.kind !== 'seen') fail('kind must be read or seen', 'book-crunch-kind');
  const leaves = new Set(leavesOf(record.bookDoc.manifest?.nodes).map(node => node.hid));
  if (typeof args.hid !== 'string' || !leaves.has(args.hid)) fail('书里没有这一节 / The book has no such point', 'book-crunch-point');
  const date = todayOf(args), on = args.on !== false;
  const marks = record.bookDoc.marks && typeof record.bookDoc.marks === 'object' ? record.bookDoc.marks : (record.bookDoc.marks = {});
  const list = marks[args.kind] && typeof marks[args.kind] === 'object' ? marks[args.kind] : (marks[args.kind] = {});
  // Marks of points the outline no longer has are let go (a mark is a day per point: small).
  for (const kind of ['read', 'seen']) for (const hid of Object.keys(marks[kind] || {})) if (!leaves.has(hid)) delete marks[kind][hid];
  if (on ? list[args.hid] === date : !Object.hasOwn(list, args.hid)) return { status: 'unchanged', course };
  if (on) list[args.hid] = date; else delete list[args.hid];
  return { status: on ? 'marked' : 'cleared', course };
}

/** book.mock.plan (and the first half of book.mock): which questions of which points a mock paper takes, and what it leaves out. */
export function mockPlan(state, args = {}, options = {}) {
  const crunch = bookCrunch(state, { course: args.course, date: args.date }, options);
  if (!crunch.points) fail('这门课还没有复习全书 / This course has no review book yet', 'book-mock-no-book');
  const known = new Map(crunch.points.map(point => [point.id, point]));
  if (args.pointIds !== undefined && (!Array.isArray(args.pointIds) || args.pointIds.length > 800 || args.pointIds.some(id => typeof id !== 'string')))
    fail('pointIds must be a list of heading ids', 'book-mock-points');
  const asked = args.pointIds !== undefined ? [...new Set(args.pointIds)]
    : crunch.status === 'ok' && crunch.plan.today?.points.length ? crunch.plan.today.points : crunch.points.map(point => point.id);
  const ids = asked.filter(id => known.has(id)), unknown = asked.filter(id => !known.has(id));
  if (!ids.length) fail('没有选中任何一节 / No point is chosen', 'book-mock-points');
  if (args.count !== undefined && !isExamQuestionCount(args.count)) fail(`Choose ${EXAM_QUESTION_COUNT.min}–${EXAM_QUESTION_COUNT.max} exam questions`, 'book-mock-count');
  const { rowOf, entriesOf } = courseRowsOf(state, crunch.course);
  const decks = new Map((state.decks || []).map(deck => [deck.id, deck])), taken = new Set(), eligible = [], leftOut = {}, perPoint = [];
  for (const id of ids) {
    const point = known.get(id), row = rowOf(point.key), entries = row && row !== 'unplaced' ? entriesOf(row) : [];
    let own = 0;
    for (const entry of entries) {
      const card = (decks.get(entry.deckId)?.cards || []).find(item => item?.id === entry.cardId);
      if (!card) continue;
      if (MOCK_KINDS.includes(card.kind)) own += 1;
      const key = `${entry.deckId}|${entry.cardId}`;
      if (taken.has(key)) continue;
      taken.add(key);
      if (MOCK_KINDS.includes(card.kind)) eligible.push(entry); else leftOut[card.kind || 'flashcard'] = (leftOut[card.kind || 'flashcard'] || 0) + 1;
    }
    perPoint.push({ id, code: point.code, title: point.title, questions: entries.length, eligible: own });
  }
  // Due and weak first: a practice round's order over the eligible questions alone (as the 总纲's pick, lib/course-outline.js).
  const wanted = new Map();
  for (const entry of eligible) { if (!wanted.has(entry.deckId)) wanted.set(entry.deckId, new Set()); wanted.get(entry.deckId).add(entry.cardId); }
  const scoped = [...wanted].map(([deckId, cards]) => ({ ...decks.get(deckId), cards: decks.get(deckId).cards.filter(card => cards.has(card.id)) }));
  const ordered = scoped.length ? planPath(scoped, latestOutcomes(state.attempts || []), { scope: scoped.map(deck => ({ deckId: deck.id })) }).entries : [];
  const count = args.count ?? Math.min(MOCK_COUNT, eligible.length), seen = new Set(), scope = [];
  for (const { deckId, card } of ordered) {
    const key = `${deckId}|${card.id}`;
    if (seen.has(key) || !wanted.get(deckId)?.has(card.id) || scope.length >= count) continue;
    seen.add(key);
    scope.push({ deckId, cardId: card.id });
  }
  const writing = courseRecord(state, crunch.course)?.exam?.writingMinutes;
  return { status: 'ok', course: crunch.course, points: ids, unknown, questions: taken.size, eligible: eligible.length, leftOut, count: scope.length,
    capped: eligible.length > scope.length, perPoint, scope,
    // The time limit the exam page would start on: the course's own 作答时间, else the exam mode's default.
    ...(Number.isInteger(writing) && writing >= LIMIT_MINUTES.min && writing <= LIMIT_MINUTES.max ? { limitMinutes: writing } : {}) };
}
