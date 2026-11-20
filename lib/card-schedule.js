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
import {
  collectOriginTargets,
  dayNumberOf,
  dayNumberOfDate,
  fuzzRange,
  normalizeRestRules,
  pickBalancedDay,
  siblingGroupKeys,
  startOfLocalDay,
} from "./contexts/study/load-balance.js";

/** Whether answers are aligned to the course exam: on unless the learner switched it off. */
export const examAlignmentOn = (settings) => settings?.exam_alignment !== false;

/** Whether deterministic FSRS4Anki-style load balancing is enabled (opt-in for safe backward compatibility). */
export const loadBalanceOn = (settings) => settings?.load_balance === true;

/** Whether sibling dispersal across same-source/same-page/same-point cards is enabled (opt-in). */
export const siblingDispersalOn = (settings) => settings?.disperse_siblings === true;

/** The exam a deck's course sits: `{ date: YYYY-MM-DD, course }` with the name of the course record the date is on (the course's
    own, else the nearest parent course's: a chapter shares its course's exam); null for a deck without a course or a course
    without a date. */
/** Nearest exam date on `name` or its ancestor course ({ date, course }), or null when none applies. */
export function courseExamByName(state, name) {
  const courses = Array.isArray(state?.courses) ? state.courses : [];
  if (typeof name !== "string" || !name.trim() || !courses.some((record) => isDate(record?.exam?.date))) return null;
  const own = courseIndex(state).resolve(name);
  if (isDate(own?.exam?.date)) return { date: own.exam.date, course: own.name };
  const known = [...new Set([...knownCourseNames(state), ...courses.map((record) => record?.name).filter(Boolean)])];
  const ancestors = courseAncestors(name, known);
  let found = null, depth = -1;
  for (const record of courses) {
    if (!isDate(record?.exam?.date) || typeof record.name !== "string") continue;
    const at = ancestors.indexOf(coursePath(record.name, known));
    if (at > depth) [found, depth] = [{ date: record.exam.date, course: record.name }, at];
  }
  return found;
}

export function courseExam(state, deck) {
  if (!deck || deck.systemKind) return null;
  return courseExamByName(state, courseOf(deck));
}

/** The exam date (YYYY-MM-DD) of a deck's course (see courseExam), or null. */
export const courseExamDate = (state, deck) => courseExam(state, deck)?.date ?? null;

/** `{ settings, isFocus }` for `card` in `deck` (a deck without a course, such as a system deck, takes no course focus topics
    and no exam date). */
export function cardScheduleSettings(state, deck, card) {
  const focusTopics = deck ? courseFocusTopics(state, courseOf(deck)) : [];
  const isFocus = isFocusCard(card, { focusTopics });
  const { exam_date: _stray, ...settings } = focusScheduleSettings(state.settings, { isFocus }) ?? {};
  const examDate = examAlignmentOn(state.settings) ? courseExamDate(state, deck) : null;
  return { settings: examDate ? { ...settings, exam_date: examDate } : settings, isFocus };
}

/** Resolve restDates / studyWeekdays from the deck's course plan (or nearest ancestor course). */
export function courseRestRules(state, deck) {
  if (!deck || deck.systemKind) return normalizeRestRules();
  const name = courseOf(deck);
  if (typeof name !== "string" || !name.trim()) return normalizeRestRules();
  const record = courseIndex(state).resolve(name);
  const plan = record?.plan;
  return normalizeRestRules({ restDates: plan?.restDates, studyWeekdays: plan?.studyWeekdays });
}

/**
 * Pure post-schedule pass (FSRS4Anki Load Balance + Sibling Dispersal) applied on top of a review
 * returned by `lib/sm2.js` `schedule()`. Never alters FSRS memory state (`stability`, `difficulty`,
 * `interval_days`); only shifts `due_at` inside the permissible FSRS fuzz window when enabled.
 */
export function balanceCardReview(state, deck, card, review, {
  now = Date.now(),
  loadBalance = loadBalanceOn(state?.settings),
  disperseSiblings = siblingDispersalOn(state?.settings),
  dailyCap = null,
  minSiblingGap = 2,
  easyDayWeights = null,
} = {}) {
  if (!review || (!loadBalance && !disperseSiblings)) return review;
  const dueMs = Date.parse(review.due_at);
  const interval = Number(review.interval_days);
  if (!Number.isFinite(dueMs) || !Number.isFinite(interval) || interval < 2.5) return review;

  const today = dayNumberOf(now);
  const targetDay = dayNumberOf(dueMs);
  const maxInterval = Number(state?.settings?.maximum_interval) || 36500;
  const fuzz = fuzzRange(interval, { maxInterval });
  let minDay = Math.max(today + 1, today + fuzz.min);
  let maxDay = Math.max(minDay, today + fuzz.max);

  const examDate = examAlignmentOn(state?.settings) ? courseExamDate(state, deck) : null;
  const examDay = examDate ? dayNumberOfDate(examDate) : null;
  if (examDay !== null && examDay > today && targetDay <= examDay) {
    maxDay = Math.min(maxDay, examDay);
    minDay = Math.min(minDay, maxDay);
  }
  if (maxDay <= minDay) return review;

  const sourcesById = new Map((Array.isArray(state?.sources) ? state.sources : []).filter((s) => s?.id).map((s) => [s.id, s]));
  const originTargets = disperseSiblings ? collectOriginTargets(state?.decks) : null;
  const myKeys = disperseSiblings ? new Set(siblingGroupKeys(card, { sourcesById, deckId: deck?.id, originTargets })) : new Set();

  const dailyLoad = new Map();
  const siblingDays = [];
  for (const d of state?.decks || []) {
    if (d.archived) continue;
    for (const other of d.cards || []) {
      if (other.suspended || (d.id === deck?.id && other.id === card?.id)) continue;
      const at = Date.parse(other.review?.due_at);
      if (!Number.isFinite(at)) continue;
      const otherDay = dayNumberOf(at);
      if (otherDay >= minDay && otherDay <= maxDay) {
        dailyLoad.set(otherDay, (dailyLoad.get(otherDay) || 0) + 1);
      }
      if (myKeys.size) {
        const otherKeys = siblingGroupKeys(other, { sourcesById, deckId: d.id, originTargets });
        if (otherKeys.some((k) => myKeys.has(k))) siblingDays.push(otherDay);
      }
    }
  }

  const picked = pickBalancedDay({
    targetDay,
    minDay,
    maxDay,
    dailyLoad,
    restRules: courseRestRules(state, deck),
    easyDayWeights,
    dailyCap,
    siblingDays,
    minSiblingGap,
    preferLowerLoad: loadBalance,
  });
  if (picked.day === targetDay) return review;
  return {
    ...review,
    due_at: new Date(startOfLocalDay(picked.day)).toISOString(),
  };
}
