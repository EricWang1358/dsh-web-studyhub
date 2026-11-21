/* Stage 1a: Same-day multi-review FSRS-6 guardrails, cross-day spaced_reps, no-regression
   protection, Again->Good/Easy bounded recovery, same-day lapse cap, and scoped queue ordering. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FSRS6_WEIGHTS,
  initialReview,
  isPassedToday,
  nextIntervals,
  retrievability,
  schedule,
  spacedRepsOf,
} from "../lib/sm2.js";
import { balanceCardReview } from "../lib/card-schedule.js";
import { cardLevel, planPath } from "../lib/mastery.js";
import { StudyService } from "../lib/service.js";
import { Store } from "../lib/store.js";

const DAY = 864e5;
const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const at = (days, hours = 0) => new Date(T0 + days * DAY + hours * 3600e3).toISOString();

test("1. 5x same-day Good(4): stability/difficulty/interval/due stay stable, spaced_reps stays 1 while reps counts every review", () => {
  process.env.TZ = "UTC";
  const first = schedule(initialReview(), 4, at(0, 0));
  assert.equal(first.spaced_reps, 1);
  assert.equal(first.repetitions, 1);
  assert.equal(first.reps, 1);
  assert.equal(first.interval_days, 3);
  assert.equal(isPassedToday(first, at(0, 1)), true);

  let cur = first;
  for (let i = 1; i <= 5; i++) {
    const ts = at(0, i);
    const buttons = nextIntervals(cur, ts);
    cur = schedule(cur, 4, ts);
    assert.equal(cur.elapsed_days, 0);
    assert.equal(cur.stability, first.stability, `repeat ${i}: stability must stay stable`);
    assert.equal(cur.difficulty, first.difficulty, `repeat ${i}: difficulty must not drift`);
    assert.equal(cur.interval_days, first.interval_days, `repeat ${i}: interval stays 3d`);
    assert.equal(buttons[4], cur.interval_days, `repeat ${i}: button hint matches schedule`);
    assert.ok(Date.parse(cur.due_at) >= Date.parse(first.due_at), `repeat ${i}: due_at never moves earlier`);
    assert.equal(cur.spaced_reps, 1, `repeat ${i}: spaced_reps capped at +1 per calendar day`);
    assert.equal(cur.repetitions, 1, `repeat ${i}: repetitions does not artificially inflate on same-day repeats`);
    assert.equal(cur.reps, i + 1, `repeat ${i}: total reps counts every review`);
    assert.equal(cardLevel({ review: cur }, 4), "learning");
  }
});

test("2. 5x same-day Hard(3): default isolate_same_day prevents Difficulty Hell (zero difficulty drift)", () => {
  process.env.TZ = "UTC";
  const first = schedule(initialReview(), 3, at(0, 0));
  assert.equal(first.spaced_reps, 1);
  assert.equal(first.repetitions, 1);
  let cur = first;
  for (let i = 1; i <= 5; i++) {
    const ts = at(0, i);
    const buttons = nextIntervals(cur, ts);
    cur = schedule(cur, 3, ts);
    assert.equal(cur.elapsed_days, 0);
    assert.equal(cur.difficulty, first.difficulty, `Hard repeat ${i}: difficulty must stay flat (${cur.difficulty})`);
    assert.equal(cur.stability, first.stability, `Hard repeat ${i}: stability stays intact`);
    assert.equal(cur.interval_days, first.interval_days, `Hard repeat ${i}: interval does not shrink`);
    assert.equal(buttons[3], cur.interval_days, `Hard repeat ${i}: button hint matches`);
    assert.equal(cur.spaced_reps, 1);
    assert.equal(cur.repetitions, 1);
  }

  // Explicit isolate_same_day: false still allows opting out to raw ts-fsrs behavior.
  let raw = schedule(initialReview(), 3, at(0, 0), { isolate_same_day: false });
  for (let i = 1; i <= 5; i++) {
    raw = schedule(raw, 3, at(0, i), { isolate_same_day: false });
  }
  assert.ok(raw.difficulty > first.difficulty + 1.5, "explicit isolate_same_day:false reproduces raw ts-fsrs drift");
  assert.equal(raw.spaced_reps, 1, "spaced_reps stays honest even with isolate_same_day:false");
});

test("3. Same-day Again(1) -> Good(4) / Easy(5): bounded short-term stability recovery + next-day (1-2d) verification", () => {
  process.env.TZ = "UTC";
  // 3a. New card: Again(1) -> same-day Good(4) -> same-day Good(4) -> Day 1 Good(4)
  const failed = schedule(initialReview(), 1, at(0, 0));
  assert.ok(failed.stability < 0.3, `initial Again stability is ~0.21 (${failed.stability})`);
  assert.equal(failed.lapses, 0);
  assert.equal(failed.spaced_reps, 0);
  assert.equal(isPassedToday(failed, at(0, 1)), false);

  const buttonsAfterFail = nextIntervals(failed, at(0, 1));
  assert.deepEqual(buttonsAfterFail, [1, 1, 1, 1, 1, 2], "recovery buttons match 1-2d verification schedule");

  const recovered = schedule(failed, 4, at(0, 1));
  assert.equal(recovered.elapsed_days, 0);
  assert.ok(
    recovered.stability >= FSRS6_WEIGHTS[2] * 0.6 && recovered.stability <= FSRS6_WEIGHTS[2] * 0.75,
    `recovered stability should be ~60-75% of initial Good stability (${recovered.stability})`,
  );
  assert.equal(recovered.interval_days, 1, "Good recovery schedules next-day (1d) verification");
  assert.equal(recovered.difficulty, failed.difficulty, "same-day recovery does not drift difficulty");
  assert.equal(recovered.spaced_reps, 1);
  assert.equal(recovered.repetitions, 1);
  assert.equal(cardLevel({ review: recovered }, 4), "learning");

  // Repeating Good(4) again later the same day must keep the 1-day verification (not jump to 3d).
  const repeatSameDay = schedule(recovered, 4, at(0, 2));
  assert.equal(repeatSameDay.stability, recovered.stability);
  assert.equal(repeatSameDay.interval_days, 1);
  assert.equal(repeatSameDay.spaced_reps, 1);

  // Next day (Day 1) cross-day pass: healthy retrievability (>90%) and strong interval growth!
  const nextDayRecall = retrievability(repeatSameDay, at(1, 0));
  assert.ok(nextDayRecall > 0.9, `next-day recall should be healthy (${nextDayRecall})`);
  const nextDayPass = schedule(repeatSameDay, 4, at(1, 0));
  assert.equal(nextDayPass.elapsed_days, 1);
  assert.ok(nextDayPass.interval_days >= 4, `next cross-day pass grows interval cleanly (${nextDayPass.interval_days})`);
  assert.ok(nextDayPass.stability > recovered.stability * 2);
  assert.equal(nextDayPass.spaced_reps, 2);

  // 3b. New card: Again(1) -> same-day Easy(5) schedules 2d verification with bounded recovery.
  const recoveredEasy = schedule(failed, 5, at(0, 1));
  assert.ok(
    recoveredEasy.stability > recovered.stability && recoveredEasy.stability <= FSRS6_WEIGHTS[2] * 0.8,
    `Easy recovery stays bounded (${recoveredEasy.stability})`,
  );
  assert.equal(recoveredEasy.interval_days, 2);
  assert.equal(recoveredEasy.spaced_reps, 1);

  // 3c. Mature card lapse -> same-day Good(4): never shrinks stability below post-lapse S.
  let mature = initialReview();
  for (const d of [0, 3, 17]) mature = schedule(mature, 4, at(d, 0));
  const lapsed = schedule(mature, 1, at(17 + 57, 0));
  assert.equal(lapsed.lapses, 1);
  assert.ok(lapsed.stability > FSRS6_WEIGHTS[2]);
  const matureRecovered = schedule(lapsed, 4, at(17 + 57, 1));
  assert.equal(matureRecovered.stability, lapsed.stability, "recovery never lowers already-higher post-lapse stability");
  assert.equal(matureRecovered.interval_days, 1);
  assert.equal(matureRecovered.lapses, 1);
  assert.equal(matureRecovered.spaced_reps, 1);
});

test("4. No-regression guard on same-day passing reviews: Easy(5) -> Good(4)/Hard(3) stays mastered and preserves due_at", () => {
  process.env.TZ = "UTC";
  const easy = schedule(initialReview(), 5, at(0, 0));
  assert.equal(easy.interval_days, 8);
  assert.equal(easy.last_grade, 5);
  assert.equal(cardLevel({ review: easy }, 5), "mastered");

  // Same-day Good(4) after Easy(5) must NOT drop from mastered to familiar or reduce S/interval/due_at.
  const afterGood = schedule(easy, 4, at(0, 1));
  assert.equal(afterGood.stability, easy.stability);
  assert.equal(afterGood.difficulty, easy.difficulty);
  assert.equal(afterGood.interval_days, easy.interval_days);
  assert.ok(Date.parse(afterGood.due_at) >= Date.parse(easy.due_at));
  assert.equal(afterGood.last_grade, 5);
  assert.equal(cardLevel({ review: afterGood }, 4), "mastered", "Easy(5) -> same-day Good(4) stays mastered");

  // Same-day Hard(3) after Easy(5) -> Good(4) also must NOT regress.
  const afterHard = schedule(afterGood, 3, at(0, 2));
  assert.equal(afterHard.stability, easy.stability);
  assert.equal(afterHard.interval_days, easy.interval_days);
  assert.ok(Date.parse(afterHard.due_at) >= Date.parse(afterGood.due_at));
  assert.equal(afterHard.last_grade, 5);
  assert.equal(cardLevel({ review: afterHard }, 3), "mastered", "Easy(5) -> same-day Hard(3) stays mastered");

  // If due_at was previously shifted later (e.g. by load balancing), a same-day pass never pulls it backward.
  const shiftedLater = { ...easy, due_at: at(10, 0) };
  const afterShiftPass = schedule(shiftedLater, 4, at(0, 2));
  assert.equal(afterShiftPass.due_at, at(10, 0), "same-day pass preserves a later due_at");

  // balanceCardReview also never pulls due_at earlier on a same-day repeat pass.
  const deck = { id: "d1", title: "Deck", cards: [{ id: "c1", review: shiftedLater }] };
  const balanced = balanceCardReview(
    { decks: [deck], sources: [], courses: [], settings: { load_balance: true } },
    deck,
    deck.cards[0],
    afterShiftPass,
    { now: Date.parse(at(0, 2)), loadBalance: true },
  );
  assert.ok(Date.parse(balanced.due_at) >= Date.parse(shiftedLater.due_at));

  // A subsequent failure DOES clear Easy(5) mastery properly.
  const failedLater = schedule(afterHard, 1, at(0, 3));
  assert.equal(cardLevel({ review: failedLater }, 1), "weak");
  assert.equal(failedLater.last_grade, 1);
  assert.equal(failedLater.spaced_reps, 0);
  const recoveredAfterFail = schedule(failedLater, 4, at(0, 4));
  assert.equal(cardLevel({ review: recoveredAfterFail }, 4), "learning", "failure clears prior Easy(5) self-mastery");
});

test("5. 3x same-day Again(1): lapses capped to at most 1 per calendar day without crushing S or maxing D", () => {
  process.env.TZ = "UTC";
  // 5a. Mature card fails 3 times on the same day.
  let mature = initialReview();
  for (const d of [0, 3, 17]) mature = schedule(mature, 4, at(d, 0));
  const fail1 = schedule(mature, 1, at(17 + 57, 0));
  assert.equal(fail1.lapses, 1);
  assert.equal(fail1.spaced_reps, 0);
  assert.equal(fail1.repetitions, 0);

  const fail2 = schedule(fail1, 1, at(17 + 57, 1));
  const fail3 = schedule(fail2, 1, at(17 + 57, 2));
  assert.equal(fail2.lapses, 1, "2nd same-day Again does not stack lapses");
  assert.equal(fail3.lapses, 1, "3rd same-day Again stays capped at 1 lapse/day");
  assert.equal(fail3.stability, fail1.stability, "stability is not repeatedly crushed on day 0");
  assert.equal(fail3.difficulty, fail1.difficulty, "difficulty is not repeatedly spiked on day 0");
  assert.equal(fail3.interval_days, 1);

  // Even Fail -> Recover(Good) -> Fail on the same calendar day stays capped at 1 lapse for that day.
  const midRecover = schedule(fail1, 4, at(17 + 57, 3));
  assert.equal(midRecover.spaced_reps, 1);
  const failAgainSameDay = schedule(midRecover, 1, at(17 + 57, 4));
  assert.equal(failAgainSameDay.lapses, 1, "Fail -> Good -> Fail on same day still caps lapses at 1");
  assert.equal(failAgainSameDay.spaced_reps, 0);
  assert.equal(failAgainSameDay.repetitions, 0);

  // Failing on the NEXT calendar day DOES count as a new lapse.
  const nextDayFail = schedule(fail3, 1, at(17 + 58, 0));
  assert.equal(nextDayFail.lapses, 2, "cross-day failure increments lapses normally");

  // 5b. Brand-new card fails 3 times on day 0 -> 0 lapses (never learned yet), S & D not crushed/spiked.
  const n1 = schedule(initialReview(), 1, at(0, 0));
  const n2 = schedule(n1, 1, at(0, 1));
  const n3 = schedule(n2, 1, at(0, 2));
  assert.equal(n1.lapses, 0);
  assert.equal(n3.lapses, 0);
  assert.equal(n3.stability, n1.stability);
  assert.equal(n3.difficulty, n1.difficulty);
});

test("6. Cross-day spaced_reps progression (0 -> 1 -> 2 -> 3), legacy migration, and local calendar days", () => {
  process.env.TZ = "Asia/Shanghai";
  const localIso = (text) => new Date(Date.parse(`${text}+08:00`)).toISOString();

  assert.equal(spacedRepsOf(initialReview()), 0);
  let r = schedule(initialReview(), 4, localIso("2026-10-01T07:50:00"));
  assert.equal(r.spaced_reps, 1);
  // Same local day across 00:00 UTC (08:10 Beijing) stays 1.
  r = schedule(r, 4, localIso("2026-10-01T08:10:00"));
  r = schedule(r, 4, localIso("2026-10-01T23:30:00"));
  assert.equal(r.spaced_reps, 1);
  assert.equal(r.repetitions, 1);

  // Next local morning (07:00 Beijing) increments to 2.
  r = schedule(r, 4, localIso("2026-10-02T07:00:00"));
  assert.equal(r.spaced_reps, 2);
  assert.equal(r.repetitions, 2);
  // Extra same-day drill on Day 2 keeps it at 2.
  r = schedule(r, 4, localIso("2026-10-02T20:00:00"));
  assert.equal(r.spaced_reps, 2);

  // Third distinct calendar day increments to 3.
  r = schedule(r, 4, localIso("2026-10-09T09:00:00"));
  assert.equal(r.spaced_reps, 3);
  assert.equal(r.repetitions, 3);

  // Failure resets spaced_reps to 0.
  r = schedule(r, 1, localIso("2026-10-10T09:00:00"));
  assert.equal(r.spaced_reps, 0);

  // Legacy card without spaced_reps migrates cleanly from repetitions.
  const legacy = {
    repetitions: 2,
    interval_days: 6,
    ease_factor: 2.5,
    due_at: localIso("2026-10-07T09:00:00"),
  };
  assert.equal(spacedRepsOf(legacy), 2);
  const migrated = schedule(legacy, 4, localIso("2026-10-07T09:00:00"));
  assert.equal(migrated.spaced_reps, 3);
  assert.equal(migrated.repetitions, 3);
});

test("7. Scoped deck/topic drills and ahead rounds prioritize cards NOT yet passed today ahead of passed-today cards", () => {
  process.env.TZ = "UTC";
  const now = Date.parse(at(5, 14));
  const passedTodayReview = schedule(initialReview(), 4, at(5, 9)); // last_review today, due Day 8
  const passedYesterdayReview = schedule(initialReview(), 4, at(4, 9)); // last_review yesterday, due Day 7 (not due yet, NOT passed today)
  const dueReview = schedule(initialReview(), 4, at(1, 9)); // due Day 4 (<= Day 5)
  const weakReview = schedule(initialReview(), 1, at(5, 8)); // failed today -> weak

  const deck = {
    id: "d1",
    title: "Algorithms",
    cards: [
      { id: "passed-today-1", topic: "Graphs", review: passedTodayReview },
      { id: "passed-today-2", topic: "Graphs", review: passedTodayReview },
      { id: "unpassed-prev-day-1", topic: "Graphs", review: passedYesterdayReview },
      { id: "unpassed-prev-day-2", topic: "Graphs", review: passedYesterdayReview },
      { id: "due-1", topic: "Graphs", review: dueReview },
      { id: "weak-1", topic: "Graphs", review: weakReview },
      { id: "new-1", topic: "Graphs", review: initialReview() },
    ],
  };
  const grades = {
    "passed-today-1": 4,
    "passed-today-2": 4,
    "unpassed-prev-day-1": 4,
    "unpassed-prev-day-2": 4,
    "due-1": 4,
    "weak-1": 1,
  };
  const outcome = (_deckId, cardId) => grades[cardId];

  // Scoped deck drill: due -> weak -> new -> unpassed-today -> passed-today (all cards still included!).
  const scoped = planPath([deck], outcome, { scope: [{ deckId: "d1" }], now });
  const ids = scoped.entries.map((e) => e.card.id);
  assert.deepEqual(ids, [
    "due-1",
    "weak-1",
    "new-1",
    "unpassed-prev-day-1",
    "unpassed-prev-day-2",
    "passed-today-1",
    "passed-today-2",
  ]);

  // Topic-scoped drill with only non-due cards still puts unpassed-today ahead of passed-today.
  const onlyNonDueDeck = {
    id: "d2",
    title: "Trees",
    cards: [
      { id: "today-a", topic: "BST", review: passedTodayReview },
      { id: "yesterday-b", topic: "BST", review: passedYesterdayReview },
      { id: "today-c", topic: "BST", review: passedTodayReview },
    ],
  };
  const topicPlan = planPath([onlyNonDueDeck], () => 4, { scope: [{ deckId: "d2", topic: "BST" }], now });
  assert.deepEqual(
    topicPlan.entries.map((e) => e.card.id),
    ["yesterday-b", "today-a", "today-c"],
  );

  // Unscoped ahead mode also prefers unpassed-today ahead of passed-today.
  const aheadPlan = planPath([onlyNonDueDeck], () => 4, { now, limit: 10 });
  assert.equal(aheadPlan.ahead, true);
  assert.deepEqual(
    aheadPlan.entries.map((e) => e.card.id),
    ["yesterday-b", "today-a", "today-c"],
  );

  // When ALL cards in scope were already passed today, they are still returned so same-day re-practice works.
  const allTodayDeck = {
    id: "d3",
    title: "Done Today",
    cards: [
      { id: "t1", topic: "T", review: passedTodayReview },
      { id: "t2", topic: "T", review: passedTodayReview },
    ],
  };
  const repeatAll = planPath([allTodayDeck], () => 4, { scope: [{ deckId: "d3" }], now });
  assert.deepEqual(repeatAll.entries.map((e) => e.card.id), ["t1", "t2"]);
});

test("8. StudyService end-to-end: same-day repeats keep attempts, preserve Easy(5) mastery on Good(4), and undo cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-fsrs-sameday-"));
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose?.();
    await rm(root, { recursive: true, force: true });
  });

  await service.call("source.add", {
    id: "s1",
    title: "Spacing notes",
    text: "Spaced repetition works best when retrieval attempts occur across separate days.",
  });
  const draft = await service.call("draft.save", {
    deck: {
      id: "d1",
      title: "Spacing",
      cards: [{
        id: "c1",
        kind: "flashcard",
        topic: "Memory",
        objective: "Explain why cross-day spacing matters",
        prompt: "Why does cross-day spacing matter?",
        answer: "Retrieval across separate days strengthens long-term stability.",
        hint: "Think across days.",
        explanation: "Spaced repetition works best across separate days.",
        misconception: "Cramming 5 times in one hour equals 5 spaced days.",
        citations: [{ sourceId: "s1", quote: "Spaced repetition works best when retrieval attempts occur across separate days." }],
      }],
    },
  });
  await service.call("draft.publish", { id: draft.id });

  // Run 1: Easy(5) -> mastered, spaced_reps === 1
  let run1 = await service.call("review.start", { deckId: "d1", mode: "flashcard", fresh: true });
  await service.call("review.reveal", { runId: run1.id, cardId: "c1" });
  run1 = await service.call("review.answer", { runId: run1.id, cardId: "c1", grade: 5 });
  assert.equal(run1.feedback.level, "mastered");

  let state = await new Store(root).read();
  const afterEasy = structuredClone(state.decks[0].cards[0].review);
  assert.equal(afterEasy.spaced_reps, 1);
  assert.equal(afterEasy.last_grade, 5);
  assert.equal(state.attempts.filter((a) => !a.voidedAt).length, 1);

  // Run 2 (same day): Good(4) -> attempts increments to 2, stays mastered, spaced_reps stays 1, D/S/interval preserved
  let run2 = await service.call("review.start", { deckId: "d1", mode: "flashcard", fresh: true });
  await service.call("review.reveal", { runId: run2.id, cardId: "c1" });
  run2 = await service.call("review.answer", { runId: run2.id, cardId: "c1", grade: 4 });
  assert.equal(run2.feedback.level, "mastered", "Easy(5) -> same-day Good(4) stays mastered in StudyService");

  state = await new Store(root).read();
  const afterGood = state.decks[0].cards[0].review;
  assert.equal(state.attempts.filter((a) => !a.voidedAt).length, 2, "every same-day attempt is still recorded");
  assert.equal(afterGood.spaced_reps, 1);
  assert.equal(afterGood.repetitions, 1);
  assert.equal(afterGood.difficulty, afterEasy.difficulty);
  assert.equal(afterGood.stability, afterEasy.stability);
  assert.equal(afterGood.interval_days, afterEasy.interval_days);
  assert.equal(afterGood.last_grade, 5);

  // Undo Run 2 restores exact post-Easy review state.
  await service.call("review.undo", { runId: run2.id });
  state = await new Store(root).read();
  assert.deepEqual(state.decks[0].cards[0].review, afterEasy);
});
