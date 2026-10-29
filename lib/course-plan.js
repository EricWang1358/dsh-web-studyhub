/* Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
   备考计划 (docs/review-book.md): the ops' view of one course's whole-period plan — the stored strategy (the course
   record's `plan`, lib/courses.js checkedPlan) expanded over the review book's points by lib/plan-schedule.js. Read only;
   the strategy itself is written through course.save {plan} (area learning). No model call.

   course.plan { course?, date?, days? } -> { status, course, examDate, daysLeft, today, revision, plan, schedule, points }
     status: 'ok'; 'no-plan' (the course has no plan yet), 'no-book' (no review book to schedule over), 'no-course', and the
     schedule's own 'no-exam' / 'past' (a plan without an exam date computes nothing: offer to set the course's exam info
     first). `date` is the learner's today; `days` (1–400, default 14) caps how many of today's and later days the schedule
     lists. points: the crunchPoints shape (see lib/course-book-crunch.js). The schedule recomputes from current mastery, so
     it is never stored; `plan` is exactly what course.save kept. */
import { openCourseBook, recordOf, courseOf as bookCourseOf } from './course-book-files.js';
import { crunchPoints } from './course-book-crunch.js';
import { periodPlan } from './plan-schedule.js';
import { addDays, isDate, CRUNCH } from './crunch-plan.js';
import { localDate } from './board-model.js';

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
/** The course record (the plan and the exam date live there) and the book's record (its marks and revision). */
const courseRecord = (state, course) => (state.courses || []).find(item => item && item.name === course) ?? null;
const marksOf = record => ({ read: { ...(record?.bookDoc?.marks?.read || {}) }, seen: { ...(record?.bookDoc?.marks?.seen || {}) } });

/* One answer per course, library revision, book revision, day and plan: the panel asks when the book changes, and the
   schedule only moves when the strategy, the points or today moved. Without a library revision (a plain state in a test)
   nothing is kept. */
const memo = new Map(), MEMO_KEPT = 16;

export function coursePlan(state, args = {}, { root = '' } = {}) {
  const today = args.date === undefined ? localDate() : isDate(args.date) ? args.date : fail('date must be a YYYY-MM-DD day', 'course-plan-date');
  const name = bookCourseOf(state, args);
  if (name === null || name === undefined) return { status: 'no-course', course: null, today };
  const bookRecord = recordOf(state, name), course = courseRecord(state, name);
  const plan = course?.plan && typeof course.plan === 'object' && course.plan.version === 1 ? course.plan : null;
  const key = state?.revision === undefined ? null : JSON.stringify([root, state.revision, name ?? null, bookRecord?.bookDoc?.revision ?? null, today,
    plan?.updatedAt ?? null, args.days ?? null, courseRecord(state, name)?.exam?.date ?? null]);
  if (key && memo.has(key)) return memo.get(key);
  const value = computePlan(state, name, course, bookRecord, plan, today, args);
  if (key) { memo.set(key, value); if (memo.size > MEMO_KEPT) memo.delete(memo.keys().next().value); }
  return value;
}

function computePlan(state, course, courseRec, bookRecord, plan, today, args) {
  const examDate = isDate(courseRec?.exam?.date) ? courseRec.exam.date : null;
  if (!plan) return { status: 'no-plan', course, examDate, today, plan: null };
  // A book that was never opened has no record (and no marks): the page offers to write it first, as book.crunch does.
  const book = bookRecord ? openCourseBook(state, { course }, { write: false }) : null;
  if (book?.status !== 'ok') return { status: 'no-book', course, examDate, today, plan };
  // A whole-period plan counts work from before its window too: the marks a year back still say what is already learnt.
  const points = crunchPoints(state, book, { today, from: addDays(today, -CRUNCH.maxDays), marks: marksOf(bookRecord) });
  const days = Number(args.days);
  const schedule = periodPlan({ points, plan, papers: book.papers, examDate, today,
    done: Object.fromEntries(points.filter(point => point.done).map(point => [point.id, point.done])),
    seen: Object.fromEntries(points.filter(point => point.seen).map(point => [point.id, point.seen])),
    ...(Number.isFinite(days) && days >= 1 && days <= 400 ? { days } : {}) });
  return { status: schedule.status, course, examDate, daysLeft: schedule.daysLeft, today, revision: book.revision, plan, schedule, points };
}
