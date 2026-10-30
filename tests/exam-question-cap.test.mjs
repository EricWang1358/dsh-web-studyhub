import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { EXAM_QUESTION_COUNT, QUESTION_COUNT, isExamQuestionCount, isQuestionCount } from "../lib/limits.js";

/* #497: a mock exam can take a whole paper (100 questions and more) in one sitting, while a practice step and a course
   batch keep the 50 that sets the pace of one sitting. */

const source = { id: "s1", title: "Memento notes", text: "The Caretaker manages snapshot history without inspecting snapshot contents." };
const quiz = (id, topic) => ({
  id, kind: "quiz", topic, objective: `Explain ${topic} precisely`, prompt: `Which component owns the ${topic} responsibility?`,
  answer: "Caretaker", hint: "Separate ownership from storage.", explanation: "The Caretaker manages the history.", misconception: "Confusing storage with management.",
  citations: [{ sourceId: "s1", quote: "The Caretaker manages snapshot history without inspecting snapshot contents." }],
  options: [{ id: "a", text: "Caretaker", correct: true, explanation: "It manages history." }, { id: "b", text: "Memento", correct: false, explanation: "It stores one state." },
    { id: "c", text: "Originator", correct: false, explanation: "It creates snapshots." }],
});

test("the exam limit is its own: a whole paper fits, a practice step still stops at 50", () => {
  assert.deepEqual({ ...EXAM_QUESTION_COUNT }, { min: 1, max: 200 });
  assert.ok(Object.isFrozen(EXAM_QUESTION_COUNT));
  assert.deepEqual({ ...QUESTION_COUNT }, { min: 1, max: 50 }, "practice steps and course batches are unchanged");
  for (const count of [1, 50, 100, 200]) assert.equal(isExamQuestionCount(count), true, String(count));
  for (const count of [0, 201, 2.5, "100"]) assert.equal(isExamQuestionCount(count), false, String(count));
  assert.equal(isQuestionCount(100), false);
});

test("every exam entry reads the exam limit; practice and course batches keep the practice limit", async () => {
  const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  for (const path of ["lib/contexts/study/operations.js", "lib/course-book-crunch.js", "ui/exam/WrittenSetup.jsx", "ui/exam/exam-written.js", "ui/book/MockPaper.jsx", "ui/ExamShell.jsx"])
    assert.match(await read(path), /EXAM_QUESTION_COUNT/, path);
  for (const path of ["lib/workflows.js", "lib/study-state.js", "ui/Workflows.jsx"])
    assert.doesNotMatch(await read(path), /EXAM_QUESTION_COUNT/, path);
});

test("a written exam of 100 questions starts with all 100, and 201 is refused with the limit in the message", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-exam-cap-"));
  try {
    const service = new StudyService(root);
    await service.call("source.add", source);
    const cards = Array.from({ length: 120 }, (_, i) => quiz(`q${i}`, `Responsibility ${i}`));
    await service.call("draft.save", { deck: { id: "d1", title: "Patterns", cards } });
    const published = await service.call("draft.publish", { id: "d1" });
    assert.equal(published.accepted ?? cards.length, cards.length, JSON.stringify(published).slice(0, 300));
    const run = await service.call("review.start", { mode: "exam", count: 100 });
    assert.equal(run.total ?? run.cards?.length ?? run.queue?.length, 100);
    await assert.rejects(service.call("review.start", { mode: "exam", count: 201, fresh: true }), /1–200 exam questions/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
