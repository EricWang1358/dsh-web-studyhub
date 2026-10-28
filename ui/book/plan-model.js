/* 备考计划 on the review book page (ui/book/PlanSection.jsx): what state the page is in and which days it lists. Pure, no React, no DOM.
   The plan (course.plan, lib/course-plan.js) covers the whole period up to the exam; 期末一周 (book.crunch, lib/crunch-plan.js) covers the last days. The page
   shows each day once: the plan lists its days up to the day the final week begins, and from then on the daily part is 期末一周's.
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT). */
import { addDays } from '../../lib/crunch-plan.js';

/** What the section draws for a course.plan answer: 'plan' (a schedule), 'invite' (no plan yet: draft one in the chat), 'need-exam' (no exam date: a plan has no days
    without it), 'past' (the exam is over), or null (nothing: not asked yet, no book, no course, an error). */
export function planKind(answer) {
  switch (answer?.status) {
    case 'ok': return 'plan';
    case 'no-plan': return answer.examDate ? 'invite' : 'need-exam';
    case 'no-exam': return 'need-exam';
    case 'past': return 'past';
    default: return null;
  }
}

/** The day the final week begins: `windowDays` before the exam (settings.book.crunchWindowDays, lib/book-settings.js). */
export const crunchStartOf = (examDate, windowDays) => addDays(examDate, -windowDays);

/** Whether 期末一周 plans the days from now on: the exam is within its window (the same rule as book.crunch's status 'ok'). */
export const handsToCrunch = (daysLeft, windowDays) => Number.isFinite(daysLeft) && daysLeft <= windowDays;

/** The days after today the plan lists, before `before` (the day the final week begins), at most `limit`. */
export const upcomingDays = (schedule, before, limit = 7) => (schedule?.days || []).filter(item => item.offset > 0 && item.date < before).slice(0, limit);

/** 'YYYY-MM-DD' as 'MM/DD' (the plan never spans enough to need the year); '' for anything else. */
export const shortDate = date => (typeof date === 'string' && date.length >= 10 ? `${date.slice(5, 7)}/${date.slice(8, 10)}` : '');
