/* Exam alignment of the due dates already stored (#882). An answer before a course exam is scheduled by the exam day
   (lib/sm2.js), but a question answered before the exam date was set, or while alignment was off, can still be due after
   it and would not come back by itself. `alignDueDates` gives each such question a due date before the exam, without
   touching its memory state: only `due_at` moves, and the due date it had is kept in `unaligned_due_at`. The questions
   are spread over the days left (today up to the day before the exam), the ones with the lowest recall now first.

   The pass reads the library as it is, so it is idempotent: a question already due before its exam keeps its date, one
   whose exam was removed, has passed, moved later than its own due date, or whose alignment was switched off gets its
   own date back. The course and settings writes call it when the exam dates or the switch change. */
import { checkSettings, retrievabilityAt } from "./sm2.js";
import { courseExamDate, examAlignmentOn } from "./card-schedule.js";
import { isDate } from "./crunch-plan.js";

const DAY_MS = 864e5;
/** The local calendar day of an instant, as a day number (lib/sm2.js counts days the same way). */
const dayOf = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
};
const dayOfDate = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
};
/** 00:00 local time on a day number: due for the whole of that day. */
const startOf = (day) => {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
};

/** The exam day number each deck is aligned to now, or null (no course exam, alignment off, a system deck). */
function examDays(state) {
  const on = examAlignmentOn(state.settings), byCourse = new Map();
  return (deck) => {
    if (!on || deck.systemKind) return null;
    const key = JSON.stringify([deck.course ?? deck.folder ?? null, deck.courseId ?? null]);
    if (!byCourse.has(key)) {
      const date = courseExamDate(state, deck);
      byCourse.set(key, date ? { date, day: dayOfDate(date) } : null);
    }
    return byCourse.get(key);
  };
}

/**
 * Align the stored due dates of `state` (a library, changed in place) to its course exams at `now`.
 * Returns `{ pulled, restored }`: questions given a due date before their exam, and questions given their own back.
 * A suspended question or one in an archived deck is not pulled, but is given its own date back like any other.
 */
export function alignDueDates(state, now = Date.now()) {
  const today = dayOf(now), examOf = examDays(state), recall = retrievabilityAt(state.settings);
  const waiting = new Map();
  let restored = 0;
  for (const deck of state.decks || []) {
    const exam = examOf(deck), ahead = exam && exam.day > today ? exam : null;
    for (const card of deck.cards || []) {
      const review = card.review;
      if (!review?.due_at) continue;
      const own = review.unaligned_due_at ?? review.due_at, ownAt = Date.parse(own);
      if (!Number.isFinite(ownAt)) continue;
      if (!ahead || dayOf(ownAt) <= ahead.day) {
        if (review.unaligned_due_at !== undefined) {
          review.due_at = own;
          delete review.unaligned_due_at;
          restored++;
        }
        continue;
      }
      if (review.unaligned_due_at !== undefined && dayOf(Date.parse(review.due_at)) <= ahead.day) continue;
      if (card.suspended || deck.archived) continue;
      if (!waiting.has(ahead.date)) waiting.set(ahead.date, { day: ahead.day, items: [] });
      waiting.get(ahead.date).items.push({ review, own, recall: recall(review, now) });
    }
  }
  let pulled = 0;
  for (const { day, items } of waiting.values()) {
    const days = day - today;
    items.sort((a, b) => a.recall - b.recall);
    items.forEach((item, at) => {
      item.review.unaligned_due_at = item.own;
      item.review.due_at = new Date(startOf(today + Math.floor((at * days) / items.length))).toISOString();
      pulled++;
    });
  }
  return { pulled, restored };
}

/** What the alignment of a library depends on besides the reviews: the switch and each course's exam date. */
const alignmentInputs = (state) => JSON.stringify([examAlignmentOn(state.settings), (state.courses || []).map((course) => [course?.id, course?.name, course?.exam?.date ?? null])]);

/** Run `write(state)` (a course or settings write, inside its store transaction) and align the due dates when it changed an
    exam date or the alignment switch. Returns what `write` returns. */
export function withExamAlignment(state, write, now = Date.now()) {
  const before = alignmentInputs(state);
  const result = write(state);
  if (alignmentInputs(state) !== before) alignDueDates(state, now);
  return result;
}

/** Switch exam alignment on or off (`exam_alignment` in the library settings) and move the stored due dates with it.
    Returns `{ enabled, pulled, restored }`. */
export function setExamAlignment(state, enabled, now = Date.now()) {
  if (typeof enabled !== "boolean") throw new Error("考前对齐的开关需为 true 或 false");
  state.settings = checkSettings({ ...state.settings, exam_alignment: enabled });
  return { enabled, ...alignDueDates(state, now) };
}

/** The days the preview of the switch looks ahead, today first (the brief of #882: the next two weeks). */
export const ALIGNMENT_PREVIEW_DAYS = 14;
const localDate = (day) => {
  const d = new Date(startOf(day));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Each previewed day's due count: the questions practised (not suspended, not in an archived deck) due that day, overdue ones today. */
function dueCounts(decks, today) {
  const counts = Array(ALIGNMENT_PREVIEW_DAYS).fill(0);
  for (const deck of decks || []) {
    if (deck.archived) continue;
    for (const card of deck.cards || []) {
      const at = Date.parse(card.review?.due_at);
      if (card.suspended || !Number.isFinite(at)) continue;
      const day = Math.max(0, dayOf(at) - today);
      if (day < ALIGNMENT_PREVIEW_DAYS) counts[day]++;
    }
  }
  return counts;
}
/** The library as the pass would leave it with the switch `enabled`: the decks are copied, nothing else is written. */
function simulated(state, enabled, now) {
  const copy = { ...state, settings: { ...state.settings, exam_alignment: enabled }, decks: structuredClone(state.decks || []) };
  return { decks: copy.decks, moved: alignDueDates(copy, now) };
}

/**
 * What 考前对齐 does to the next ALIGNMENT_PREVIEW_DAYS days, simulated with the pass itself on a copy (never written):
 * `{ enabled, courses: [{ name, date }] (courses with an exam ahead), pending, days: [{ date, before }], on, off }`, where `on` / `off` are
 * `[{ date, before, after }]`: each day's due count now and right after switching to that state. `pending` counts the questions the
 * pass would still bring before their exam with the switch as it is (a library whose exam date was set before alignment existed). Answers after the switch
 * are capped too, so the real extra load grows beyond `on`: the interface calls it an estimate.
 */
export function examAlignmentPreview(state, now = Date.now()) {
  const today = dayOf(now), enabled = examAlignmentOn(state.settings);
  const courses = (state.courses || []).filter((course) => isDate(course?.exam?.date) && dayOfDate(course.exam.date) > today)
    .map((course) => ({ name: course.name, date: course.exam.date })).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const before = dueCounts(state.decks, today);
  const dates = before.map((_, at) => localDate(today + at));
  const switched = (on) => {
    const after = dueCounts(simulated(state, on, now).decks, today);
    return dates.map((date, at) => ({ date, before: before[at], after: after[at] }));
  };
  const { moved } = simulated(state, enabled, now);
  return { enabled, courses, pending: moved.pulled, days: dates.map((date, at) => ({ date, before: before[at] })), on: switched(true), off: switched(false) };
}