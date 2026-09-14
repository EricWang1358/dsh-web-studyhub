import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { importExample } from "../ui/json-prompts.js";
import { mergeReviewPoll } from "../ui/async.js";

test("review navigator tracks mastery, jumps without grading, and returns to skipped questions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-navigation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const example = JSON.parse(importExample("flashcard"));
  example.cards = Array.from({ length: 3 }, (_, i) => ({ ...example.cards[0], id: `q${i}`, objective: `Objective ${i}`, prompt: `Question ${i}?` }));
  const draft = await service.call("draft.import", { text: JSON.stringify(example) });
  await service.call("draft.publish", { id: draft.id });
  let run = await service.call("review.start", { deckId: draft.id, mode: "flashcard" });
  assert.deepEqual(run.navigation.map((x) => x.level), ["new", "new", "new"]);
  assert.ok(run.navigation.every((x) => !x.answered && !Object.hasOwn(x, "answer")));
  const args = { runId: run.id };
  await assert.rejects(service.call("review.move", { ...args, index: 3 }), /index/i);
  run = await service.call("review.move", { ...args, index: 2 });
  assert.equal(run.index, 2);
  assert.equal(run.answered, 0);
  await service.call("review.reveal", { ...args, cardId: run.card.id });
  run = await service.call("review.answer", { ...args, cardId: run.card.id, grade: 4 });
  assert.equal(run.navigation[2].level, "learning");
  assert.equal(run.navigation[2].answered, true);
  run = await service.call("review.move", { ...args, direction: 1 });
  assert.equal(run.index, 0);
  assert.equal(run.complete, false);
  assert.equal((await service.call("review.get", args)).navigation[2].level, "learning");
});

test("review polling refreshes navigation even when the current card is unchanged", () => {
  const current = { id: "r", index: 0, navigation: [{ level: "new" }] };
  const next = { ...current, navigation: [{ level: "weak" }] };
  assert.deepEqual(mergeReviewPoll(current, next).navigation, next.navigation);
});

