/* M2: FSRS-6 (lib/sm2.js) counts the days since the last review on the learner's own calendar (the local time zone of the
   machine StudyHub runs on), not on UTC's: in Beijing, 07:50 and 08:10 are the same day, 23:00 and 07:00 the next morning
   are two. The time zone is fixed for this file. */
process.env.TZ = "Asia/Shanghai";
import test from "node:test";
import assert from "node:assert/strict";
import { schedule, initialReview } from "../lib/domain.js";
import { nextIntervals } from "../lib/sm2.js";

const local = (text) => Date.parse(`${text}+08:00`);
const iso = (text) => new Date(local(text)).toISOString();

test("the time zone is the one this file fixes", () => {
  assert.equal(new Date(local("2026-10-01T12:00:00")).getTimezoneOffset(), -480);
});

test("07:50 and 08:10 in Beijing are one day: answering again does not stretch the gap", () => {
  const first = schedule(initialReview(), 4, iso("2026-10-01T07:50:00"));
  assert.equal(first.interval_days, 3);
  const again = schedule(first, 4, iso("2026-10-01T08:10:00"));
  assert.equal(again.elapsed_days, 0);
  assert.equal(again.interval_days, 3, "UTC would have counted a new day here (00:00 UTC is 08:00 in Beijing) and given 7");
  assert.deepEqual(nextIntervals(first, iso("2026-10-01T08:10:00")), nextIntervals(first, iso("2026-10-01T23:59:00")));
});

test("23:00 and 07:00 the next morning in Beijing are two days", () => {
  const first = schedule(initialReview(), 4, iso("2026-10-01T23:00:00"));
  const next = schedule(first, 4, iso("2026-10-02T07:00:00"));
  assert.equal(next.elapsed_days, 1, "UTC would have called both 2026-10-01 and counted 0");
  assert.equal(next.interval_days, 7);
  const sameDay = schedule(first, 4, iso("2026-10-01T23:30:00"));
  assert.equal(sameDay.elapsed_days, 0);
  assert.equal(sameDay.interval_days, 3);
});

test("an SM-2 review migrates with its last answer on the local calendar too", () => {
  // Answered 2026-10-01 07:50 Beijing (2026-09-30 UTC) with a 6-day interval; reviewed 6 local days later at 07:30.
  const review = { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: new Date(local("2026-10-01T07:50:00") + 6 * 864e5).toISOString() };
  assert.equal(schedule(review, 4, iso("2026-10-07T07:30:00")).elapsed_days, 6);
});
