/* #882 review B2: an answer the night before a daylight-saving change still comes back on the exam day, never after it. The
   time zone is fixed for this file (New York springs forward on 8 March 2026: that day has 23 hours, so "now + 1 day of
   milliseconds" from 23:30 on the 7th is 00:30 on the 9th). */
process.env.TZ = "America/New_York";
import test from "node:test";
import assert from "node:assert/strict";
import { schedule, initialReview } from "../lib/sm2.js";
import { alignDueDates } from "../lib/exam-alignment.js";

const EXAM_DATE = "2026-03-08";
const examStart = new Date(2026, 2, 8).getTime();
const settings = { request_retention: 0.9, maximum_interval: 36500, exam_date: EXAM_DATE };

test("the zone is the one this file is about", () => {
  assert.equal(new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime(), 23 * 3600e3, "8 March 2026 has 23 hours in New York");
});

test("answered at 23:30 the night before the spring-forward exam day: due by local 00:00 of the exam day, for every grade", () => {
  const young = schedule(initialReview(), 4, new Date(2026, 2, 6, 23, 30).toISOString());
  const stable = schedule(schedule(schedule(initialReview(), 4, new Date(2026, 0, 2, 9).toISOString()), 4, new Date(2026, 0, 9, 9).toISOString()), 4, new Date(2026, 1, 1, 9).toISOString());
  for (const before of [young, stable]) {
    for (const grade of [0, 2, 3, 4, 5]) {
      const review = schedule(before, grade, new Date(2026, 2, 7, 23, 30).toISOString(), settings);
      assert.ok(Date.parse(review.due_at) <= examStart, `grade ${grade}: due ${new Date(review.due_at).toString()}`);
      if (review.interval_days >= 1) assert.equal(Date.parse(review.due_at), examStart);
    }
  }
});

test("a question brought forward in the week of the change lands on a local midnight before the exam", () => {
  const due = new Date(2026, 3, 20, 9).toISOString();
  const state = {
    settings: { request_retention: 0.9, maximum_interval: 36500 },
    courses: [{ id: "os", name: "OS", exam: { format: "closed-book", date: EXAM_DATE }, focusTopics: [] }],
    decks: [{ id: "os", title: "OS", course: "OS", cards: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, kind: "flashcard", topic: `t${i}`, prompt: "?", answer: "a",
      review: { ...schedule(initialReview(), 4, new Date(2026, 1, 20 + i, 9).toISOString()), due_at: due } })) }],
  };
  const { pulled } = alignDueDates(state, new Date(2026, 2, 5, 22).getTime());
  assert.equal(pulled, 6);
  for (const card of state.decks[0].cards) {
    const d = new Date(card.review.due_at);
    assert.equal(d.getHours() + d.getMinutes(), 0, `local midnight: ${d.toString()}`);
    assert.ok(d.getTime() < examStart);
  }
});
