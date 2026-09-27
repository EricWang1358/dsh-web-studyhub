import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

test("current course persists and its newest deck supplies only ten fresh cards", async () => {
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

test("job description proposes only existing topics and keeps confirmation in user control", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-role-"));
  const service = new StudyService(root, { complete: async () =>
    JSON.stringify({ role: "Platform engineer", targetTopics: ["Capacity", "Invented"] }) });
  await service.store.update((state) => {
    state.decks.push({ id: "deck", title: "Platform", cards: [{ id: "card", topic: "Capacity",
      prompt: "Question", review: { repetitions: 0, interval_days: 0, due_at: null } }] });
  });
  const proposal = await service.call("focus.suggest", { role: "Engineer", jd: "Capacity planning" });
  assert.deepEqual(proposal.targetTopics, ["Capacity"]);
  assert.equal((await service.call("snapshot")).focus.role, "", "suggestion does not silently change the focus");
  await service.call("focus.set", { mode: "interview", role: proposal.role, jd: proposal.jd,
    targetTopics: proposal.targetTopics });
  const focus = (await new StudyService(root).call("snapshot")).focus;
  assert.equal(focus.role, "Platform engineer");
  assert.equal(focus.roleWeak[0].topic, "Capacity");
});
