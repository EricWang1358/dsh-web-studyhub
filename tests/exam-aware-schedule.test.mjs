/* #882 step 2: with a course exam ahead, an answer never schedules its question past the exam day. The review keeps the gap
   FSRS gave (`interval_days`, what mastery reads) and the due date FSRS gave (`unaligned_due_at`); only `due_at` moves.
   Times are built on the local calendar, so the tests hold in any time zone. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedule, nextIntervals, initialReview, checkSettings } from "../lib/sm2.js";
import { cardScheduleSettings } from "../lib/card-schedule.js";
import { cardLevel } from "../lib/mastery.js";
import { StudyService } from "../lib/service.js";

const BASE = new Date(2026, 9, 1, 9, 30); // 1 Oct 2026, 09:30 local
/** An instant `days` local days after BASE at hh:mm, as ISO. */
const at = (days, hh = 9, mm = 30) => new Date(BASE.getFullYear(), BASE.getMonth(), BASE.getDate() + days, hh, mm).toISOString();
/** The local calendar date `days` after BASE, YYYY-MM-DD. */
const dateOf = (days) => {
  const d = new Date(BASE.getFullYear(), BASE.getMonth(), BASE.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Whole local days from BASE's day to an instant's day. */
const dayOf = (iso) => {
  const d = new Date(iso);
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(BASE.getFullYear(), BASE.getMonth(), BASE.getDate())) / 864e5);
};
const EXAM = 30;
const plain = { request_retention: 0.9, maximum_interval: 36500 };
const withExam = { ...plain, exam_date: dateOf(EXAM) };
/** Everything on a review except the two fields the exam may change. */
const memory = ({ due_at: _due, unaligned_due_at: _unaligned, ...rest }) => rest;

test("(a) the exam moves only the due date: memory state, streak, gap and mastery are the same with it on and off", () => {
  const history = [[0, 4], [3, 4], [9, 4], [20, 4], [24, 2], [26, 5], [28, 4], [29, 3]];
  for (const maximum of [36500, 10]) {
    let on = initialReview(), off = initialReview(), capped = 0;
    for (const [day, grade] of history) {
      on = schedule(on, grade, at(day), { ...withExam, maximum_interval: maximum });
      off = schedule(off, grade, at(day), { ...plain, maximum_interval: maximum });
      assert.deepEqual(memory(on), memory(off), `day ${day} grade ${grade} maximum ${maximum}`);
      assert.equal(cardLevel({ review: on }, grade), cardLevel({ review: off }, grade));
      if (on.unaligned_due_at) {
        capped++;
        assert.equal(on.unaligned_due_at, off.due_at, "the due date FSRS gave is kept");
        assert.ok(Date.parse(on.due_at) < Date.parse(off.due_at));
      } else assert.equal(on.due_at, off.due_at);
    }
    if (maximum === 36500) assert.ok(capped >= 3, `the history crosses the exam several times (${capped})`);
  }
});

test("(a) a question capped before the exam still reaches 已掌握 on the gap FSRS gave, and the exam never lowers the line", () => {
  // Stable for weeks: FSRS gives far more than 21 days, the exam is 5 days off.
  let review = initialReview();
  for (const [day, grade] of [[-60, 4], [-50, 4], [-30, 4], [25, 4]]) review = schedule(review, grade, at(day), withExam);
  assert.ok(review.interval_days >= 21, `FSRS gap ${review.interval_days}`);
  assert.equal(dayOf(review.due_at), EXAM, "back on the exam day");
  assert.equal(cardLevel({ review }, 4), "mastered");
  assert.equal(review.maximum_interval, undefined, "the exam is not written as a maximum interval");
});

test("(b) an answer on any day before the exam is due on or before the exam day; one on the exam day falls after it", () => {
  const stable = schedule(schedule(schedule(initialReview(), 4, at(-40)), 4, at(-35)), 4, at(-20));
  for (let day = 0; day <= EXAM; day++) {
    for (const grade of [0, 2, 3, 4, 5]) {
      const review = schedule(stable, grade, at(day, 23, 50), withExam);
      const buttons = nextIntervals(stable, at(day, 23, 50), withExam);
      if (day < EXAM) {
        assert.ok(dayOf(review.due_at) <= EXAM, `answered day ${day} grade ${grade}: due day ${dayOf(review.due_at)}`);
        assert.ok(buttons[grade] <= EXAM - day, "the button promises the capped gap");
        assert.equal(dayOf(review.due_at) - day, buttons[grade], "the button says when it comes back");
      } else {
        assert.ok(dayOf(review.due_at) > EXAM, "on the exam day itself there is no earlier day left");
        assert.equal(review.unaligned_due_at, undefined);
      }
    }
  }
});

test("(c) after the exam day the scheduling is the ordinary one, with nothing extra on the review", () => {
  const stable = schedule(schedule(initialReview(), 4, at(-10)), 4, at(-5));
  for (const day of [EXAM, EXAM + 1, EXAM + 40]) {
    for (const grade of [1, 3, 4, 5]) {
      assert.deepEqual(schedule(stable, grade, at(day), withExam), schedule(stable, grade, at(day), plain), `day ${day} grade ${grade}`);
      assert.deepEqual(nextIntervals(stable, at(day), withExam), nextIntervals(stable, at(day), plain));
    }
  }
});

test("a learner's maximum interval keeps working as before, exam or not", () => {
  const stable = schedule(schedule(initialReview(), 4, at(-10)), 4, at(-5));
  const review = schedule(stable, 4, at(0), { ...withExam, maximum_interval: 4 });
  assert.equal(review.maximum_interval, 4);
  assert.equal(review.interval_days, 4);
  assert.equal(review.unaligned_due_at, undefined, "the maximum came first: nothing for the exam to move");
});

test("cardScheduleSettings carries the course's exam date, a chapter takes its course's, and the switch or a system deck leave it out", () => {
  const state = {
    settings: { request_retention: 0.9, maximum_interval: 36500, exam_date: "2000-01-01" },
    courses: [
      { id: "os", name: "OS", exam: { format: "closed-book", date: dateOf(EXAM) }, focusTopics: [] },
      { id: "net", name: "Networks", focusTopics: [] },
      { id: "os3", name: "OS / Ch 3", focusTopics: [] },
    ],
  };
  const card = { id: "c", topic: "t" };
  assert.equal(cardScheduleSettings(state, { course: "OS" }, card).settings.exam_date, dateOf(EXAM));
  assert.equal(cardScheduleSettings(state, { course: "OS / Ch 3" }, card).settings.exam_date, dateOf(EXAM), "a chapter has its course's exam");
  assert.equal(cardScheduleSettings(state, { course: "Networks" }, card).settings.exam_date, undefined, "no exam date: nothing, not a stray library key");
  assert.equal(cardScheduleSettings(state, { systemKind: "wrongbook" }, card).settings.exam_date, undefined);
  const off = { ...state, settings: { ...state.settings, exam_alignment: false } };
  assert.equal(cardScheduleSettings(off, { course: "OS" }, card).settings.exam_date, undefined, "alignment switched off");
  const chapterOwn = { ...state, courses: [...state.courses.slice(0, 2), { id: "os3", name: "OS / Ch 3", exam: { format: "closed-book", date: dateOf(10) }, focusTopics: [] }] };
  assert.equal(cardScheduleSettings(chapterOwn, { course: "OS / Ch 3" }, card).settings.exam_date, dateOf(10), "a chapter's own exam date wins");
});

test("the alignment switch is a yes/no library setting", () => {
  assert.equal(checkSettings({ exam_alignment: false }).exam_alignment, false);
  assert.throws(() => checkSettings({ exam_alignment: "no" }), /exam_alignment/);
});

test("a practice answer in a course with an exam ahead comes back by the exam, and its level is what it would be without the exam", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-aware-"));
  const study = new StudyService(root);
  t.after(async () => { study.dispose?.(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const now = new Date();
  const local = (days) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
  // Stable for weeks and due today: a right answer now gets far more than the 6 days left before the exam.
  const seeded = schedule(schedule(schedule(initialReview(), 4, ago(70)), 4, ago(60)), 4, ago(40));
  const options = [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }];
  const quiz = (id) => ({ id, kind: "quiz", topic: id, prompt: `${id}?`, answer: "A", explanation: "A.", citations: [], options, review: { ...structuredClone(seeded), due_at: ago(1) } });
  await study.call("course.save", { name: "OS", exam: { format: "closed-book", date: local(6) } });
  await study.store.update((s) => { s.decks.push({ id: "os", title: "OS", course: "OS", cards: [quiz("q1"), quiz("q2")] }); });

  let run = await study.call("review.start", { mode: "path", scope: [{ deckId: "os", cardId: "q1" }], fresh: true });
  run = await study.call("review.answer", { runId: run.id, cardId: "q1", selected: ["a"] });
  const due = new Date(run.feedback.nextDue);
  assert.equal(`${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`, local(6), "back on the exam day");
  const state = await study.call("export");
  const answered = state.decks[0].cards.find((card) => card.id === "q1").review;
  assert.ok(answered.interval_days > 6, `FSRS gap ${answered.interval_days} is kept`);
  assert.ok(answered.unaligned_due_at);
  assert.equal(run.feedback.level, cardLevel({ review: { ...answered, due_at: answered.unaligned_due_at } }, 4));
  assert.equal(run.feedbackTelemetry.examAligned, true, "the line under the answer can say the exam brought it back");

  await study.call("course.examAlignment.set", { enabled: false });
  let second = await study.call("review.start", { mode: "path", scope: [{ deckId: "os", cardId: "q2" }], fresh: true });
  second = await study.call("review.answer", { runId: second.id, cardId: "q2", selected: ["a"] });
  const after = (await study.call("export")).decks[0].cards.find((card) => card.id === "q2").review;
  assert.equal(after.unaligned_due_at, undefined, "switched off: the ordinary schedule");
  assert.equal(after.interval_days, answered.interval_days);
  assert.equal(second.feedback.level, run.feedback.level);
  assert.equal(second.feedbackTelemetry.examAligned, undefined);
});

test("the line under an answer says the exam brought the question back, in both languages", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { loadUi } = await import("./helpers/ui-module.mjs");
  const m = await loadUi(`
    export { NextDue } from './ui/NextDue.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const now = Date.parse("2026-11-05T12:00:00Z");
  const feedback = { correct: true, level: "familiar", nextDue: new Date(now + 5 * 864e5).toISOString(), beforeLevel: "familiar", beforeDays: 9, afterDays: 24, stability: 20, examAligned: true };
  const html = renderToStaticMarkup(React.createElement(m.NextDue, { feedback, now }));
  assert.match(html, /下次大约 5 天后再见/);
  assert.match(html, /考试前先回来一次/);
  assert.match(html, /考前对齐/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(m.NextDue, { feedback: { ...feedback, examAligned: undefined }, now })), /考试前先回来一次/);
  m.setUiLanguage("en");
  try {
    const english = renderToStaticMarkup(React.createElement(m.NextDue, { feedback, now }));
    assert.doesNotMatch(english, /[㐀-鿿]/, "every word has its English");
  } finally { m.setUiLanguage("zh"); }
});
