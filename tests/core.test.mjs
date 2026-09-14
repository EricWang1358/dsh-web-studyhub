import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schedule, validateDeck, initialReview } from "../lib/domain.js";
import { StudyService } from "../lib/service.js";
import { Store } from "../lib/store.js";

export const source = {
  id: "s1",
  title: "Memento notes",
  text: "The Caretaker manages snapshot history without inspecting snapshot contents. The Originator creates snapshots. A Memento holds state.",
};
export const card = {
  id: "q1",
  kind: "quiz",
  topic: "Memento",
  objective: "Distinguish history ownership from snapshot storage",
  prompt:
    "Which component manages history without inspecting snapshot contents?",
  answer: "Caretaker",
  hint: "Separate the owner of history from a single stored snapshot.",
  explanation:
    "The Caretaker manages the collection while the Memento stores one state.",
  misconception: "Confusing a stored snapshot with the manager of its history.",
  citations: [
    {
      sourceId: "s1",
      quote:
        "The Caretaker manages snapshot history without inspecting snapshot contents.",
    },
  ],
  options: [
    {
      id: "a",
      text: "Caretaker",
      correct: true,
      explanation: "It manages the snapshot history.",
    },
    {
      id: "b",
      text: "Memento",
      correct: false,
      explanation:
        "This confuses a single stored state with the manager of history.",
    },
    {
      id: "c",
      text: "Originator",
      correct: false,
      explanation: "This confuses snapshot creation with history management.",
    },
  ],
};
export const deck = () => ({
  id: "d1",
  title: "Patterns Quiz",
  cards: [structuredClone(card)],
});

test("SM-2 matches upstream formula, failure resets, grade bounds", () => {
  let r = initialReview();
  const now = "2026-09-12T12:00:00.000Z";
  r = schedule(r, 5, now);
  assert.equal(r.interval_days, 1);
  assert.equal(r.ease_factor, 2.6);
  r = schedule(r, 4, now);
  assert.equal(r.interval_days, 6);
  r = schedule(r, 5, now);
  assert.equal(r.interval_days, 16);
  r = schedule(r, 0, now);
  assert.equal(r.repetitions, 0);
  assert.equal(r.interval_days, 1);
  assert.throws(() => schedule(r, 6, now));
});
test("quality gate rejects unsupported quotes, missing distractor reasoning and duplicate targets", () => {
  assert.deepEqual(validateDeck(deck(), [source]).errors, []);
  const d = deck();
  d.cards[0].citations[0].quote = "invented evidence";
  assert.match(validateDeck(d, [source]).errors.join(), /quote/i);
  d.cards[0].options[1].explanation = "";
  assert.match(validateDeck(d, [source]).errors.join(), /explanation/i);
  d.cards.push(structuredClone(d.cards[0]));
  assert.match(validateDeck(d, [source]).errors.join(), /duplicate/i);
});
test("persistent review: no answer leak, exact grading, idempotent submissions and concurrent writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-test-"));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const draft = await service.call("draft.save", { deck: deck() });
  await service.call("draft.publish", { id: draft.id });
  const run = await service.call("review.start", {
    deckId: "d1",
    mode: "quiz",
  });
  assert.ok(
    run.card.options.every(
      (o) => o.correct === undefined && o.explanation === undefined,
    ),
  );
  assert.equal(run.card.answer, undefined);
  assert.equal(run.solution, undefined);
  const responses = await Promise.all(
    [1, 2].map(() =>
      service.call("review.answer", {
        runId: run.id,
        cardId: "q1",
        selected: ["b"],
      }),
    ),
  );
  assert.equal(responses[0].feedback.correct, false);
  const state = await new Store(root).read();
  assert.equal(state.attempts.length, 1);
  assert.equal(state.decks[0].cards[0].review.repetitions, 0);
  await assert.rejects(
    () =>
      service.call("review.answer", {
        runId: run.id,
        cardId: "q1",
        selected: ["a"],
      }),
    /already|different/i,
  );
  const reloaded = new StudyService(root);
  assert.equal((await reloaded.call("snapshot")).attempts.length, 1);
});
