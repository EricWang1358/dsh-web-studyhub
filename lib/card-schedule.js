/* The scheduling settings of one question, derived in one place (#882). Every path that schedules a question passes
   these to lib/sm2.js `schedule` / `nextIntervals`: a practice answer and its button preview, a mock exam, prerequisite
   credit, rubric grading, the oral mock and the sample library's history. The library's own settings are the base; a
   focus question (重点, lib/focus-points.js) gets the raised target recall (lib/sm2.js focusScheduleSettings); a question
   whose course has an exam date carries it as `exam_date`, so the answer comes back by the exam (lib/sm2.js, exam
   alignment), unless the learner switched that off (`exam_alignment: false` in the library settings). */
import { focusScheduleSettings } from "./sm2.js";
import { courseOf } from "./focus.js";
import { courseFocusTopics, isFocusCard } from "./focus-points.js";
import { courseIndex } from "./courses.js";
import { courseAncestors, coursePath } from "./course-tree.js";
import { knownCourseNames } from "./source-courses.js";
import { isDate } from "./crunch-plan.js";

/** Whether answers are aligned to the course exam: on unless the learner switched it off. */
export const examAlignmentOn = (settings) => settings?.exam_alignment !== false;

/** The exam date (YYYY-MM-DD) of a deck's course: the course's own, else the nearest parent course's (a chapter shares its
    course's exam); null for a deck without a course or a course without a date. */
export function courseExamDate(state, deck) {
  const courses = Array.isArray(state?.courses) ? state.courses : [];
  if (!deck || deck.systemKind || !courses.some((record) => isDate(record?.exam?.date))) return null;
  const name = courseOf(deck);
  if (typeof name !== "string" || !name.trim()) return null;
  const own = courseIndex(state).resolve(name)?.exam?.date;
  if (isDate(own)) return own;
  const known = [...new Set([...knownCourseNames(state), ...courses.map((record) => record?.name).filter(Boolean)])];
  const ancestors = courseAncestors(name, known);
  let date = null, depth = -1;
  for (const record of courses) {
    if (!isDate(record?.exam?.date) || typeof record.name !== "string") continue;
    const at = ancestors.indexOf(coursePath(record.name, known));
    if (at > depth) [date, depth] = [record.exam.date, at];
  }
  return date;
}

/** `{ settings, isFocus }` for `card` in `deck` (a deck without a course, such as a system deck, takes no course focus topics
    and no exam date). */
export function cardScheduleSettings(state, deck, card) {
  const focusTopics = deck ? courseFocusTopics(state, courseOf(deck)) : [];
  const isFocus = isFocusCard(card, { focusTopics });
  const { exam_date: _stray, ...settings } = focusScheduleSettings(state.settings, { isFocus }) ?? {};
  const examDate = examAlignmentOn(state.settings) ? courseExamDate(state, deck) : null;
  return { settings: examDate ? { ...settings, exam_date: examDate } : settings, isFocus };
}
