import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyService } from "../lib/service.js";
import { importExample } from "../ui/json-prompts.js";
import { mergeReviewPoll, reviewEntryKey } from "../ui/async.js";
import { loadUi } from "./helpers/ui-module.mjs";

test("background review results belong to an entry and revision, not just a run", () => {
  const run = { id: "r", index: 0, card: { id: "q" }, queueVersion: 0, revision: 0 };
  assert.equal(reviewEntryKey(run), reviewEntryKey({ ...run, coach: [] }));
  for (const patch of [{ id: "other" }, { index: 1 }, { card: { id: "other" } }, { queueVersion: 1 }, { revision: 1 }])
    assert.notEqual(reviewEntryKey(run), reviewEntryKey({ ...run, ...patch }));
  assert.equal(reviewEntryKey(null), "");
});

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

test("a closed run poll preserves completion together with its empty card", () => {
  const current = { id: "r", index: 0, card: { id: "q" }, complete: false };
  const next = { ...current, card: null, closed: true, complete: true };
  assert.equal(mergeReviewPoll(current, next), next);
});

test("ReviewNavigator highlights skipped unanswered ticks and clears them once answered (#5)", async () => {
  const { default: ReviewNavigator } = await loadUi("export { default } from './ui/ReviewNavigator.jsx';");
  const navigation = [
    { index: 0, answered: false, correct: null, level: "new", kind: "quiz", prompt: "First?", topic: "T1" },
    { index: 1, answered: true, correct: true, level: "learning", kind: "quiz", prompt: "Second?", topic: "T2" },
    { index: 2, answered: false, correct: null, level: "new", kind: "quiz", prompt: "Third?", topic: "T3" },
  ];
  const html = renderToStaticMarkup(React.createElement(ReviewNavigator, {
    run: { id: "r", index: 2, navigation }, skippedIndices: new Set([0, 1]), onJump() {},
  }));
  const ticks = [...html.matchAll(/<button[^>]*class="review-tick\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(ticks.length, 3);
  assert.match(ticks[0], /data-skipped="true"/, "skipped unanswered tick gets data-skipped");
  assert.match(ticks[0], /aria-label="[^"]*先跳过待答"/, "skipped unanswered label notes skip state");
  assert.doesNotMatch(ticks[1], /data-skipped=/, "answered question does not render skipped marker");
  assert.doesNotMatch(ticks[2], /data-skipped=/, "unskipped unanswered question stays regular");
});
