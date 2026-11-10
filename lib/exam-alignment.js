/* Exam alignment of the due dates already stored (#882). An answer before a course exam is scheduled by the exam day
   (lib/sm2.js), but a question answered before the exam date was set, or while alignment was off, can still be due after
   it and would not come back by itself. `alignDueDates` gives each such question a due date before the exam, without
   touching its memory state: only `due_at` moves, and the due date it had is kept in `unaligned_due_at`. The questions
   are spread over the days left (today up to the day before the exam), the ones with the lowest recall now first.
   A question is never brought forward to a day before the day after its last answer (#931: one answered a moment ago is
   not due again today; `memoryState` gives the last answer: an FSRS `last_review`, or what an SM-2 review's due date and
   interval stand for; unknown, it may take today). Each day takes, lowest recall first, the questions that may take it,
   up to its even share of those still waiting over the days left (`spreadDays`): a raised floor does not pile the
   questions on one day (a library answered today is spread over tomorrow up to the day before the exam, not put on
   tomorrow). The one question the floor can put on the exam day itself is one answered the day before it (today, the
   exam tomorrow): it is due from 00:00 on the exam day, which is what an answer given now gets from the scheduler (lib/sm2.js).

   Which questions: answered ones (never-answered questions are new, as the due forecast counts them, lib/insights.js) of
   decks that count (not archived, not in a parked course, lib/course-active.js: parking never touches a schedule), not
   suspended. A moved question gets its own date back when its deck has no exam any more (removed, the switch off, the deck
   in another course), when the exam moved to on or after its own date, or once the exam day is over; on the exam day
   itself it stays where it is (or, when the exam was just moved to today and its moved date is later, is due from 00:00 today). Nothing runs when the day passes: after the exam the moved questions stay due until they
   are answered or the learner gives their dates back in Settings (`restoreDueDates`), and any pass that runs for another
   reason gives them back too.

   The pass reads the library as it is, so it is idempotent. Triggers: a course write that changes the exam a deck sits
   (course.save, course.merge, course.rename: `withExamAlignment`, bringing forward only those decks), the switch and
   现在对齐 (`setExamAlignment`, every course), and the restore button (`restoreDueDates`, never brings anything forward). */
import { checkSettings, memoryState, retrievabilityAt } from "./sm2.js";
import { courseExam, examAlignmentOn } from "./card-schedule.js";
import { courseActivityRules } from "./course-active.js";
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
/** Answered at least once: the "not new" of the due forecast, read from the review itself (an FSRS answer count or last
    review, an SM-2 streak or gap), since the attempts are not this module's to read. */
const answered = (review) => Number(review?.reps) > 0 || Number(review?.repetitions) > 0 || Number(review?.interval_days) > 0 || !!review?.last_review;

/** The exam each deck is aligned to now: `{ date, day, course }` or null (no course exam, alignment off, a system deck). */
function examDays(state, on = examAlignmentOn(state.settings)) {
  const byCourse = new Map();
  return (deck) => {
    if (!on || deck.systemKind) return null;
    const key = JSON.stringify([deck.course ?? deck.folder ?? null, deck.courseId ?? null]);
    if (!byCourse.has(key)) {
      const exam = courseExam(state, deck);
      byCourse.set(key, exam ? { ...exam, day: dayOfDate(exam.date) } : null);
    }
    return byCourse.get(key);
  };
}

/**
 * The day each of `items` (sorted, lowest recall first; each has the `floor` day it may not come before) is brought forward
 * to, as day numbers in the same order: between `today` and the day before `examDay`. Day by day, the questions that may
 * take it are taken in order, up to the even share of the questions still waiting over the days left (`ceil(waiting / days
 * left)`); with no floor that is the plain spread over the days, and the share of a day nobody may take is spread over the
 * following ones. A question whose floor is the exam day itself (answered the day before it) takes the exam day.
 */
function spreadDays(items, today, examDay) {
  const at = new Map();
  let waiting = items.filter((item) => item.floor < examDay);
  for (let day = today; day < examDay; day++) {
    let share = Math.ceil(waiting.length / (examDay - day));
    waiting = waiting.filter((item) => {
      if (share <= 0 || item.floor > day) return true;
      at.set(item, day);
      share--;
      return false;
    });
  }
  return items.map((item) => at.get(item) ?? examDay);
}

/**
 * Align the stored due dates of `state` (a library, changed in place) to its course exams at `now`.
 * `pull: false` only gives dates back; `pullDecks` (a Set of deck ids) brings forward only those decks' questions, while every
 * moved question anywhere may still be given back. `onPull(course)` hears, per question brought forward, the course the exam is on.
 * Returns `{ pulled, restored }`: questions given a due date before their exam, and questions given their own back.
 */
export function alignDueDates(state, now = Date.now(), { pull = true, pullDecks = null, onPull } = {}) {
  const today = dayOf(now), examOf = examDays(state), recall = retrievabilityAt(state.settings), rules = courseActivityRules(state);
  const waiting = new Map();
  let restored = 0, pulled = 0;
  for (const deck of state.decks || []) {
    const exam = examOf(deck), ahead = exam && exam.day > today ? exam : null;
    const pulls = pull && !!ahead && !deck.archived && rules.deckActive(deck) && (!pullDecks || pullDecks.has(deck.id));
    for (const card of deck.cards || []) {
      const review = card.review;
      if (!review?.due_at) continue;
      const own = review.unaligned_due_at ?? review.due_at, ownAt = Date.parse(own);
      if (!Number.isFinite(ownAt)) continue;
      if (review.unaligned_due_at !== undefined) {
        // Moved for an exam: kept while that exam is ahead or today and its own date still falls after it.
        if (!exam || exam.day < today || dayOf(ownAt) <= exam.day) {
          review.due_at = own;
          delete review.unaligned_due_at;
          restored++;
          continue;
        }
        if (dayOf(Date.parse(review.due_at)) <= exam.day) continue;
        // The exam moved to today, before this question's moved date: no day is left before it, so it is due from 00:00 today.
        if (exam.day === today) {
          if (pull && (!pullDecks || pullDecks.has(deck.id))) {
            review.due_at = new Date(startOf(today)).toISOString();
            onPull?.(exam.course);
            pulled++;
          }
          continue;
        }
      }
      if (!pulls || dayOf(ownAt) <= ahead.day || card.suspended || !answered(review)) continue;
      if (!waiting.has(ahead.date)) waiting.set(ahead.date, { day: ahead.day, items: [] });
      // The soonest day it may come back: the day after its last answer, and no later than the exam day.
      const last = memoryState(review, now).lastReview, floor = last === null ? today : Math.min(Math.max(today, dayOf(last) + 1), ahead.day);
      waiting.get(ahead.date).items.push({ review, own, course: ahead.course, recall: recall(review, now), floor });
    }
  }
  for (const { day, items } of waiting.values()) {
    items.sort((a, b) => a.recall - b.recall);
    spreadDays(items, today, day).forEach((at, i) => {
      const item = items[i];
      item.review.unaligned_due_at = item.own;
      item.review.due_at = new Date(startOf(at)).toISOString();
      onPull?.(item.course);
      pulled++;
    });
  }
  return { pulled, restored };
}

/** Give back the due dates no exam needs any more (the exam is over, removed, switched off): the restore pass, never a pull. */
export const restoreDueDates = (state, now = Date.now()) => alignDueDates(state, now, { pull: false });

/** What the alignment of a library depends on besides the reviews: the switch and the exam date each deck sits. */
function alignmentInputs(state) {
  const examOf = examDays(state, true);
  return { on: examAlignmentOn(state.settings), decks: new Map((state.decks || []).map((deck) => [deck.id, examOf(deck)?.date ?? null])) };
}

/** Run `write(state)` (a course write, inside its store transaction) and, when it changed the exam date of some deck,
    bring forward those decks' questions (and give back whatever no longer needs moving anywhere). Returns
    `{ result, alignment }`: what `write` returned, and `{ pulled, restored }` when the pass ran, else null. */
export function withExamAlignment(state, write, now = Date.now()) {
  const before = alignmentInputs(state);
  const result = write(state);
  const after = alignmentInputs(state);
  const changed = new Set([...after.decks].filter(([id, date]) => before.decks.get(id) !== date).map(([id]) => id));
  if (before.on === after.on && !changed.size) return { result, alignment: null };
  return { result, alignment: alignDueDates(state, now, before.on === after.on ? { pullDecks: changed } : {}) };
}

/** Switch exam alignment on or off (`exam_alignment` in the library settings) and move the stored due dates of every course
    with it (also 现在对齐: switching on when it is on). Returns `{ enabled, pulled, restored }`. */
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
/** Each previewed day's due count, as the due forecast counts it: answered, not suspended questions of decks that count
    (`counts(deck)`), overdue ones today. */
function dueCounts(decks, today, counts) {
  const days = Array(ALIGNMENT_PREVIEW_DAYS).fill(0);
  for (const deck of decks || []) {
    if (!counts(deck)) continue;
    for (const card of deck.cards || []) {
      const at = Date.parse(card.review?.due_at);
      if (card.suspended || !Number.isFinite(at) || !answered(card.review)) continue;
      const day = Math.max(0, dayOf(at) - today);
      if (day < ALIGNMENT_PREVIEW_DAYS) days[day]++;
    }
  }
  return days;
}
/** The library as the pass would leave it with the switch `enabled`: the decks are copied, nothing else is written. */
function simulated(state, enabled, now) {
  const copy = { ...state, settings: { ...state.settings, exam_alignment: enabled }, decks: structuredClone(state.decks || []) };
  const byCourse = new Map();
  const moved = alignDueDates(copy, now, { onPull: (course) => byCourse.set(course, (byCourse.get(course) || 0) + 1) });
  return { decks: copy.decks, moved, byCourse };
}

/**
 * What 考前对齐 does to the next ALIGNMENT_PREVIEW_DAYS days, simulated with the pass itself on a copy (never written):
 * `{ enabled, courses: [{ name, date, pending }] (active courses with an exam ahead), pending, restorable, days: [{ date, before }], on, off }`,
 * where `on` / `off` are `[{ date, before, after }]`: each day's due count now and right after switching to that state. `pending` counts
 * the questions a pass would still bring before their exam with the switch as it is (a library whose exam date was set before
 * alignment existed: 现在对齐), per course in `courses`; `restorable` the moved questions a pass would give their dates back (the exam
 * is over, removed or no longer the deck's). Answers after the switch are capped too, so the real extra load grows beyond `on`: the
 * interface calls it an estimate.
 */
export function examAlignmentPreview(state, now = Date.now()) {
  const today = dayOf(now), enabled = examAlignmentOn(state.settings), rules = courseActivityRules(state);
  const counts = (deck) => !deck.archived && rules.deckActive(deck);
  const sims = { on: simulated(state, true, now), off: simulated(state, false, now) };
  const current = enabled ? sims.on : sims.off;
  const courses = (state.courses || []).filter((course) => isDate(course?.exam?.date) && dayOfDate(course.exam.date) > today && rules.status(course.name).active)
    .map((course) => ({ name: course.name, date: course.exam.date, pending: current.byCourse.get(course.name) || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const before = dueCounts(state.decks, today, counts);
  const dates = before.map((_, at) => localDate(today + at));
  const switched = (sim) => {
    const after = dueCounts(sim.decks, today, counts);
    return dates.map((date, at) => ({ date, before: before[at], after: after[at] }));
  };
  return { enabled, courses, pending: current.moved.pulled, restorable: current.moved.restored, days: dates.map((date, at) => ({ date, before: before[at] })),
    on: switched(sims.on), off: switched(sims.off) };
}
