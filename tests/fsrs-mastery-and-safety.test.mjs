/* FSRS-6 (lib/sm2.js) after the gate review: what 熟悉 / 已掌握 mean does not depend on the scheduler settings (M1), a
   library with a broken setting or a broken stored review still opens, reveals and reads (L1, corrupt data), the gaps the
   buttons show refresh with the poll and match what the answer writes (L2), a legacy review without a due date keeps its
   streak (L4), and the review FSRS writes still schedules under the 3.7.2 SM-2 code after a downgrade. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedule, initialReview, defaults } from "../lib/domain.js";
import { nextIntervals, memoryState } from "../lib/sm2.js";
import { cardLevel, deckProgress } from "../lib/mastery.js";
import { summarizeLinked } from "../lib/material-summary.js";
import { mergeReviewPoll } from "../ui/async.js";
import { StudyService } from "../lib/service.js";
import { Store } from "../lib/store.js";

const DAY = 864e5;
const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const at = (days, hours = 0) => new Date(T0 + days * DAY + hours * 3600e3).toISOString();

/** `answers` grade-4 answers, each on its due day; the review and the level after each. */
function onTime(settings, answers, grade = 4) {
  let review = initialReview(), when = T0;
  const steps = [];
  for (let n = 0; n < answers; n++) {
    review = schedule(review, grade, new Date(when).toISOString(), settings);
    steps.push({ review, level: cardLevel({ review }, grade) });
    when = Date.parse(review.due_at);
  }
  return steps;
}

for (const request_retention of [0.7, 0.8, 0.9, 0.97]) for (const maximum_interval of [15, 36500]) {
  test(`mastery at target recall ${request_retention}, maximum ${maximum_interval}: never after one answer, reachable, and the deck and its pages get there`, () => {
    const settings = { request_retention, maximum_interval };
    const steps = onTime(settings, 12);
    assert.notEqual(steps[0].level, "mastered", `one 熟练 answer is not 已掌握 (gap ${steps[0].review.interval_days})`);
    assert.notEqual(onTime(settings, 1, 3)[0].level, "mastered");
    const first = steps.findIndex((step) => step.level === "mastered");
    assert.ok(first >= 1, `已掌握 is reached (gaps ${steps.map((step) => step.review.interval_days).join(",")})`);
    assert.ok(first <= 8, `and within a believable number of answers: ${first + 1}`);
    for (const step of steps.slice(first)) assert.equal(step.level, "mastered", "and it stays");
    assert.ok(steps.every((step) => step.review.interval_days <= maximum_interval));
    // The deck reaches "done" and a page whose questions are these reaches 已掌握.
    const review = steps[first].review;
    const deck = { id: "d", cards: ["a", "b", "c"].map((id) => ({ id, topic: "T", review })) };
    const progress = deckProgress(deck, () => 4, T0);
    assert.equal(progress.status, "done");
    assert.equal(progress.mastery, 100);
    assert.equal(summarizeLinked(deck.cards.map((card) => ({ level: cardLevel(card, 4) }))).state, "mastered");
  });
}

test("熟悉 and 已掌握 thresholds follow a small maximum, and 已掌握 needs two right answers in a row", () => {
  const capped = (interval, repetitions, maximum) => cardLevel({ review: { repetitions, interval_days: interval, ease_factor: 2.5, due_at: at(interval), maximum_interval: maximum } }, 4);
  assert.equal(capped(5, 1, 5), "familiar", "with a 5-day maximum, 5 days is 熟悉");
  assert.equal(capped(5, 1, 30), "learning");
  assert.equal(capped(15, 2, 15), "mastered", "with a 15-day maximum, two right answers at 15 days is 已掌握");
  assert.equal(capped(15, 1, 15), "familiar", "one answer is never 已掌握");
  assert.equal(capped(30, 1, 36500), "familiar", "one answer is never 已掌握, whatever its gap");
  assert.equal(capped(21, 2, undefined), "mastered");
  // Kept as before: 轻松掌握 (a self-graded 5) is the learner's own call.
  assert.equal(cardLevel({ review: schedule(initialReview(), 5, at(0)) }, 5), "mastered");
  // An SM-2 review written before the upgrade reads as it did (its 21+ days always came with 3+ right answers).
  assert.equal(cardLevel({ review: { repetitions: 4, interval_days: 38, ease_factor: 2.5, due_at: at(38) } }), "mastered");
  // The maximum a review was scheduled under is kept on it only when it is smaller than the default.
  assert.equal(schedule(initialReview(), 4, at(0), { maximum_interval: 15 }).maximum_interval, 15);
  assert.equal("maximum_interval" in schedule(initialReview(), 4, at(0)), false);
});

test("a stored review that is broken still reads and schedules", () => {
  const broken = [null, undefined, "x", [], {}, { stability: "x", difficulty: 5 }, { stability: 1e9, difficulty: 50, last_review: "not a date", repetitions: 3 },
    { stability: -1, difficulty: -1 }, { interval_days: -3, due_at: at(0) }, { interval_days: "7", due_at: at(7), ease_factor: "high" },
    { repetitions: 2, interval_days: 6, ease_factor: 0, due_at: "garbage" }, { repetitions: NaN, interval_days: Infinity, due_at: at(0) }];
  for (const review of broken) {
    const where = JSON.stringify(review);
    assert.doesNotThrow(() => cardLevel({ review }), where);
    const gaps = nextIntervals(review, at(3));
    assert.ok(gaps.every((gap) => Number.isInteger(gap) && gap >= 1), `${where}: ${gaps}`);
    const after = schedule(review, 4, at(3));
    for (const key of ["stability", "difficulty", "interval_days", "ease_factor", "repetitions"]) assert.ok(Number.isFinite(after[key]), `${where}: ${key}`);
    assert.ok(Number.isFinite(Date.parse(after.due_at)), where);
  }
});

test("L4: a legacy review with an interval but no usable due date keeps its streak and interval", () => {
  for (const due_at of [null, undefined, "not a date"]) {
    const review = { repetitions: 3, interval_days: 12, ease_factor: 2.5, due_at };
    const now = Date.parse(at(5));
    const state = memoryState(review, now);
    assert.equal(state.isNew, false, String(due_at));
    assert.equal(state.stability, 12);
    assert.equal(state.lastReview, now - 12 * DAY, "treated as due now");
    const after = schedule(review, 4, at(5));
    assert.equal(after.repetitions, 4);
    assert.ok(after.interval_days > 12, `${after.interval_days}`);
    assert.deepEqual(nextIntervals(review, at(5)), nextIntervals({ ...review, due_at: at(5) }, at(5)));
  }
});

/* 3.7.2's SM-2 schedule, verbatim, as an older build would run it on a review FSRS wrote. */
const sm2Defaults = { minimum_ease_factor: 1.3, initial_ease_factor: 2.5, first_interval_days: 1, second_interval_days: 6 };
function sm2Schedule(before, grade, timestamp, c = sm2Defaults) {
  const ease_factor = Math.round(Math.max(c.minimum_ease_factor, before.ease_factor + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)) * 100) / 100;
  const interval_days = grade < 3 ? 1 : before.repetitions === 0 ? c.first_interval_days : before.repetitions === 1 ? c.second_interval_days
    : Math.max(1, Math.round(before.interval_days * ease_factor));
  const due = new Date(timestamp);
  due.setUTCDate(due.getUTCDate() + interval_days);
  return { repetitions: grade < 3 ? 0 : before.repetitions + 1, interval_days, ease_factor, due_at: due.toISOString() };
}

test("after a downgrade, the 3.7.2 SM-2 code keeps scheduling a review FSRS wrote", () => {
  let review = initialReview();
  for (const [day, grade] of [[0, 4], [3, 3], [5, 5], [20, 1], [21, 4]]) {
    review = schedule(review, grade, at(day));
    for (const sm2Grade of [0, 3, 4, 5]) {
      const old = sm2Schedule(review, sm2Grade, at(day + review.interval_days));
      assert.ok(Number.isInteger(old.interval_days) && old.interval_days >= 1 && old.interval_days < 5000, JSON.stringify(old));
      assert.ok(old.ease_factor >= 1.3 && old.ease_factor <= 3.6, JSON.stringify(old));
      assert.equal(old.repetitions, sm2Grade < 3 ? 0 : review.repetitions + 1);
      assert.ok(Number.isFinite(Date.parse(old.due_at)));
      // And back on this build, the SM-2 answer is read and migrated again.
      assert.ok(schedule(old, 4, old.due_at).interval_days >= 1);
    }
  }
});

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), "study-fsrs-gate-"));
  const service = new StudyService(root);
  t.after(async () => { service.dispose?.(); await rm(root, { recursive: true, force: true }); });
  await service.call("source.add", { id: "s1", title: "Notes", text: "Active recall strengthens memory by retrieving a fact before seeing its explanation." });
  const draft = await service.call("draft.save", { deck: { id: "d1", title: "Recall", cards: [{ id: "c1", kind: "flashcard", topic: "Recall",
    objective: "Explain why retrieving a fact helps memory", prompt: "How does retrieving a fact help memory?", answer: "It strengthens memory.",
    hint: "Retrieval.", explanation: "Active recall strengthens memory.", misconception: "Rereading equals retrieving.",
    citations: [{ sourceId: "s1", quote: "Active recall strengthens memory by retrieving a fact before seeing its explanation." }] }] } });
  await service.call("draft.publish", { id: draft.id });
  return { root, service };
}

test("L1: a broken scheduling setting restored from a backup shows no gaps but still reveals; answering still refuses it", async (t) => {
  const { service } = await library(t);
  const backup = await service.call("export");
  await service.call("restore", { state: { ...backup, settings: { ...backup.settings, request_retention: 0.5 } } });
  assert.equal((await service.call("snapshot")).settings.request_retention, 0.5, "the stored value is read as it is");
  const run = await service.call("review.start", { deckId: "d1", mode: "flashcard" });
  const revealed = await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
  assert.equal(revealed.revealed, true);
  assert.equal(revealed.intervals, null, "no gaps under the buttons");
  assert.equal((await service.call("review.get", { runId: run.id })).intervals, null);
  await assert.rejects(service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 4 }), /request_retention/);
});

test("L1: a broken stored review still reveals with gaps and answers", async (t) => {
  const { root, service } = await library(t);
  await new Store(root).update((s) => { s.decks[0].cards[0].review = { stability: "x", difficulty: 99, interval_days: "?", due_at: "garbage", repetitions: -2 }; });
  const run = await service.call("review.start", { deckId: "d1", mode: "flashcard", scope: [{ deckId: "d1", cardId: "c1" }] });
  const revealed = await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
  assert.deepEqual(revealed.intervals, [1, 1, 1, 2, 3, 8], "read as a new question");
  const answered = await service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 4 });
  assert.ok(Number.isFinite(Date.parse(answered.feedback.nextDue)));
});

test("L2: the gaps refresh with the poll, and the answer gets the gap the buttons show at that moment", async (t) => {
  // Same local day between reveal and answer: the gap shown is the gap written.
  const { root, service } = await library(t);
  const last = Date.now() - 3 * DAY;
  await new Store(root).update((s) => { s.decks[0].cards[0].review = schedule(initialReview(), 4, new Date(last).toISOString()); });
  const run = await service.call("review.start", { deckId: "d1", mode: "flashcard", scope: [{ deckId: "d1", cardId: "c1" }] });
  const revealed = await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
  const answeredAt = Date.now();
  const answered = await service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 4 });
  assert.ok(Math.abs((Date.parse(answered.feedback.nextDue) - answeredAt) / DAY - revealed.intervals[4]) < 0.01);
  // Across midnight the gaps change; the poll carries them to the page (ui/async.js mergeReviewPoll).
  const review = schedule(initialReview(), 4, at(0, 2));
  const before = nextIntervals(review, at(2, 13)), after = nextIntervals(review, at(3, 13));
  assert.notDeepEqual(before, after, "a day later the same answer gives other gaps");
  const page = { id: "r", index: 0, revealed: true, feedback: null, card: { id: "c1" }, intervals: before };
  assert.deepEqual(mergeReviewPoll(page, { ...page, intervals: after }).intervals, after);
  assert.equal(schedule(review, 4, at(3, 13)).interval_days, after[4], "and the answer writes what the refreshed buttons say");
});

test("defaults are unchanged by the gate fixes", () => {
  assert.deepEqual({ ...defaults }, { request_retention: 0.9, maximum_interval: 36500 });
});
