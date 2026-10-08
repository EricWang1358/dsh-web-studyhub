import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { EXAM_LIMIT_MS, LIMIT_MINUTES, defaultLimitMinutes, examExpired, examLimitMs, limitPresets } from "../lib/exam-timing.js";

/* 模拟考试的限时: the written exam carries its own limit (the course's 作答时间 when it has one, else 30 minutes), chosen before
   the start and kept on the run, so the server, the clock on the page and the report all use the same number. */

const source = { id: "s1", title: "Memento notes", text: "The Caretaker manages snapshot history without inspecting snapshot contents." };
const quiz = (id, topic) => ({
  id, kind: "quiz", topic, objective: `Explain ${topic} precisely`, prompt: `Which component owns the ${topic} responsibility?`,
  answer: "Caretaker", hint: "Separate ownership from storage.", explanation: "The Caretaker manages the history.", misconception: "Confusing storage with management.",
  citations: [{ sourceId: "s1", quote: "The Caretaker manages snapshot history without inspecting snapshot contents." }],
  options: [{ id: "a", text: "Caretaker", correct: true, explanation: "It manages history." }, { id: "b", text: "Memento", correct: false, explanation: "It stores one state." },
    { id: "c", text: "Originator", correct: false, explanation: "It creates snapshots." }],
});
async function library() {
  const root = await mkdtemp(join(tmpdir(), "study-limit-"));
  const service = new StudyService(root);
  await service.call("source.add", source);
  await service.call("draft.save", { deck: { id: "d1", title: "Patterns", cards: [quiz("q1", "History"), quiz("q2", "Creation")] } });
  await service.call("draft.publish", { id: "d1" });
  return { root, service };
}
const startedMinutesAgo = (service, runId, minutes) => service.store.update((state) => {
  state.runs.find((item) => item.id === runId).startedAt = new Date(Date.now() - minutes * 60 * 1000).toISOString();
});

test("an exam without a chosen limit keeps 30 minutes and says so on the run", async () => {
  const { root, service } = await library();
  try {
    const run = await service.call("review.start", { mode: "exam", count: 1 });
    assert.equal(run.limitMs, EXAM_LIMIT_MS);
    assert.equal((await service.call("review.get", { runId: run.id })).limitMs, EXAM_LIMIT_MS);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a chosen limit is kept on the run and decides when the server stops accepting answers", async () => {
  const { root, service } = await library();
  try {
    const long = await service.call("review.start", { mode: "exam", count: 1, limitMinutes: 90, fresh: true });
    assert.equal(long.limitMs, 90 * 60000);
    assert.equal((await service.call("review.get", { runId: long.id })).limitMs, 90 * 60000);
    await startedMinutesAgo(service, long.id, 45);
    await service.call("review.answer", { runId: long.id, cardId: long.card.id, selected: ["a"] });
    await startedMinutesAgo(service, long.id, 91);
    await assert.rejects(service.call("review.answer", { runId: long.id, cardId: long.card.id, selected: ["a"] }), /考试时间已到/);
    const longReport = await service.call("exam.submit", { runId: long.id });
    assert.equal(longReport.durationMs, 90 * 60000, "the report caps the time at this exam's limit, not at 30 minutes");

    const short = await service.call("review.start", { mode: "exam", count: 1, limitMinutes: 10, fresh: true });
    await startedMinutesAgo(service, short.id, 11);
    await assert.rejects(service.call("review.answer", { runId: short.id, cardId: short.card.id, selected: ["a"] }), /考试时间已到/);
    await assert.rejects(service.call("review.move", { runId: short.id, direction: 1 }), /考试时间已到/);
    assert.equal((await service.call("exam.submit", { runId: short.id })).durationMs, 10 * 60000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a limit outside 1–1440 whole minutes is refused instead of guessed", async () => {
  const { root, service } = await library();
  try {
    for (const limitMinutes of [0, -5, 1.5, 1441, "abc", ""])
      await assert.rejects(service.call("review.start", { mode: "exam", count: 1, limitMinutes, fresh: true }), /限时/, String(limitMinutes));
    const ok = await service.call("review.start", { mode: "exam", count: 1, limitMinutes: "45", fresh: true });
    assert.equal(ok.limitMs, 45 * 60000, "a number typed into a field arrives as text");
    const none = await service.call("review.start", { mode: "exam", count: 1, limitMinutes: null, fresh: true });
    assert.equal(none.limitMs, EXAM_LIMIT_MS, "null means: no choice, the default");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a run saved before the limit existed, and a case paper, keep their own rules", () => {
  assert.equal(examLimitMs({ startedAt: "2026-01-01T00:00:00Z" }), EXAM_LIMIT_MS);
  assert.equal(examLimitMs({ limitMs: 45 * 60000 }), 45 * 60000);
  assert.equal(examLimitMs({ limitMs: -1 }), EXAM_LIMIT_MS, "a damaged value falls back to the default");
  assert.equal(examLimitMs({ paper: { limitMs: 70 * 60000 }, limitMs: 5 }), 70 * 60000, "a case paper has its own limit");
  assert.equal(examLimitMs({ paper: { limitMs: null } }), null, "handwriting practice has none");
  const startedAt = new Date(Date.now() - 40 * 60000).toISOString();
  assert.equal(examExpired({ startedAt }), true);
  assert.equal(examExpired({ startedAt, limitMs: 60 * 60000 }), false);
});

test("the limit on the setup card comes from the course's 作答时间, else the default, and says which", () => {
  const data = { courses: [{ name: "CS5224", exam: { format: "open-book-case", writingMinutes: 120 } }, { name: "Databases", exam: { format: "closed-book" } },
    { name: "Broken", exam: { writingMinutes: 0 } }, { name: "Huge", exam: { writingMinutes: 5000 } }] };
  assert.deepEqual(defaultLimitMinutes(data, "CS5224"), { minutes: 120, source: "course" });
  assert.deepEqual(defaultLimitMinutes(data, "Databases"), { minutes: 30, source: "default" });
  assert.deepEqual(defaultLimitMinutes(data, "Broken"), { minutes: 30, source: "default" });
  assert.deepEqual(defaultLimitMinutes(data, "Huge"), { minutes: 30, source: "default" }, "more than a day is not an exam time");
  assert.deepEqual(defaultLimitMinutes(data, "*"), { minutes: 30, source: "default" }, "all courses: no single profile");
  assert.deepEqual(defaultLimitMinutes({}, "CS5224"), { minutes: 30, source: "default" });
  assert.deepEqual(LIMIT_MINUTES, { min: 1, max: 1440 });
});

test("the presets are a few round times and include the course's own", () => {
  assert.deepEqual(limitPresets(30), [15, 30, 45, 60]);
  assert.deepEqual(limitPresets(120), [15, 30, 45, 60, 120]);
  assert.deepEqual(limitPresets(20), [15, 20, 30, 45, 60]);
});
