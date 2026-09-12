import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyService } from "../lib/service.js";
import { Store } from "../lib/store.js";
import { createHostHandler } from "../lib/host.js";
import { generateDeck } from "../lib/generation.js";

const fresh = () => mkdtemp(join(tmpdir(), "study-integration-"));
const source = {
  id: "s",
  title: "Bridge",
  text: "Bridge separates an abstraction from its implementation so the two can vary independently.",
};
const q = {
  id: "q",
  kind: "flashcard",
  topic: "Bridge",
  objective: "Identify independent variation",
  prompt: "Why use Bridge for reports and renderers?",
  answer: "Separate independent dimensions.",
  hint: "Think about two independent reasons to change.",
  explanation: "Report types and rendering backends vary independently.",
  misconception:
    "Adding a subclass for every combination causes a cross product.",
  citations: [{ sourceId: "s", quote: source.text }],
};
const deck = () => ({
  id: "d",
  title: "Patterns Flashcards",
  cards: [structuredClone(q)],
});
async function ready() {
  const service = new StudyService(await fresh());
  await service.call("source.add", source);
  await service.call("draft.save", { deck: deck() });
  await service.call("draft.publish", { id: "d" });
  return service;
}

test("failed transaction leaves last committed state byte-for-byte unchanged", async () => {
  const store = new Store(await fresh());
  await store.update((s) => s.sources.push(source));
  const before = await readFile(store.path, "utf8");
  await assert.rejects(() =>
    store.update((s) => {
      s.sources = [];
      throw new Error("simulated failure");
    }),
  );
  assert.equal(await readFile(store.path, "utf8"), before);
});
test("two Store instances serialize concurrent writers", async () => {
  const root = await fresh(),
    stores = [new Store(root), new Store(root)];
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      stores[i % 2].update((s) => {
        s.attempts.push({ id: i });
      }),
    ),
  );
  assert.equal((await stores[0].read()).attempts.length, 12);
});
test("flashcard reveal required, grading once, due queue, completion and resume", async () => {
  const service = await ready(),
    run = await service.call("review.start", {
      deckId: "d",
      mode: "flashcard",
    });
  await assert.rejects(
    () =>
      service.call("review.answer", { runId: run.id, cardId: "q", grade: 5 }),
    /Reveal/,
  );
  const revealed = await service.call("review.reveal", {
    runId: run.id,
    cardId: "q",
  });
  assert.equal(revealed.solution.answer, q.answer);
  await assert.rejects(
    () =>
      service.call("review.answer", { runId: run.id, cardId: "q", grade: -1 }),
    /Grade/,
  );
  const graded = await service.call("review.answer", {
    runId: run.id,
    cardId: "q",
    grade: 5,
  });
  assert.equal(graded.feedback.grade, 5);
  const resumed = await new StudyService(service.store.root).call(
    "review.get",
    { runId: run.id },
  );
  assert.deepEqual(resumed, graded);
  assert.equal(
    (await service.call("review.move", { runId: run.id, direction: 1 }))
      .complete,
    true,
  );
  await assert.rejects(
    () => service.call("review.start", { deckId: "d", mode: "due" }),
    /No questions/,
  );
  await assert.rejects(
    () => service.call("source.remove", { id: "s" }),
    /referenced/,
  );
});
test("multi-select requires exact set and input validation does not mutate attempts", async () => {
  const service = new StudyService(await fresh());
  await service.call("source.add", source);
  const d = deck();
  d.cards[0] = {
    ...q,
    kind: "multi",
    options: [
      {
        id: "a",
        text: "Independent report type",
        correct: true,
        explanation: "Abstraction dimension.",
      },
      {
        id: "b",
        text: "Independent backend",
        correct: true,
        explanation: "Implementation dimension.",
      },
      {
        id: "c",
        text: "Subclass all combinations",
        correct: false,
        explanation: "This preserves combinatorial growth.",
      },
    ],
  };
  await service.call("draft.save", { deck: d });
  await service.call("draft.publish", { id: "d" });
  const r = await service.call("review.start", { deckId: "d", mode: "quiz" });
  await assert.rejects(() =>
    service.call("review.answer", {
      runId: r.id,
      cardId: "q",
      selected: ["unknown"],
    }),
  );
  const answer = await service.call("review.answer", {
    runId: r.id,
    cardId: "q",
    selected: ["a"],
  });
  assert.equal(answer.feedback.correct, false);
  assert.equal((await service.call("export")).attempts.length, 1);
});
test("authenticated host resolves workspace from session, explicit binding and invalid session denial", async () => {
  const cwd = await fresh(),
    root = await fresh();
  const ctx = {
    sessions: {
      get: (id) => (id === "session" ? { header: { cwd } } : undefined),
    },
  };
  const handler = createHostHandler(ctx);
  assert.equal(
    (await handler("call", { sessionId: "bad", action: "snapshot" })).ok,
    false,
  );
  assert.equal(
    (
      await handler("call", {
        sessionId: "session",
        action: "snapshot",
        args: { root },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await handler("call", {
        sessionId: "session",
        action: "binding.set",
        args: { root },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await handler("call", { sessionId: "session", action: "snapshot" })).value
      .root,
    root,
  );
});
test("legacy import preserves original files and scheduling, repeated import is idempotent", async () => {
  const root = await fresh();
  await mkdir(join(root, "quizzes"));
  await writeFile(join(root, "study-lib.json"), "{}");
  const content =
    "---\nid: bridge\ntitle: Bridge\nsummary: Independent variation\nreview:\n  repetitions: 2\n  interval_days: 6\n  ease_factor: 2.6\n  due_at: 2026-12-01T00:00:00Z\n---\n\n## Prompt\nWhat does Bridge separate?\n\n## Answer\nAbstraction and implementation.\n\n## Hint\nThink of independent dimensions.\n\n## Explanation\nThey vary independently.\n\n## Common Mistake\nSubclass all combinations.\n";
  const file = join(root, "quizzes", "bridge.md");
  await writeFile(file, content);
  const service = new StudyService(await fresh());
  const imported = await service.call("legacy.import", { path: root });
  assert.equal(imported.count, 1);
  const state = await service.call("export");
  assert.equal(state.decks[0].cards[0].review.repetitions, 2);
  assert.equal(state.decks[0].cards[0].prompt, "What does Bridge separate?");
  assert.equal(await readFile(file, "utf8"), content);
  assert.equal(
    (await service.call("legacy.import", { path: root })).reused,
    true,
  );
});
test("generation uses author and editor; broken citation is repaired before draft acceptance", async () => {
  let calls = 0;
  const bad = deck();
  bad.cards[0].citations[0].quote = "fabricated quote";
  const result = await generateDeck(
    async () =>
      JSON.stringify(
        [bad, { issues: ["unsupported quote"] }, deck(), { issues: [] }][
          calls++
        ],
      ),
    { count: 1, kind: "flashcard", sources: [source] },
  );
  assert.equal(calls, 4);
  assert.equal(result.editorial.repaired, true);
  assert.notEqual(result.id, "d");
});
test("generation refuses persistent editorial defects", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      generateDeck(
        async () =>
          JSON.stringify(
            [
              deck(),
              { issues: ["ambiguous"] },
              deck(),
              { issues: ["still ambiguous"] },
            ][calls++],
          ),
        { count: 1, kind: "flashcard", sources: [source] },
      ),
    /still found issues/,
  );
});
test("generation rejects wrong question kind even when model editor approves", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      generateDeck(
        async () => JSON.stringify([deck(), { issues: [] }, deck()][calls++]),
        { count: 1, kind: "quiz", sources: [source] },
      ),
    /requested kind/,
  );
  assert.equal(calls, 3);
});
test("teaching stores conclusions only and cannot advance a failed check or add SM2 attempts", async () => {
  const service = await ready();
  let responses = [
    {
      diagnosis: "variation",
      rungs: [
        { lesson: "Separate dimensions", check: "How many?", answer: "two" },
        {
          lesson: "Independent hierarchy",
          check: "Why?",
          answer: "change independently",
        },
      ],
      transfer: "Separate independent axes",
    },
    { passed: false, feedback: "Count both axes." },
    { passed: true, feedback: "Yes." },
  ];
  service.complete = async () => JSON.stringify(responses.shift());
  const run = await service.call("review.start", {
    deckId: "d",
    mode: "flashcard",
  });
  await service.call("review.reveal", { runId: run.id, cardId: "q" });
  await service.call("review.answer", { runId: run.id, cardId: "q", grade: 0 });
  const teaching = await service.call("teach.start", { runId: run.id });
  assert.equal(teaching.index, 0);
  assert.equal(teaching.answer, undefined);
  assert.equal(
    (
      await service.call("teach.answer", {
        id: teaching.id,
        answer: "SECRET_WRONG_ANSWER",
      })
    ).index,
    0,
  );
  assert.equal(
    (await service.call("teach.answer", { id: teaching.id, answer: "two" }))
      .index,
    1,
  );
  const state = await service.call("export");
  assert.equal(state.attempts.length, 1);
  assert.equal(JSON.stringify(state).includes("SECRET_WRONG_ANSWER"), false);
});
