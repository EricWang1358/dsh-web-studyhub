/* The review scheduler is FSRS-6 (lib/sm2.js, ported from BAXUIE's StudyHub for ZCode): the grade → rating map, the
   intervals it gives, the lazy migration of SM-2 review state, what mastery says after a few answers, the settings
   round trip with the old SM-2 keys, and the gaps the answer buttons show. Parity with ts-fsrs itself is in
   tests/fsrs-parity.test.mjs. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedule, initialReview, defaults, checkSettings } from "../lib/domain.js";
import { ratingOfGrade, nextIntervals, memoryState, previewSchedule, LEGACY_KEYS } from "../lib/sm2.js";
import { cardLevel } from "../lib/mastery.js";
import { StudyService } from "../lib/service.js";

const source = { id: "s1", title: "Memento notes",
  text: "The Caretaker manages snapshot history without inspecting snapshot contents. The Originator creates snapshots. A Memento holds state." };
const deck = () => ({ id: "d1", title: "Patterns Quiz", cards: [{
  id: "q1", kind: "quiz", topic: "Memento", objective: "Distinguish history ownership from snapshot storage",
  prompt: "Which component manages history without inspecting snapshot contents?", answer: "Caretaker",
  hint: "Separate the owner of history from a single stored snapshot.",
  explanation: "The Caretaker manages the collection while the Memento stores one state.",
  misconception: "Confusing a stored snapshot with the manager of its history.",
  citations: [{ sourceId: "s1", quote: "The Caretaker manages snapshot history without inspecting snapshot contents." }],
  options: [
    { id: "a", text: "Caretaker", correct: true, explanation: "It manages the snapshot history." },
    { id: "b", text: "Memento", correct: false, explanation: "This confuses a single stored state with the manager of history." },
    { id: "c", text: "Originator", correct: false, explanation: "This confuses snapshot creation with history management." },
  ] }] });

const DAY = 864e5;
const T0 = Date.parse("2026-10-01T09:00:00.000Z");
const at = (days) => new Date(T0 + days * DAY).toISOString();
/** An SM-2 review as 3.7 wrote it: answered `days` before T0 + interval, nothing FSRS on it. */
const sm2Review = ({ repetitions, interval, ease, answered = 0 }) => ({
  repetitions, interval_days: interval, ease_factor: ease, due_at: at(answered + interval),
});

test("grades 0–5 map to the four FSRS ratings; the passing line stays at 3", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(ratingOfGrade), [1, 1, 1, 2, 3, 4]);
  const wrong = schedule(initialReview(), 2, at(0)), right = schedule(initialReview(), 3, at(0));
  assert.equal(wrong.repetitions, 0);
  assert.equal(right.repetitions, 1);
  assert.throws(() => schedule(initialReview(), 6, at(0)), /0 to 5/);
  assert.throws(() => schedule(initialReview(), 4, "not a date"), /timestamp/);
});

test("a new question: Again 1 day, Hard 2, Good 3, Easy 8; on-time Good answers stretch the gap fast", () => {
  assert.deepEqual(nextIntervals(initialReview(), at(0)), [1, 1, 1, 2, 3, 8]);
  assert.deepEqual(previewSchedule(defaults, { grade: 4, reviews: 4 }).map((p) => p.interval), [3, 14, 57, 196]);
  assert.deepEqual(previewSchedule(defaults, { grade: 3, reviews: 4 }).map((p) => p.interval), [2, 4, 9, 15]);
  const first = schedule(initialReview(), 4, at(0));
  assert.equal(first.algorithm, "fsrs-6");
  assert.equal(first.due_at, at(3));
  assert.equal(first.last_review, at(0));
  assert.ok(first.stability > 2 && first.difficulty >= 1 && first.difficulty <= 10);
  // The fields an older build reads stay on the review, so a downgrade keeps scheduling.
  for (const key of ["repetitions", "interval_days", "ease_factor"]) assert.ok(Number.isFinite(first[key]), key);
});

test("a wrong answer on a learned question is a lapse that shortens the gap without throwing the memory away", () => {
  let review = initialReview();
  for (const day of [0, 3, 17]) review = schedule(review, 4, at(day));
  assert.equal(review.interval_days, 57);
  const lapse = schedule(review, 1, at(17 + 57));
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.repetitions, 0);
  assert.ok(lapse.interval_days >= 1 && lapse.interval_days < 57, `${lapse.interval_days}`);
  assert.ok(lapse.stability < review.stability);
  assert.equal(schedule(initialReview(), 1, at(0)).lapses, 0, "a new question answered wrong is not a lapse");
});

test("the gap depends on the time really elapsed: early answers grow it less, same-day repeats do not grow it", () => {
  // #447: the same question answered right on five days in a row (a crunch week, not-yet-due each time).
  let review = initialReview();
  const gaps = [], levels = [];
  for (let day = 0; day < 5; day++) {
    review = schedule(review, 4, at(day));
    gaps.push(review.interval_days);
    levels.push(cardLevel({ review }, 4));
  }
  assert.deepEqual(gaps, [3, 7, 12, 16, 21]);
  assert.deepEqual(levels, ["learning", "familiar", "familiar", "familiar", "mastered"]);
  // Answered on time instead, two answers already give a two-week gap.
  const onTime = schedule(schedule(initialReview(), 4, at(0)), 4, at(3));
  assert.equal(onTime.interval_days, 14);
  // Many answers on one day: the memory does not change, so the gap does not run away.
  let same = schedule(initialReview(), 4, at(0));
  const first = same.interval_days;
  for (let n = 0; n < 5; n++) same = schedule(same, 4, new Date(T0 + (n + 1) * 3600e3).toISOString());
  assert.equal(same.interval_days, first);
  assert.equal(same.stability, schedule(initialReview(), 4, at(0)).stability);
});

test("SM-2 review state migrates at the next answer: interval → stability, ease → difficulty", () => {
  const typical = [
    { name: "second answer done", review: sm2Review({ repetitions: 2, interval: 6, ease: 2.5 }) },
    { name: "mature", review: sm2Review({ repetitions: 5, interval: 38, ease: 2.7 }) },
    { name: "struggling", review: sm2Review({ repetitions: 3, interval: 8, ease: 1.3 }) },
    { name: "just failed", review: sm2Review({ repetitions: 0, interval: 1, ease: 1.96 }) },
  ];
  for (const { name, review } of typical) {
    const state = memoryState(review);
    assert.equal(state.isNew, false, name);
    assert.equal(state.stability, review.interval_days, name);
    assert.equal(state.lastReview, T0, `${name}: last answer = due − interval`);
    const due = review.due_at;
    const after = schedule(review, 4, due);
    assert.equal(after.algorithm, "fsrs-6", name);
    assert.ok(Number.isFinite(after.stability) && Number.isFinite(after.difficulty), name);
    assert.ok(after.interval_days > review.interval_days, `${name}: on time and right, the gap grows (${after.interval_days})`);
    assert.equal(after.repetitions, review.repetitions + 1, name);
    assert.equal(after.elapsed_days, review.interval_days, name);
  }
  // Ease maps onto difficulty: the default ease is mid-scale, the minimum ease is the hardest.
  assert.ok(Math.abs(memoryState(typical[0].review).difficulty - 5.09) < 0.01);
  assert.equal(memoryState(typical[2].review).difficulty, 10);
  assert.ok(memoryState(typical[1].review).difficulty < memoryState(typical[0].review).difficulty);
  // A mature card answered wrong is not sent back to day 1 of a new card.
  const lapse = schedule(typical[1].review, 1, typical[1].review.due_at);
  assert.equal(lapse.lapses, 1);
  assert.ok(lapse.interval_days >= 1 && lapse.interval_days < 38);
});

test("an SM-2 review nobody has answered since the upgrade reads as it did", () => {
  const mature = sm2Review({ repetitions: 5, interval: 38, ease: 2.7 });
  assert.equal(cardLevel({ review: mature }), "mastered");
  assert.equal(cardLevel({ review: sm2Review({ repetitions: 2, interval: 6, ease: 2.5 }) }), "familiar");
  assert.equal(cardLevel({ review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } }), "new");
  assert.equal(memoryState({ repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }).isNew, true);
  // The answer buttons can already say what each answer would do.
  const gaps = nextIntervals(mature, mature.due_at);
  assert.equal(gaps.length, 6);
  assert.ok(gaps[4] > 38 && gaps[5] > gaps[4] && gaps[3] < gaps[4] && gaps[0] <= gaps[3]);
});

test("mastery after a few answers keeps its meaning (learning < 6 days ≤ familiar < 21 days ≤ mastered)", () => {
  let review = initialReview(), day = 0;
  const levels = [];
  for (let n = 0; n < 3; n++) {
    review = schedule(review, 4, at(day));
    levels.push([review.interval_days, cardLevel({ review }, 4)]);
    day += review.interval_days;
  }
  assert.deepEqual(levels, [[3, "learning"], [14, "familiar"], [57, "mastered"]]);
  assert.equal(cardLevel({ review: schedule(initialReview(), 5, at(0)) }, 5), "mastered", "轻松掌握 is the learner's own call");
  assert.equal(cardLevel({ review: schedule(initialReview(), 3, at(0)) }, 3), "learning");
  assert.equal(cardLevel({ review: schedule(initialReview(), 1, at(0)) }, 1), "weak");
});

test("settings: two numbers with defaults, checked ranges, the SM-2 keys ignored and dropped", () => {
  assert.deepEqual({ ...defaults }, { request_retention: 0.9, maximum_interval: 36500 });
  const legacy = { minimum_ease_factor: 1.3, initial_ease_factor: 2.5, first_interval_days: 7, second_interval_days: 9 };
  const checked = checkSettings({ ...legacy, generation: { count: 3 } });
  for (const key of LEGACY_KEYS) assert.equal(Object.hasOwn(checked, key), false, key);
  assert.deepEqual(checked, { generation: { count: 3 }, request_retention: 0.9, maximum_interval: 36500 });
  assert.equal(checkSettings({ maximum_interval: 365.0 }).maximum_interval, 365);
  for (const bad of [{ request_retention: 0.69 }, { request_retention: 0.98 }, { request_retention: "x" }, { maximum_interval: 0 }, { maximum_interval: 36501 }])
    assert.throws(() => checkSettings(bad), /Invalid scheduling value/, JSON.stringify(bad));
  // Old keys on read change nothing: the same answer gets the same gap as with the defaults.
  assert.deepEqual(schedule(initialReview(), 4, at(0), legacy), schedule(initialReview(), 4, at(0)));
  // A lower target recall spaces reviews further apart; the maximum caps every gap.
  const loose = previewSchedule({ request_retention: 0.8, maximum_interval: 36500 }, { reviews: 3 });
  assert.ok(loose.at(-1).interval > previewSchedule(defaults, { reviews: 3 }).at(-1).interval);
  // The maximum is a hard cap, also for Good and Easy (ts-fsrs would add a day or two to keep them above Hard).
  const capped = previewSchedule({ request_retention: 0.9, maximum_interval: 30 }, { grade: 5, reviews: 6 });
  assert.deepEqual(capped.map((p) => p.interval), [8, 30, 30, 30, 30, 30]);
  assert.deepEqual(nextIntervals(schedule(schedule(initialReview(), 4, at(0)), 4, at(3)), at(17), { maximum_interval: 30 }).slice(3), [30, 30, 30]);
  assert.equal(previewSchedule({ request_retention: 0.5, maximum_interval: 30 }), null, "invalid values give no preview");
});

test("settings round trip: saving drops the SM-2 keys an older build left in the library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-fsrs-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const before = await service.call("export");
  await service.call("restore", { state: { ...before, settings: { minimum_ease_factor: 1.3, initial_ease_factor: 2.5, first_interval_days: 2, second_interval_days: 6 } } });
  const read = (await service.call("snapshot")).settings;
  assert.equal(read.request_retention, 0.9, "a library from an older build reads with the defaults");
  assert.equal(read.maximum_interval, 36500);
  const saved = await service.call("settings", { request_retention: 0.85 });
  assert.equal(saved.request_retention, 0.85);
  for (const key of LEGACY_KEYS) assert.equal(Object.hasOwn(saved, key), false, key);
  const again = (await service.call("snapshot")).settings;
  assert.equal(again.request_retention, 0.85);
  for (const key of LEGACY_KEYS) assert.equal(Object.hasOwn(again, key), false, key);
  await assert.rejects(service.call("settings", { request_retention: 0.99 }), /request_retention/);
  assert.equal((await service.call("snapshot")).settings.request_retention, 0.85, "a refused value changes nothing");
});

test("the answer buttons show each grade's gap, and the answer gets exactly that gap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-fsrs-buttons-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const draft = await service.call("draft.save", { deck: deck() });
  await service.call("draft.publish", { id: draft.id });
  let run = await service.call("review.start", { deckId: "d1", mode: "flashcard" });
  assert.equal(run.intervals, undefined, "no gaps before the answer is shown");
  run = await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
  assert.deepEqual(run.intervals, [1, 1, 1, 2, 3, 8]);
  const answered = Date.now();
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 4 });
  assert.equal(run.intervals, undefined, "graded: the buttons are gone");
  const days = (Date.parse(run.feedback.nextDue) - answered) / DAY;
  assert.ok(Math.abs(days - 3) < 0.01, `${days}`);
});

test("the gap under an answer button reads as a person would say it, in both languages", async () => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const compiled = await build({ stdin: { contents: "export { formatGap } from './ui/format.js'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react-dom"], loader: { ".css": "text" }, logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const { formatGap, setUiLanguage } = module.exports;
  setUiLanguage("zh");
  assert.deepEqual([1, 3, 59, 60, 200, 365, 584, 4000].map(formatGap), ["1 天", "3 天", "59 天", "2 个月", "7 个月", "1 年", "1.6 年", "11 年"]);
  assert.equal(formatGap(undefined), "");
  setUiLanguage("en");
  try { assert.deepEqual([3, 200, 584].map(formatGap), ["3 d", "7 mo", "1.6 yr"]); } finally { setUiLanguage("zh"); }
});
