/* #882 step 1: one function derives the scheduling settings of a question (lib/card-schedule.js cardScheduleSettings), and
   every path that schedules a question uses it: a practice answer, a mock exam, prerequisite credit, rubric grading, the
   oral mock and the sample library. Each test replays the attempts a path recorded through `schedule` with that function's
   settings and expects the very review the path stored. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { schedule, initialReview } from "../lib/sm2.js";
import { cardScheduleSettings } from "../lib/card-schedule.js";
import { commitRubricGrade } from "../lib/rubric-grading.js";
import { createPreviewServer } from "../scripts/preview-server.mjs";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { Store } from "../lib/store.js";

const quiz = (id, topic, extra = {}) => ({
  id, kind: "quiz", topic, objective: `About ${topic}`, prompt: `${topic}?`, answer: "A", explanation: "A holds.",
  citations: [], options: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }], ...extra,
});

async function service(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-card-schedule-"));
  const study = new StudyService(root, options);
  t.after(async () => {
    study.dispose?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return study;
}

/** Every scheduled attempt (not a tail retry, not an edited question) stored the review `schedule` gives with the shared settings. */
function assertEveryAttemptUsesCardSettings(state, expectedCount) {
  const scheduled = state.attempts.filter((attempt) => attempt.after && !attempt.retry && !attempt.updatedAfterOpening);
  assert.ok(scheduled.length >= expectedCount, `expected at least ${expectedCount} scheduled attempts, got ${scheduled.length}`);
  for (const attempt of scheduled) {
    const deck = state.decks.find((item) => item.id === attempt.deckId);
    const card = deck.cards.find((item) => item.id === attempt.quiz_id);
    const expected = schedule(attempt.before ?? initialReview(), attempt.grade, attempt.timestamp, cardScheduleSettings(state, deck, card).settings);
    assert.deepEqual(attempt.after, expected, `${attempt.assessment ?? "answer"} of ${attempt.quiz_id}`);
  }
}

test("cardScheduleSettings raises the target recall of a focus question only, and leaves a deck without a course alone", () => {
  const state = { settings: { request_retention: 0.9, maximum_interval: 36500 }, courses: [{ id: "os", name: "OS", focusTopics: ["死锁"] }] };
  const deck = { id: "d", course: "OS", cards: [] };
  const focus = quiz("f", "死锁四个条件"), plain = quiz("p", "进程概念");
  assert.deepEqual(cardScheduleSettings(state, deck, focus), { settings: { request_retention: 0.94, maximum_interval: 36500 }, isFocus: true });
  assert.deepEqual(cardScheduleSettings(state, deck, plain), { settings: state.settings, isFocus: false });
  assert.equal(cardScheduleSettings(state, { id: "sys", systemKind: "wrongbook", cards: [] }, plain).isFocus, false);
  assert.equal(cardScheduleSettings(state, deck, { ...plain, focus: true }).isFocus, true, "a question marked 重点 by hand");
  assert.deepEqual(cardScheduleSettings({ ...state, settings: { ...state.settings, focus_boost: false } }, deck, focus).settings.request_retention, 0.9);
});

test("a practice answer, a mock exam and prerequisite credit schedule with the shared settings", async (t) => {
  const study = await service(t);
  await study.call("course.save", { name: "OS", focusTopics: ["死锁"] });
  await study.store.update((s) => {
    s.decks.push({ id: "os", title: "OS", course: "OS", cards: [
      // Due since yesterday, so answering the question that needs it credits it (lib/study-state.js creditPrerequisites).
      quiz("base", "死锁的定义", { review: { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: new Date(Date.now() - 86400000).toISOString() } }),
      quiz("use", "死锁四个条件", { requires: [{ deckId: "os", cardId: "base" }] }),
      quiz("plain", "进程概念"),
    ] });
  });
  let run = await study.call("review.start", { mode: "path", scope: [{ deckId: "os", cardId: "use" }, { deckId: "os", cardId: "plain" }], ordered: true, fresh: true });
  for (let step = 0; step < 2; step++) {
    run = await study.call("review.answer", { runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion, selected: ["a"] });
    if (step === 0) run = await study.call("review.move", { runId: run.id, direction: 1 });
  }
  const exam = await study.call("review.start", { mode: "exam", scope: [{ deckId: "os", cardId: "plain" }, { deckId: "os", cardId: "use" }], count: 2 });
  await study.call("review.answer", { runId: exam.id, cardId: exam.card.id, selected: ["a"] });
  await study.call("exam.submit", { runId: exam.id });
  const state = await study.call("export");
  assert.ok(state.attempts.some((attempt) => attempt.implicit), "the prerequisite was credited");
  // Two practice answers, the credited prerequisite and the one exam question answered (an unanswered one is not graded).
  assertEveryAttemptUsesCardSettings(state, 4);
});

test("rubric grading schedules with the shared settings", () => {
  const card = { id: "o1", kind: "open", topic: "死锁", prompt: "p", rubricCriteria: [{ id: "c", text: "c", points: 2 }] };
  const state = { settings: { request_retention: 0.9 }, courses: [{ id: "os", name: "OS", focusTopics: ["死锁"] }],
    decks: [{ id: "d", course: "OS", cards: [card] }], runs: [], attempts: [], inbox: [], sources: [] };
  commitRubricGrade(state, { ref: { deckId: "d", cardId: "o1" }, answer: "text", timestamp: "2026-11-01T08:00:00.000Z",
    grading: { summary: "", questions: [{ cardId: "o1", total: 2, max: 2, ratio: 1, band: "full", unanswered: false, criteria: [], unanchored: [], assumptions: [] }] } });
  assertEveryAttemptUsesCardSettings(state, 1);
  assert.equal(cardScheduleSettings(state, state.decks[0], card).isFocus, true, "the graded question is a focus question");
});

test("the oral mock schedules with the shared settings: a focus question gets the focus target recall", async (t) => {
  const COURSE = "笔试 / 面试 · Platform Engineer";
  const study = await service(t, {
    complete: async () => JSON.stringify({ results: [
      { cardId: "a", band: "strong", reason: "ok" },
      { cardId: "b", band: "developing", reason: "ok" },
    ] }),
  });
  // Answered twice before, so the focus target recall gives a shorter gap than the library's own (a first answer gets the same).
  const seeded = schedule(schedule(initialReview(), 4, "2026-10-01T08:00:00.000Z"), 4, "2026-10-04T08:00:00.000Z");
  const card = (id, topic) => ({ id, kind: "flashcard", topic, prompt: `${topic} 是什么？`, answer: `${topic} 的要点`, citations: [], review: structuredClone(seeded) });
  await study.store.update((s) => {
    s.decks.push({ id: "d", title: "岗位基础", course: COURSE, cards: [card("a", "架构"), card("b", "性能"), card("c", "安全")] });
  });
  await study.call("course.save", { name: COURSE, interview: { role: "Platform Engineer", jd: "分布式" }, focusTopics: ["架构", "性能"] });
  await study.call("focus.set", { course: COURSE });
  const start = await study.call("oral.start", { count: 2 });
  await study.call("oral.answer", { runId: start.id, cardId: start.entry.cardId, answer: "回答一" });
  const next = await study.call("oral.next", { runId: start.id });
  await study.call("oral.answer", { runId: start.id, cardId: next.entry.cardId, answer: "回答二" });
  await study.call("oral.submit", { runId: start.id });
  const state = await study.call("export");
  assert.equal(state.attempts.filter((attempt) => attempt.assessment === "oral").length, 2);
  assertEveryAttemptUsesCardSettings(state, 2);
  const oral = state.attempts.filter((attempt) => attempt.assessment === "oral");
  assert.ok(oral.some((attempt) => schedule(attempt.before, attempt.grade, attempt.timestamp, state.settings).interval_days !== attempt.after.interval_days),
    "the library's own settings would have given another gap: the test tells the two apart");
});

test("the sample library's three weeks of history are scheduled with the shared settings", async (t) => {
  const libraryRoot = await mkdtemp(join(tmpdir(), "study-card-schedule-sample-")), home = await mkdtemp(join(tmpdir(), "study-card-schedule-home-"));
  const savedHome = process.env.DSH_HOME;
  const server = await createPreviewServer({ libraryRoot, home, port: 0, model: createFakeModel({ latencyMs: 0 }) });
  t.after(async () => {
    await server.close();
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    await rm(libraryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const res = await fetch(server.url + "/api/call", { method: "POST", headers: { "Content-Type": "application/json", "X-Study-Token": server.token },
    body: JSON.stringify({ action: "sample.load", args: { language: "en" } }) });
  assert.equal((await res.json()).ok, true);
  const state = await new Store(libraryRoot).read();
  const sample = state.attempts.filter((attempt) => attempt.sample);
  assertEveryAttemptUsesCardSettings({ ...state, attempts: sample }, 30);
  // The sample has no focus question, but its course has an exam ahead: with the library's plain settings some answers would
  // come back after it, so the stored history really carries what the shared function adds (here the exam date).
  const plain = sample.filter((attempt) => attempt.after && !attempt.retry)
    .filter((attempt) => JSON.stringify(schedule(attempt.before ?? initialReview(), attempt.grade, attempt.timestamp, state.settings)) !== JSON.stringify(attempt.after));
  assert.ok(plain.length > 0, "the library's own settings would have scheduled some sample answers differently");
  assert.ok(plain.every((attempt) => attempt.after.unaligned_due_at || attempt.after.due_at !== schedule(attempt.before ?? initialReview(), attempt.grade, attempt.timestamp, state.settings).due_at));
});