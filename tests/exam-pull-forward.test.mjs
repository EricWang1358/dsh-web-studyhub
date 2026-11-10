/* #882 step 3: questions already scheduled past a course exam come back before it (lib/exam-alignment.js alignDueDates).
   Only `due_at` moves; the due date it had is kept in `unaligned_due_at`, so removing the exam date or switching alignment
   off gives it back exactly. Times are built on the local calendar, so the tests hold in any time zone. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedule, initialReview, memoryState, retrievability } from "../lib/sm2.js";
import { alignDueDates, restoreDueDates } from "../lib/exam-alignment.js";
import { StudyService } from "../lib/service.js";

const NOW = new Date(2026, 10, 2, 10, 0).getTime(); // 2 Nov 2026, 10:00 local
const local = (days, hh = 10) => new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate() + days, hh).getTime();
const iso = (days, hh) => new Date(local(days, hh)).toISOString();
const dateOf = (days) => {
  const d = new Date(local(days));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayOf = (value) => {
  const d = new Date(value), base = new Date(NOW);
  return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(base.getFullYear(), base.getMonth(), base.getDate())) / 864e5);
};
/** A review answered `answeredDaysAgo` days ago (after two earlier answers) and moved to fall due `dueIn` days from NOW. */
function reviewDueIn(dueIn, answeredDaysAgo = 20) {
  const answered = schedule(schedule(schedule(initialReview(), 4, iso(-answeredDaysAgo - 30)), 4, iso(-answeredDaysAgo - 20)), 4, iso(-answeredDaysAgo));
  return { ...answered, due_at: iso(dueIn) };
}
const EXAM = 10;
const quiz = (id, review, extra = {}) => ({ id, kind: "flashcard", topic: id, prompt: `${id}?`, answer: "a", citations: [], review, ...extra });
function library(examDate = dateOf(EXAM)) {
  return {
    settings: { request_retention: 0.9, maximum_interval: 36500 },
    courses: [{ id: "os", name: "OS", ...(examDate ? { exam: { format: "closed-book", date: examDate } } : {}), focusTopics: [] },
      // A chapter the learner parked: it shares OS's exam, but parking promises never to touch its schedule.
      { id: "os-parked", name: "OS / Parked", active: false, focusTopics: [] }],
    decks: [
      { id: "os-1", title: "OS 1", course: "OS", cards: [
        quiz("late-risky", reviewDueIn(40, 60)),
        quiz("late-safe", reviewDueIn(60, 2)),
        quiz("soon", reviewDueIn(5)),
        quiz("overdue", reviewDueIn(-1)),
        // An SM-2 review from before 3.8: no FSRS state, its last review is read from due_at − interval_days.
        quiz("legacy", { repetitions: 3, interval_days: 30, ease_factor: 2.5, due_at: iso(25) }),
        quiz("parked", reviewDueIn(50), { suspended: true }),
        quiz("unseen", initialReview()),
        // Never answered, but given a due date (an import can do that): new, like the forecast counts it, so not pulled.
        quiz("fresh", { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: iso(30) }),
      ] },
      { id: "os-old", title: "OS old", course: "OS", archived: true, cards: [quiz("archived", reviewDueIn(40))] },
      { id: "os-park", title: "OS parked", course: "OS / Parked", cards: [quiz("parked-course", reviewDueIn(40))] },
      { id: "net", title: "Networks", course: "Networks", cards: [quiz("other-course", reviewDueIn(40))] },
      { id: "sys", title: "错题本", systemKind: "wrongbook", cards: [quiz("system", reviewDueIn(40))] },
    ],
  };
}
const card = (state, id) => state.decks.flatMap((deck) => deck.cards).find((item) => item.id === id);
const memory = ({ due_at: _due, unaligned_due_at: _unaligned, ...rest }) => rest;

test("a question due after the exam gets a due date before it; nothing else on its review changes", () => {
  const original = library(), state = structuredClone(original);
  const result = alignDueDates(state, NOW);
  assert.deepEqual(result, { pulled: 3, restored: 0 });
  for (const id of ["late-risky", "late-safe", "legacy"]) {
    const before = card(original, id).review, after = card(state, id).review;
    assert.equal(after.unaligned_due_at, before.due_at, `${id}: its due date is kept`);
    assert.ok(dayOf(after.due_at) >= 0 && dayOf(after.due_at) < EXAM, `${id}: due day ${dayOf(after.due_at)} is before the exam day`);
    assert.deepEqual(memory(after), memory(before), `${id}: memory state, streak and gap unchanged`);
    assert.deepEqual(memoryState(after, NOW), memoryState(before, NOW), `${id}: the scheduler reads the same memory`);
    assert.equal(retrievability(after, NOW), retrievability(before, NOW));
  }
  for (const id of ["soon", "overdue", "parked", "unseen", "fresh", "archived", "parked-course", "other-course", "system"])
    assert.deepEqual(card(state, id), card(original, id), `${id} is left alone`);
  assert.ok(dayOf(card(state, "late-risky").review.due_at) < dayOf(card(state, "late-safe").review.due_at), "the one most likely forgotten comes back first");
});

test("many questions are spread over the days left, the most at risk first, so no day gets them all", () => {
  const state = library();
  state.decks[0].cards = Array.from({ length: 30 }, (_, i) => quiz(`q${i}`, reviewDueIn(20 + i, 1 + ((i * 7) % 30))));
  alignDueDates(state, NOW);
  const perDay = new Map();
  for (const item of state.decks[0].cards) perDay.set(dayOf(item.review.due_at), (perDay.get(dayOf(item.review.due_at)) || 0) + 1);
  assert.deepEqual([...perDay.keys()].sort((a, b) => a - b), Array.from({ length: EXAM }, (_, i) => i), "every day from today to the day before the exam");
  assert.ok(Math.max(...perDay.values()) <= 3, `30 questions over 10 days: ${JSON.stringify([...perDay])}`);
  const byDue = [...state.decks[0].cards].sort((a, b) => Date.parse(a.review.due_at) - Date.parse(b.review.due_at) || retrievability(a.review, NOW) - retrievability(b.review, NOW));
  const risk = byDue.map((item) => retrievability(item.review, NOW));
  assert.deepEqual(risk, [...risk].sort((a, b) => a - b), "earlier days hold the questions with the lower recall");
  assert.equal(dayOf(byDue[0].review.due_at), 0, "the most at risk is due today");
  assert.ok(Date.parse(byDue[0].review.due_at) <= NOW, "and due now, not later today");
});

test("running it twice gives the same library", () => {
  const once = library();
  alignDueDates(once, NOW);
  const twice = structuredClone(once);
  assert.deepEqual(alignDueDates(twice, NOW), { pulled: 0, restored: 0 });
  assert.deepEqual(twice, once);
  assert.deepEqual(alignDueDates(twice, local(3)), { pulled: 0, restored: 0 }, "nor a few days later, with the exam unchanged");
  assert.deepEqual(twice, once);
});

test("removing the exam date or switching alignment off gives every question its own due date back", () => {
  const original = library();
  for (const undo of [
    (state) => { delete state.courses[0].exam; },
    (state) => { state.settings.exam_alignment = false; },
  ]) {
    const state = structuredClone(original);
    alignDueDates(state, NOW);
    undo(state);
    assert.deepEqual(alignDueDates(state, NOW), { pulled: 0, restored: 3 });
    const expected = structuredClone(original);
    undo(expected);
    assert.deepEqual(state, expected);
  }
});

test("an answer capped by the exam is given back too, and is pulled again when alignment comes back on", () => {
  const state = library();
  const capped = schedule(card(state, "soon").review, 4, new Date(NOW).toISOString(), { ...state.settings, exam_date: dateOf(EXAM) });
  assert.ok(capped.unaligned_due_at, "the answer was capped");
  card(state, "soon").review = structuredClone(capped);
  state.settings.exam_alignment = false;
  alignDueDates(state, NOW);
  assert.equal(card(state, "soon").review.due_at, capped.unaligned_due_at);
  assert.equal(card(state, "soon").review.unaligned_due_at, undefined);
  state.settings.exam_alignment = true;
  alignDueDates(state, NOW);
  assert.ok(dayOf(card(state, "soon").review.due_at) < EXAM);
  assert.equal(card(state, "soon").review.unaligned_due_at, capped.unaligned_due_at);
});

test("a changed exam date: earlier re-spreads before the new date, later gives back what no longer needs it", () => {
  const state = library();
  alignDueDates(state, NOW);
  state.courses[0].exam.date = dateOf(4);
  alignDueDates(state, NOW);
  for (const id of ["late-risky", "late-safe", "legacy", "soon"]) assert.ok(dayOf(card(state, id).review.due_at) < 4, `${id} before the new exam day`);
  assert.equal(card(state, "soon").review.unaligned_due_at, iso(5), "due a day after the new exam: now pulled too");
  state.courses[0].exam.date = dateOf(45);
  assert.deepEqual(alignDueDates(state, NOW), { pulled: 0, restored: 3 }, "only the question due after day 45 stays pulled");
  assert.ok(card(state, "late-safe").review.unaligned_due_at);
  assert.equal(card(state, "late-risky").review.due_at, iso(40));
});

test("on the exam day nothing moves: the questions brought forward stay before the exam they are for", () => {
  const state = library();
  alignDueDates(state, NOW);
  const aligned = structuredClone(state);
  assert.deepEqual(alignDueDates(state, local(EXAM, 7)), { pulled: 0, restored: 0 });
  assert.deepEqual(state, aligned);
});

test("after the exam day a pass gives back what it brought forward; the restore pass does only that", () => {
  const state = library();
  alignDueDates(state, NOW);
  const restoreOnly = structuredClone(state);
  assert.deepEqual(alignDueDates(state, local(EXAM + 1)), { pulled: 0, restored: 3 });
  assert.equal(state.decks[0].cards.filter((item) => item.review.unaligned_due_at).length, 0);
  assert.deepEqual(state, library(), "every original date is back");
  // Before the exam the restore pass gives back only what no longer has an exam ahead, and never pulls.
  restoreOnly.courses[0].exam.date = dateOf(EXAM);
  assert.deepEqual(restoreDueDates(structuredClone(restoreOnly), NOW), { pulled: 0, restored: 0 }, "exam still ahead: nothing to give back");
  assert.deepEqual(restoreDueDates(restoreOnly, local(EXAM + 2)), { pulled: 0, restored: 3 });
  const fresh = library();
  assert.deepEqual(restoreDueDates(fresh, NOW), { pulled: 0, restored: 0 }, "the restore pass never brings anything forward");
});

test("a question brought forward and then answered with alignment off keeps its new date when the exam is removed", () => {
  const state = library();
  alignDueDates(state, NOW);
  const answeredAt = new Date(local(2)).toISOString();
  const answered = schedule(card(state, "late-risky").review, 4, answeredAt, state.settings);
  assert.equal(answered.unaligned_due_at, undefined, "answered without an exam date on its settings");
  card(state, "late-risky").review = structuredClone(answered);
  delete state.courses[0].exam;
  assert.deepEqual(alignDueDates(state, local(2)), { pulled: 0, restored: 2 });
  assert.deepEqual(card(state, "late-risky").review, answered, "its own answer's date, not the one from before the exam");
});

test("only the decks named are brought forward; every other moved question can still be given back", () => {
  const state = library();
  state.courses.push({ id: "net", name: "Networks", exam: { format: "closed-book", date: dateOf(EXAM) }, focusTopics: [] });
  assert.deepEqual(alignDueDates(state, NOW, { pullDecks: new Set(["net"]) }), { pulled: 1, restored: 0 });
  assert.ok(card(state, "other-course").review.unaligned_due_at);
  assert.equal(card(state, "late-risky").review.unaligned_due_at, undefined, "OS's questions wait for their own trigger");
});

test("saving an exam date pulls the course's questions forward; clearing it and the alignment switch give them back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-pull-"));
  const study = new StudyService(root);
  t.after(async () => { study.dispose?.(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const today = new Date();
  const date = (days) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const due = new Date(Date.now() + 40 * 864e5).toISOString();
  await study.store.update((s) => { s.decks.push({ id: "os", title: "OS", course: "OS", cards: [quiz("q1", { ...reviewDueIn(0), due_at: due })] }); });
  const dueOf = async () => (await study.call("export")).decks[0].cards[0].review;

  await study.call("course.save", { name: "OS", exam: { format: "closed-book", date: date(7) } });
  const pulled = await dueOf();
  assert.equal(pulled.unaligned_due_at, due);
  const dayFromToday = (value) => { const d = new Date(value); return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5); };
  assert.ok(dayFromToday(pulled.due_at) >= 0 && dayFromToday(pulled.due_at) < 7, "before the exam day");
  await study.call("course.save", { name: "OS", exam: { format: "closed-book", date: date(7) } });
  assert.deepEqual(await dueOf(), pulled, "saving the same date again moves nothing");

  await study.call("course.examAlignment.set", { enabled: false });
  assert.equal((await dueOf()).due_at, due, "alignment off: its own due date");
  await study.call("course.examAlignment.set", { enabled: true });
  assert.equal((await dueOf()).unaligned_due_at, due, "on again: pulled again");
  await assert.rejects(() => study.call("settings", { exam_alignment: false }), /course\.examAlignment\.set/, "one write for the switch, so the due dates always follow it");
  await assert.rejects(() => study.call("course.examAlignment.set", { enabled: "no" }), /true 或 false/);
  await study.call("course.save", { name: "OS", exam: null });
  const restored = await dueOf();
  assert.equal(restored.due_at, due, "exam date cleared: its own due date");
  assert.equal(restored.unaligned_due_at, undefined);
});

test("saving one course's exam date brings only its own questions forward and says what moved; the switch covers every course", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-scope-"));
  const study = new StudyService(root);
  t.after(async () => { study.dispose?.(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const today = new Date();
  const date = (days) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const due = new Date(Date.now() + 40 * 864e5).toISOString();
  const late = (id) => quiz(id, { ...reviewDueIn(0), due_at: due });
  // OS had its exam date before alignment existed: on, but nothing moved yet.
  await study.store.update((s) => {
    s.courses.push({ id: "os", name: "OS", exam: { format: "closed-book", date: date(7) }, focusTopics: [] });
    s.decks.push({ id: "os", title: "OS", course: "OS", cards: [late("a1")] }, { id: "db", title: "DB", course: "DB", cards: [late("b1")] });
  });
  const reviewOf = async (deckId) => (await study.call("export")).decks.find((deck) => deck.id === deckId).cards[0].review;
  const saved = await study.call("course.save", { name: "DB", exam: { format: "closed-book", date: date(9) } });
  assert.deepEqual(saved.alignment, { pulled: 1, restored: 0 }, "course.save says what the pass moved");
  assert.ok((await reviewOf("db")).unaligned_due_at, "DB's own question came forward");
  assert.equal((await reviewOf("os")).unaligned_due_at, undefined, "OS waits for the learner's 现在对齐");
  assert.equal((await study.call("course.save", { name: "DB", focusTopics: ["joins"] })).alignment, undefined, "no exam change, no pass");
  const preview = await study.call("course.examAlignment.preview", {});
  assert.equal(preview.pending, 1);
  assert.deepEqual(preview.courses.map((course) => [course.name, course.pending]), [["OS", 1], ["DB", 0]]);
  assert.deepEqual(await study.call("course.examAlignment.set", { enabled: true }), { enabled: true, pulled: 1, restored: 0 });
  assert.ok((await reviewOf("os")).unaligned_due_at);
});

test("once the exam has passed the moved questions are counted, and the restore button gives their dates back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-restore-"));
  const study = new StudyService(root);
  t.after(async () => { study.dispose?.(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const today = new Date();
  const date = (days) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const own = new Date(Date.now() + 30 * 864e5).toISOString(), early = new Date(Date.now() - 3 * 864e5).toISOString();
  await study.store.update((s) => {
    s.courses.push({ id: "os", name: "OS", exam: { format: "closed-book", date: date(-2) }, focusTopics: [] });
    s.decks.push({ id: "os", title: "OS", course: "OS", cards: [quiz("q1", { ...reviewDueIn(0), due_at: early, unaligned_due_at: own }), quiz("q2", { ...reviewDueIn(0), due_at: early, unaligned_due_at: own })] });
  });
  const preview = await study.call("course.examAlignment.preview", {});
  assert.deepEqual(preview.courses, [], "no exam ahead: the switch itself is hidden");
  assert.equal(preview.restorable, 2, "but the two questions still on their early date are counted");
  assert.deepEqual(await study.call("course.examAlignment.restore", {}), { pulled: 0, restored: 2 });
  const cards = (await study.call("export")).decks[0].cards;
  assert.deepEqual(cards.map((card) => [card.review.due_at, card.review.unaligned_due_at]), [[own, undefined], [own, undefined]]);
  assert.equal((await study.call("course.examAlignment.preview", {})).restorable, 0);
});

test("merging a course into one with an exam brings the merged decks' questions forward", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-merge-"));
  const study = new StudyService(root);
  t.after(async () => { study.dispose?.(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const today = new Date();
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
  const examDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const due = new Date(Date.now() + 40 * 864e5).toISOString();
  await study.store.update((s) => { s.decks.push({ id: "old", title: "OS old", course: "OS 2", cards: [quiz("q1", { ...reviewDueIn(0), due_at: due })] }); });
  const os = await study.call("course.save", { name: "OS", exam: { format: "closed-book", date: examDate } });
  const other = await study.call("course.get", { name: "OS 2" });
  await study.call("course.merge", { from: [other.id], into: os.id });
  const review = (await study.call("export")).decks[0].cards[0].review;
  assert.equal(review.unaligned_due_at, due);
});