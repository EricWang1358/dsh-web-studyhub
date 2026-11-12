import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

test("current course persists and its newest deck supplies one round of fresh cards (the round size, ten here)", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-focus-"));
  const service = new StudyService(root);
  await service.store.update((state) => {
    const make = (prefix, count) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`, kind: "flashcard", topic: "topic", prompt: `${prefix}-${index}`,
      answer: "answer", objective: "objective", hint: "hint", explanation: "explanation",
      misconception: "misconception", citations: [], options: [], requires: [],
      review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
    }));
    state.decks.push({ id: "old", title: "Old", folder: "Platform Engineering", createdAt: "2026-09-01", cards: make("old", 15) });
    state.decks.push({ id: "new", title: "New", folder: "Platform Engineering", createdAt: "2026-09-25", cards: make("new", 15) });
    state.decks.push({ id: "other", title: "Other", folder: "Architecture", createdAt: "2026-09-26", cards: make("other", 15) });
    // The home's new-question round is the round size of 设置 › 练习 (#1009).
    state.settings = { ...state.settings, practice: { roundSize: 10 } };
  });
  await service.call("focus.set", { course: "Platform Engineering" });
  const restored = new StudyService(root);
  const snapshot = await restored.call("snapshot");
  assert.equal(snapshot.focus.course, "Platform Engineering");
  assert.equal(snapshot.focus.fresh.length, 10);
  assert.ok(snapshot.focus.fresh.every((entry) => entry.deckId === "new"));
  const run = await restored.call("review.start", { mode: "new", currentCourse: true, count: 10, fresh: true });
  assert.equal(run.total, 10);
  const state = await restored.call("export");
  assert.ok(state.runs.at(-1).entries.every((entry) => entry.deckId === "new"));
  await restored.call("focus.set", { course: "Architecture" });
  const next = await restored.call("review.start", { mode: "new", scope: state.runs.at(-1).scope,
    count: 10, fresh: true });
  assert.equal(next.total, 10);
  assert.ok((await restored.call("export")).runs.at(-1).entries.every((entry) => entry.deckId === "new"));
});

test("job description proposes only existing topics and saves onto an interview course while global interview mode is retired", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-role-"));
  const service = new StudyService(root, { complete: async () =>
    JSON.stringify({ role: "Platform engineer", targetTopics: ["Capacity", "Invented"] }) });
  await service.store.update((state) => {
    state.decks.push({ id: "deck", title: "Platform", course: "笔试 / 面试", cards: [{ id: "card", topic: "Capacity",
      prompt: "Question", review: { repetitions: 0, interval_days: 0, due_at: null } }] });
  });
  const proposal = await service.call("focus.suggest", { role: "Engineer", jd: "Capacity planning" });
  assert.deepEqual(proposal.targetTopics, ["Capacity"]);
  assert.equal((await service.call("snapshot")).focus.role, "", "suggestion does not silently change the focus");
  await assert.rejects(() => service.call("focus.set", { mode: "interview" }), /课程|course/i);
  await service.call("course.save", {
    name: "笔试 / 面试",
    interview: { role: proposal.role, jd: proposal.jd },
    focusTopics: proposal.targetTopics,
  });
  await service.call("focus.set", { course: "笔试 / 面试" });
  const snapshot = await new StudyService(root).call("snapshot");
  const course = snapshot.courses.find((item) => item.name === "笔试 / 面试");
  assert.equal(course.interview.role, "Platform engineer");
  assert.equal(snapshot.focus.role, "Platform engineer");
  assert.equal(snapshot.focus.roleWeak[0].topic, "Capacity");
});
