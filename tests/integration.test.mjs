import { withQualityStages } from "./helpers/assessment.mjs";
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

test("generation messages report delivery honestly and survive into later model stages", async () => {
  let release, started;
  const gate = new Promise((resolve) => release = resolve);
  const beginning = new Promise((resolve) => started = resolve);
  const prompts = [], deliveries = [];
  const complete = withQualityStages(async (system) => JSON.stringify(
    system.startsWith("You author") ? deck() : { issues: [], summary: "Checked" }));
  const service = new StudyService(await fresh(), { complete: async (system, prompt, execution) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      execution.setMessenger(async (text) => { deliveries.push(text); return { childId: "test-child", messageId: "accepted" }; });
      started(); await gate;
    }
    return complete(system, prompt.split("\n\nAdditional learner requirements")[0]);
  } });
  await service.call("source.add", source);
  const job = await service.call("generate", { sourceIds: ["s"], count: 1, kind: "flashcard" });
  await beginning;
  try {
    const receipt = await service.call("job.message", { jobId: job.jobId, message: "Use concise Chinese questions" });
    assert.equal(receipt.delivery, "delivered");
    assert.equal(receipt.childId, "test-child");
    assert.deepEqual(deliveries, ["Use concise Chinese questions"]);
  } finally { release(); }
  const result = await service.call("job.wait", { jobId: job.jobId });
  assert.equal(result.status, "complete");
  assert.ok(prompts.slice(1).every((p) => p.includes("Use concise Chinese questions")));
  await assert.rejects(service.call("job.message", { jobId: job.jobId, message: "Too late" }), /Active generation job/);
});

test("parallel jobs persist early drafts and broadcast to each active worker without losing other handles", { timeout: 10000 }, async () => {
  const root = await fresh(), releases = [];
  let started, checkpointed, counter = 0;
  const readyWorkers = new Promise((resolve) => started = resolve);
  const firstSave = new Promise((resolve) => checkpointed = resolve);
  const fixture = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const req = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "Parallel", cards: Array.from({ length: req.count }, () => {
      const n = ++counter;
      return { ...structuredClone(q), id: `q${n}`, prompt: `Distinct question ${n}?`, objective: `Objective ${n}` };
    }) });
  });
  const service = new StudyService(root, { complete: async (system, prompt, execution) => {
    if (system.startsWith("You author")) {
      const childId = `child-${releases.length}`;
      execution.setMessenger(async () => ({ childId, messageId: `receipt-${childId}` }));
      await new Promise((resolve) => { releases.push(resolve); if (releases.length === 3) started(); });
    }
    return fixture(system, prompt.split("\n\nAdditional learner requirements")[0]);
  } });
  const originalCall = service.call.bind(service);
  service.call = async (action, args) => {
    const result = await originalCall(action, args);
    if (action === "draft.save") checkpointed(result);
    return result;
  };
  await service.call("source.add", source);
  const job = await service.call("generate", { sourceIds: ["s"], count: 11, kind: "flashcard" });
  let early;
  try {
    await readyWorkers;
    const sent = await service.call("job.message", { jobId: job.jobId, message: "Keep each question focused" });
    assert.equal(sent.receipts.length, 3);
    assert.ok(sent.receipts.every((receipt) => receipt.delivered));
    releases[0](); early = await firstSave;
    assert.ok(early.cards.length > 0 && early.cards.length < 11);
    const persisted = await new StudyService(root).call("export");
    assert.equal(persisted.drafts[0].id, early.id);
    assert.equal(persisted.drafts[0].cards.length, early.cards.length);
    const sentAgain = await service.call("job.message", { jobId: job.jobId, message: "Use neutral hints" });
    assert.equal(sentAgain.receipts.length, 2);
    await assert.rejects(service.call("draft.publish", { id: early.id }), /still updating/);
  } finally { releases.forEach((release) => release()); }
  const done = await service.call("job.wait", { jobId: job.jobId });
  assert.equal(done.status, "complete");
  assert.equal(done.draftId, early.id);
  assert.equal(done.draft.cards, 11);
});

test("self-grades 0 and 1 append one hidden tail retry, persist on resume and preserve spacing", async () => {
  for (const grade of [0, 1]) {
    const service = await ready();
    const editing = await service.call("deck.edit", { id: "d" });
    editing.cards.push({ ...structuredClone(q), id: "q2", prompt: "What dimensions vary?", objective: "Name the dimensions" });
    const saved = await service.call("draft.save", { deck: editing });
    await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
    let run = await service.call("review.start", { deckId: "d", mode: "flashcard" });
    const cardId = run.card.id, args = { runId: run.id, cardId };
    await service.call("review.reveal", args);
    run = await service.call("review.answer", { ...args, grade });
    assert.equal(run.total, 3);
    assert.equal(run.feedback.retryQueued, true);
    assert.equal((await service.call("review.answer", { ...args, grade })).total, 3);
    const due = run.feedback.nextDue;
    run = await service.call("review.move", { runId: run.id, direction: 1 });
    assert.notEqual(run.card.id, cardId);
    await service.call("review.reveal", { runId: run.id, cardId: run.card.id });
    await service.call("review.answer", { runId: run.id, cardId: run.card.id, grade: 4 });
    run = await service.call("review.move", { runId: run.id, direction: 1 });
    run = await service.call("review.start", { deckId: "d", mode: "flashcard" });
    assert.equal(run.card.id, cardId);
    assert.equal(run.retry, true);
    assert.equal(run.revealed, false);
    assert.equal(run.feedback, null);
    await service.call("review.reveal", args);
    await assert.rejects(service.call("review.answer", { ...args, grade: 8 }), /Grade/);
    run = await service.call("review.answer", { ...args, grade: grade === 0 ? 0 : 5 });
    assert.equal(run.total, 3);
    assert.equal(run.feedback.nextDue, due);
    assert.equal((await service.call("review.move", { runId: run.id, direction: 1 })).complete, true);
  }
});

test("deck maintenance preserves unchanged scheduling, resets edited content, and fences concurrent drafts", async () => {
  const service = await ready();
  const run = await service.call("review.start", {
    deckId: "d",
    mode: "flashcard",
  });
  await service.call("review.reveal", { runId: run.id, cardId: "q" });
  await service.call("review.answer", { runId: run.id, cardId: "q", grade: 4 });
  const before = await service.call("deck.get", { id: "d" });
  const draft = await service.call("deck.edit", { id: "d" });
  assert.equal((await service.call("deck.edit", { id: "d" })).id, draft.id);
  await assert.rejects(
    service.call("draft.publish", { id: draft.id }),
    /active reviews/,
  );
  await service.call("review.end", { runId: run.id });
  draft.title = "Renamed";
  const saved = await service.call("draft.save", { deck: draft });
  await assert.rejects(
    service.call("draft.save", { deck: draft }),
    /another window/,
  );
  await assert.rejects(
    service.call("draft.publish", {
      id: saved.id,
      draftVersion: draft.draftVersion,
    }),
    /another window/,
  );
  await assert.rejects(
    service.call("draft.delete", {
      id: saved.id,
      draftVersion: draft.draftVersion,
    }),
    /another window/,
  );
  await service.call("draft.publish", { id: saved.id });
  const unchanged = await service.call("deck.get", { id: "d" });
  assert.equal(unchanged.id, "d");
  assert.equal(unchanged.title, "Renamed");
  assert.deepEqual(unchanged.cards[0].review, before.cards[0].review);
  const edit = await service.call("deck.edit", { id: "d" });
  edit.cards[0].prompt += " Explain both dimensions.";
  await service.call("draft.save", { deck: edit });
  await service.call("draft.publish", { id: edit.id });
  assert.equal(
    (await service.call("deck.get", { id: "d" })).cards[0].review.repetitions,
    0,
  );
  assert.equal((await service.call("export")).attempts.length, 1);
  const historical = await service.call("review.get", { runId: run.id });
  assert.equal(historical.closed, true);
  await assert.rejects(
    service.call("review.answer", { runId: run.id, cardId: "q", grade: 4 }),
    /ended/,
  );
});

test("wrong queue uses latest outcome; archive and suspension have reversible lifecycle", async () => {
  const service = await ready();
  let run = await service.call("review.start", {
    deckId: "d",
    mode: "flashcard",
  });
  await service.call("review.reveal", { runId: run.id, cardId: "q" });
  await service.call("review.answer", { runId: run.id, cardId: "q", grade: 1 });
  await service.call("review.end", { runId: run.id });
  assert.equal((await service.call("snapshot")).decks[0].wrong, 1);
  run = await service.call("review.start", { deckId: "d", mode: "wrong" });
  await service.call("deck.archive", { id: "d", archived: true });
  assert.equal((await service.call("snapshot")).runs.length, 0);
  await assert.rejects(
    service.call("review.start", { deckId: "d", mode: "wrong" }),
    /archived/,
  );
  await service.call("deck.archive", { id: "d", archived: false });
  await service.call("card.suspend", {
    deckId: "d",
    cardId: "q",
    suspended: true,
  });
  await assert.rejects(
    service.call("review.start", { deckId: "d", mode: "wrong" }),
    /No questions/,
  );
  await service.call("card.suspend", {
    deckId: "d",
    cardId: "q",
    suspended: false,
  });
  run = await service.call("review.start", { deckId: "d", mode: "wrong" });
  await service.call("review.reveal", { runId: run.id, cardId: "q" });
  await service.call("review.answer", { runId: run.id, cardId: "q", grade: 5 });
  assert.equal((await service.call("snapshot")).decks[0].wrong, 0);
});

test("review reads are side-effect free and teaching resumes without exposing scoring reference", async () => {
  const service = await ready();
  const run = await service.call("review.start", {
    deckId: "d",
    mode: "flashcard",
  });
  const before = await readFile(service.store.path, "utf8");
  await service.call("review.get", { runId: run.id });
  assert.equal(await readFile(service.store.path, "utf8"), before);
  await service.call("review.reveal", { runId: run.id, cardId: "q" });
  await service.call("review.answer", { runId: run.id, cardId: "q", grade: 1 });
  let calls = 0;
  service.complete = async () => {
    calls++;
    return JSON.stringify({
      diagnosis: "gap",
      transfer: "rule",
      rungs: [1, 2].map(() => ({
        lesson: "relationship",
        check: "why?",
        answer: "secret reference",
      })),
    });
  };
  const t = await service.call("teach.start", { runId: run.id });
  assert.equal((await service.call("teach.start", { runId: run.id })).id, t.id);
  assert.equal(calls, 1);
  const restarted = new StudyService(service.store.root);
  assert.equal(
    (await restarted.call("review.get", { runId: run.id })).teaching.id,
    t.id,
  );
  assert.ok(
    !JSON.stringify(await restarted.call("teach.get", { id: t.id })).includes(
      "secret reference",
    ),
  );
});

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
    ).value.root,
    join(cwd, ".dsh-study"),
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
test("binding defaults to the session workspace and follows the session model until overridden", async () => {
  const cwd = await fresh(),
    other = await fresh();
  const events = [
    {
      type: "request/header",
      data: { header: { config: { provider: "ds", model: "v4-flash" } } },
    },
    { type: "model/selection", data: { provider: "ds", model: "v4-pro" } },
  ];
  const session = {
    header: { cwd },
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
  };
  const routes = [];
  const handler = createHostHandler(
    {
      sessions: { get: (id) => (id === "s" ? session : undefined) },
      get: (name) =>
        name === "agentDefaultModel"
          ? { currentSelection: () => ({ provider: "ds", model: "default" }) }
          : undefined,
    },
    {},
    (route) => async () => {
      routes.push(route());
      return "{}";
    },
  );
  const run = async (action, args) =>
    (await handler("call", { sessionId: "s", action, args })).value;
  let b = await run("binding.get");
  assert.equal(b.root, join(cwd, ".dsh-study"));
  assert.equal(b.rootSource, "workspace");
  assert.equal(b.modelSource, "session");
  assert.deepEqual(b.route, { provider: "ds", model: "v4-pro" });
  assert.equal((await run("snapshot")).modelReady, true);
  events.length = 0;
  assert.deepEqual((await run("binding.get")).route, {
    provider: "ds",
    model: "default",
  });
  b = await run("binding.set", { root: other, provider: "x", model: "y" });
  assert.equal(b.rootSource, "custom");
  assert.equal(b.modelSource, "custom");
  assert.deepEqual(b.route, { provider: "x", model: "y" });
  assert.equal((await run("snapshot")).root, other);
  b = await run("binding.set", { root: "", provider: "", model: "" });
  assert.equal(b.root, join(cwd, ".dsh-study"));
  assert.equal(b.modelSource, "session");
  assert.equal(
    (await handler("call", {
      sessionId: "s",
      action: "binding.set",
      args: { provider: "x" },
    })).ok,
    false,
  );
  await writeFile(join(cwd, "study-workspace.json"), "");
  assert.equal((await run("binding.get")).root, cwd);
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
    withQualityStages(async () =>
      JSON.stringify(
        [bad, { issues: ["unsupported quote"] }, deck(), { issues: [] }][calls++],
      )),
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
        withQualityStages(async () =>
          JSON.stringify(
            [deck(), { issues: ["ambiguous"] }, deck(), { issues: ["still ambiguous"] }][calls++],
          )),
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
        withQualityStages(async () => JSON.stringify([deck(), { issues: [] }, deck()][calls++])),
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
test("learning path orders weak before new in syllabus order, resumes the same scope and tracks mastery across decks", async () => {
  const service = new StudyService(await fresh());
  await service.call("source.add", source);
  const card = (id, topic) => ({
    ...structuredClone(q),
    id,
    topic,
    objective: `${q.objective} ${id}`,
    prompt: `${q.prompt} ${id}`,
  });
  const publish = async (id, cards) => {
    await service.call("draft.save", { deck: { id, title: id, cards } });
    await service.call("draft.publish", { id });
  };
  await publish("a", [card("a1", "Intro"), card("a2", "Intro"), card("a3", "Advanced")]);
  await publish("b", [card("b1", "Other")]);
  let map = await service.call("map");
  assert.deepEqual(map.today, { due: 0, weak: 0, new: 4, size: 4, ahead: false });
  assert.deepEqual(map.next, { deckId: "a", deckTitle: "a", topic: "Intro", mastery: 0 });
  const run = await service.call("review.start", { mode: "path" });
  assert.equal(run.title, "今日学习");
  assert.equal(run.card.id, "a1");
  assert.equal((await service.call("review.start", { mode: "path" })).id, run.id);
  await service.call("review.reveal", { runId: run.id, cardId: "a1" });
  await service.call("review.answer", { runId: run.id, cardId: "a1", grade: 1 });
  await service.call("review.move", { runId: run.id, direction: 1 });
  await service.call("review.reveal", { runId: run.id, cardId: "a2" });
  await service.call("review.answer", { runId: run.id, cardId: "a2", grade: 5 });
  map = await service.call("map");
  const a = map.decks.find((d) => d.id === "a");
  assert.equal(a.counts.weak, 1);
  assert.equal(a.counts.learning, 1);
  assert.equal(a.topics[0].name, "Intro");
  assert.equal(a.topics[0].status, "active");
  assert.equal(map.today.weak, 1);
  const again = await service.call("review.start", { mode: "path", fresh: true });
  assert.notEqual(again.id, run.id);
  assert.equal(again.card.id, "a1");
  assert.equal((await service.call("snapshot")).runs.length, 1);
  await service.call("review.end", { runId: again.id });
  const topic = await service.call("review.start", {
    mode: "path",
    scope: [{ deckId: "b", topic: "Other" }],
  });
  assert.equal(topic.total, 1);
  assert.equal(topic.title, "b › Other");
  await service.call("review.reveal", { runId: topic.id, cardId: "b1" });
  await service.call("review.answer", { runId: topic.id, cardId: "b1", grade: 4 });
  assert.equal((await service.call("export")).attempts.at(-1).deckId, "b");
  await assert.rejects(
    service.call("review.start", { mode: "path", scope: [{ deckId: "missing" }] }),
    /Deck not found/,
  );
  await service.call("deck.move", { id: "a", folder: " 设计模式 / 第 4 章 " });
  assert.equal((await service.call("map")).decks[0].folder, "设计模式 / 第 4 章");
});
test("capture honors a selected deck and checks a supplied answer in one model call", async () => {
  const service = await ready();
  let calls = 0;
  service.complete = async (system, prompt) => {
    calls++;
    assert.ok(!system.startsWith("You file"));
    const data = JSON.parse(prompt.split("DATA:\n")[1]);
    assert.equal(data.proposedAnswer, "An unverified draft answer");
    assert.equal(data.existingQuestions[0].deckId, "d");
    return JSON.stringify({ grounded: true, card: { ...structuredClone(q), topic: "Independent dimensions",
      prompt: "When should independent dimensions be separated?", objective: "Explain the independent-dimensions trigger" } });
  };
  const added = await service.call("capture", { deckId: "d", question: "When should I separate dimensions?", answer: "An unverified draft answer" });
  assert.equal(calls, 1);
  assert.equal(added.deckId, "d");
  assert.equal(added.topic, "Independent dimensions");
  assert.notEqual(added.answer, "An unverified draft answer");
  assert.equal(added.performance.modelCalls.length, 1);
  assert.equal(added.performance.modelCalls[0].stage, "author");
  await assert.rejects(service.call("capture", { deckId: "missing", question: "Another question" }), /Requested capture deck/);
  assert.equal(calls, 1);
  service.complete = async () => { calls++; return JSON.stringify({ duplicateOf: { deckId: "d", cardId: "q" } }); };
  assert.equal((await service.call("capture", { deckId: "d", question: "Equivalent wording" })).status, "duplicate");
  assert.equal(calls, 2);
  assert.equal((await service.call("capture", { deckId: "d", question: q.prompt })).status, "duplicate");
  assert.equal(calls, 2);
  assert.equal((await service.call("deck.get", { id: "d" })).cards.length, 2);
});

test("capture files a question into the matching topic, detects originals, and keeps editing drafts in step", async () => {
  const service = await ready();
  const replies = [];
  service.complete = async () => JSON.stringify(replies.shift());
  const card = (extra) => ({
    objective: "Explain when to prefer Bridge over subclassing",
    prompt: "When does Bridge beat subclassing?",
    answer: "When abstraction and implementation vary independently.",
    hint: "Count the reasons to change.",
    explanation: "Independent dimensions would otherwise multiply subclasses.",
    misconception: "Bridge is only about adapters.",
    citations: [{ sourceId: "s", quote: "vary independently" }],
    ...extra,
  });
  const editing = await service.call("deck.edit", { id: "d" });
  replies.push(
    { duplicateOf: null, deckId: "d", topic: "Bridge" },
    { grounded: true, card: card() },
  );
  const added = await service.call("capture", {
    input: "什么时候 Bridge 比继承更合适？",
  });
  assert.equal(added.status, "added");
  assert.equal(added.kind, "flashcard");
  assert.equal(added.topic, "Bridge");
  assert.equal(added.grounded, true);
  let state = await service.call("export");
  assert.equal(state.decks[0].cards.length, 2);
  assert.equal(state.decks[0].cards[1].review.repetitions, 0);
  const draft = state.drafts.find((x) => x.id === editing.id);
  assert.equal(draft.cards.length, 2);
  assert.equal((await service.call("map")).decks[0].counts.new, 2);

  assert.equal(
    (await service.call("capture", { question: "Why use Bridge for reports and renderers?" })).status,
    "duplicate",
  );
  replies.push({ duplicateOf: { deckId: "d", cardId: "q" }, deckId: "d", topic: "Bridge" });
  const dup = await service.call("capture", { question: "报表和渲染器为什么适合 Bridge？" });
  assert.equal(dup.status, "duplicate");
  assert.equal(dup.cardId, "q");

  replies.push(
    { duplicateOf: null, deckId: null, newDeck: { title: "网络", folder: "计算机 / 基础" }, topic: "TCP" },
    {
      grounded: false,
      note: "TCP needs a third handshake so both sides confirm the other can send and receive.",
      card: card({
        prompt: "Why does TCP use three handshakes?",
        objective: "Explain the third handshake",
        answer: "Both sides must confirm send and receive ability.",
        options: [
          { id: "a", text: "Both directions get confirmed", correct: true, explanation: "Matches the note." },
          { id: "b", text: "It speeds up the transfer", correct: false, explanation: "Handshakes add latency." },
          { id: "c", text: "It encrypts the session", correct: false, explanation: "TCP has no encryption." },
        ],
        citations: [{ sourceId: "NOTE", quote: "both sides confirm the other can send and receive" }],
      }),
    },
  );
  const quiz = await service.call("capture", { input: "TCP 为什么要三次握手，写成 MQ" });
  assert.equal(quiz.kind, "quiz");
  assert.equal(quiz.newDeck, true);
  assert.equal(quiz.grounded, false);
  assert.equal(quiz.folder, "计算机 / 基础");
  state = await service.call("export");
  assert.equal(state.sources.at(-1).origin, "capture");
  assert.equal(state.decks.at(-1).cards[0].citations[0].sourceId, state.sources.at(-1).id);
});
test("large selections generate in parts, extra generations queue, and job.wait returns a compact draft summary", async () => {
  const service = new StudyService(await fresh());
  const paragraph = (i) => `Paragraph ${i} explains design smell number ${i} with its own distinct example sentence.`;
  const text = Array.from({ length: 1700 }, (_, i) => paragraph(i)).join("\n\n");
  assert.ok(text.length > 130000);
  const big = await service.call("source.add", { title: "notes.md", text });
  let counter = 0,
    authorCalls = 0;
  service.complete = withQualityStages(async (system, prompt) => {
    if (system.startsWith("Act as a strict assessment editor"))
      return JSON.stringify({ issues: [], summary: "ok" });
    authorCalls++;
    const request = JSON.parse(prompt.slice(prompt.indexOf("REQUEST DATA:\n") + 14));
    if (request.kind === "flashcard" && authorCalls === 5 && !prompt.includes("Repair this candidate"))
      return JSON.stringify({ error: "insufficient evidence in this part" });
    return JSON.stringify({
      title: "Smells",
      cards: Array.from({ length: request.count }, () => {
        const n = ++counter,
          quote = request.sources[0].text.trim().slice(0, 40);
        return {
          id: `card-${n}`,
          kind: request.kind,
          topic: `Topic ${n}`,
          objective: `Objective ${n}`,
          prompt: `Question ${n}?`,
          answer: `Answer ${n}`,
          hint: `Think about item ${n}`,
          explanation: `Because ${n}`,
          misconception: `Confusing ${n}`,
          citations: [{ sourceId: request.sources[0].id, quote }],
          ...(request.kind === "quiz"
            ? {
                options: ["a", "b", "c"].map((id) => ({
                  id,
                  text: `Option ${id} ${n}`,
                  correct: id === "a",
                  explanation: `Why ${id}`,
                })),
              }
            : {}),
        };
      }),
    });
  });
  const quiz = await service.call("generate", { sourceIds: [big.id], count: 6, kind: "quiz" });
  const cards = await service.call("generate", { sourceIds: [big.id], count: 6, kind: "flashcard" });
  assert.equal(quiz.parts, 3);
  assert.equal(cards.status, "queued");
  assert.equal(cards.queuedBehind, 1);
  const first = await service.call("job.wait", { jobId: quiz.jobId });
  assert.equal(first.status, "complete");
  assert.equal(first.draft.cards, 6);
  assert.equal(first.steps.length, 12);
  assert.ok(first.steps.every((step) => step.status === "complete" && step.startedAt && step.finishedAt));
  assert.match(first.steps[0].stage, /Planning evidence/);
  assert.ok(first.steps.slice(0, 3).every((step) => step.stage.includes("Planning evidence")));
  assert.match(first.steps[3].stage, /Writing source-grounded questions/);
  const second = await service.call("job.wait", { jobId: cards.jobId });
  assert.equal(second.status, "complete");
  assert.equal(second.draft.failures.length, 1);
  assert.ok(second.draft.cards >= 3 && second.draft.cards < 6);
  const compact = await service.call("snapshot", { compact: true });
  assert.deepEqual(Object.keys(compact.sources[0]).sort(), ["chars", "id", "title"]);
  assert.equal(compact.drafts.length, 2);
  assert.ok(JSON.stringify(compact).length < 12000);
  const page = await service.call("source.get", { id: big.id, offset: 100, limit: 50 });
  assert.equal(page.text, text.slice(100, 150));
});
test("prerequisite links order the path, teach first with return, credit on success and survive deck edits", async () => {
  const service = new StudyService(await fresh());
  await service.call("source.add", source);
  const card = (id, topic) => ({
    ...structuredClone(q),
    id,
    topic,
    objective: `${q.objective} ${id}`,
    prompt: `${q.prompt} ${id}`,
  });
  await service.call("draft.save", {
    deck: { id: "d", title: "Refactoring", cards: [card("hard", "Long Method"), card("case", "Movie Rental"), card("defn", "Techniques")] },
  });
  await service.call("draft.publish", { id: "d" });
  // "case" was learned earlier and is due again; "defn" and "hard" are new.
  await service.store.update((st) => {
    st.decks[0].cards.find((c) => c.id === "case").review = {
      repetitions: 2,
      interval_days: 6,
      ease_factor: 2.5,
      due_at: new Date(Date.now() - 86400000).toISOString(),
    };
  });
  await service.call("card.link", { deckId: "d", cardId: "hard", requires: { deckId: "d", cardId: "case" } });
  await assert.rejects(
    service.call("card.link", { deckId: "d", cardId: "case", requires: { deckId: "d", cardId: "hard" } }),
    /depend on each other/,
  );
  service.complete = async (system) =>
    JSON.stringify(
      system.startsWith("You file")
        ? { duplicateOf: { deckId: "d", cardId: "defn" }, deckId: "d", topic: "Techniques" }
        : {},
    );
  const fresh1 = await service.call("review.start", { mode: "path", scope: [{ deckId: "d", cardId: "hard" }] });
  assert.equal(fresh1.card.id, "hard");
  const captured = await service.call("capture", { question: "什么是重构手法？", requiredBy: "current" });
  assert.equal(captured.status, "duplicate");
  assert.equal(captured.prerequisiteFor.cardId, "hard");
  const view = await service.call("review.get", { runId: fresh1.id });
  assert.deepEqual(view.prerequisites.map((p) => p.cardId), ["case", "defn"]);
  assert.equal((await service.call("card.get", { deckId: "d", cardId: "defn" })).requiredBy[0].cardId, "hard");

  // Studying prerequisites first, then returning to the original run.
  const pre = await service.call("review.start", {
    mode: "path",
    scope: view.prerequisites.map(({ deckId, cardId }) => ({ deckId, cardId })),
    returnTo: fresh1.id,
    fresh: true,
  });
  assert.equal(pre.title, "前置题 · 2 道");
  assert.equal(pre.returnTo, fresh1.id);
  assert.equal(pre.total, 2);

  // The learning path puts the unlearned prerequisite before the card that needs it.
  const plan = await service.call("review.start", { mode: "path", scope: [{ deckId: "d", topic: "Long Method" }], fresh: true });
  const order = [];
  let cur = plan;
  while (cur.card) {
    order.push(cur.card.id);
    await service.call("review.reveal", { runId: cur.id, cardId: cur.card.id });
    const answered = await service.call("review.answer", { runId: cur.id, cardId: cur.card.id, grade: 4 });
    if (cur.card.id === "hard") assert.equal(answered.feedback.credited, 1);
    cur = await service.call("review.move", { runId: cur.id, direction: 1 });
  }
  assert.deepEqual(order, ["defn", "hard"]);
  const state = await service.call("export");
  const implicit = state.attempts.filter((x) => x.implicit);
  assert.equal(implicit.length, 1);
  assert.equal(implicit[0].quiz_id, "case");

  // Editing the deck keeps links and does not reset scheduling because of them.
  const before = state.decks[0].cards.find((c) => c.id === "hard").review;
  const edit = await service.call("deck.edit", { id: "d" });
  edit.cards.forEach((c) => delete c.requires);
  await service.call("draft.save", { deck: edit });
  for (const r of (await service.call("snapshot")).runs) await service.call("review.end", { runId: r.id });
  await service.call("review.end", { runId: fresh1.id });
  await service.call("review.end", { runId: pre.id });
  await service.call("draft.publish", { id: edit.id });
  const after = (await service.call("deck.get", { id: "d" })).cards.find((c) => c.id === "hard");
  assert.equal(after.requires.length, 2);
  assert.deepEqual(after.review, before);
});
test("card.update improves one card in place, keeps its schedule for explanation fixes, refreshes open runs and reverts", async () => {
  const service = await ready();
  const quiz = {
    ...structuredClone(q),
    id: "mq",
    kind: "quiz",
    objective: "Spot the invented smell",
    prompt: "Which is not one of the seven design smells?",
    options: [
      { id: "a", text: "Opacity smell", correct: false, explanation: "Wrong." },
      { id: "b", text: "Viscosity smell", correct: false, explanation: "Wrong." },
      { id: "c", text: "Redundancy smell", correct: true, explanation: "Right." },
    ],
  };
  const edit = await service.call("deck.edit", { id: "d" });
  edit.cards.push(quiz);
  await service.call("draft.save", { deck: edit });
  await service.call("draft.publish", { id: edit.id });
  await service.store.update((st) => {
    st.decks[0].cards.find((c) => c.id === "mq").review = { repetitions: 3, interval_days: 12, ease_factor: 2.5, due_at: new Date().toISOString() };
  });
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "d", cardId: "mq" }] });
  const better = await service.call("card.update", {
    deckId: "d",
    cardId: "mq",
    reason: "Option explanations name the concept",
    patch: { options: [{ id: "a", explanation: "Opacity is on the list: code that is hard to understand." }] },
  });
  assert.equal(better.scheduleReset, false);
  assert.equal(better.refreshedInOpenRuns, 1);
  let card = (await service.call("deck.get", { id: "d" })).cards.find((c) => c.id === "mq");
  assert.equal(card.review.repetitions, 3);
  assert.equal(card.options[0].text, "Opacity smell");
  assert.match(card.options[0].explanation, /hard to understand/);
  const view = await service.call("review.get", { runId: run.id });
  assert.equal(view.revision, 1);
  await service.call("review.answer", { runId: run.id, cardId: "mq", selected: ["a"] });
  assert.match((await service.call("review.get", { runId: run.id })).solution.options.find((o) => o.id === "a").explanation, /hard to understand/);
  await assert.rejects(
    service.call("card.update", { deckId: "d", cardId: "mq", patch: { citations: [{ sourceId: "s", quote: "not in the source at all" }] } }),
    /quote must match/,
  );
  const changed = await service.call("card.update", { deckId: "d", cardId: "mq", patch: { prompt: "Which of these is not a design smell?" } });
  assert.equal(changed.scheduleReset, true);
  assert.equal(changed.refreshedInOpenRuns, 0);
  const reverted = await service.call("card.revert", { deckId: "d", cardId: "mq" });
  assert.equal(reverted.revisions, 1);
  card = (await service.call("deck.get", { id: "d" })).cards.find((c) => c.id === "mq");
  assert.equal(card.prompt, quiz.prompt);
  assert.equal((await service.call("card.get", { deckId: "d", cardId: "mq" })).revisions[0].reason, "Option explanations name the concept");
});
test("concurrent captures run in turn so the second one sees the first card", async () => {
  const service = await ready();
  service.complete = async (system, prompt) => {
    if (system.startsWith("You file")) {
      const { catalog } = JSON.parse(prompt);
      const earlier = catalog[0].topics.flatMap((t) => t.cards).find((c) => c.prompt.startsWith("When does Bridge"));
      return JSON.stringify(
        earlier
          ? { duplicateOf: { deckId: "d", cardId: earlier.cardId }, deckId: "d", topic: "Bridge" }
          : { duplicateOf: null, deckId: "d", topic: "Bridge" },
      );
    }
    await new Promise((r) => setTimeout(r, 30));
    return JSON.stringify({
      grounded: true,
      card: {
        objective: "Prefer Bridge over subclassing",
        prompt: "When does Bridge beat subclassing?",
        answer: "When two dimensions vary independently.",
        hint: "Count reasons to change.",
        explanation: "Otherwise subclasses multiply.",
        misconception: "Bridge adapts interfaces.",
        citations: [{ sourceId: "s", quote: "vary independently" }],
      },
    });
  };
  const [first, second] = await Promise.all([
    service.call("capture", { question: "什么时候用 Bridge 比继承好？" }),
    service.call("capture", { question: "Bridge 和子类化怎么选？" }),
  ]);
  assert.equal(first.status, "added");
  assert.equal(second.status, "duplicate");
  assert.equal((await service.call("deck.get", { id: "d" })).cards.length, 2);
});
test("recording mode ingests pasted mistakes into a deck, keeps answer keys, skips duplicates and marks mistakes weak", async () => {
  const service = await ready();
  const paste = [
    "Q3. Which of the following is NOT one of the 7 design smells?",
    "A) Opacity  B) Viscosity  C) Repetition  D) Redundancy",
    "Your answer: A   Correct answer: D",
    "Q4. What does Bridge separate? (no answer shown)",
  ].join("\n");
  let calls = 0;
  service.complete = async (_system, prompt) => {
    calls++;
    if (prompt.includes("failed validation")) return JSON.stringify({ items: [] });
    return JSON.stringify({
      items: [
        {
          kind: "quiz",
          topic: "Design smells",
          objective: "Recognise the seven design smells",
          prompt: "Which of the following is NOT one of the 7 design smells?",
          options: [
            { id: "a", text: "Opacity", correct: false, explanation: "Opacity is on the list: code that is hard to understand." },
            { id: "b", text: "Viscosity", correct: false, explanation: "Viscosity is on the list: the right change is harder than a hack." },
            { id: "c", text: "Repetition", correct: false, explanation: "Repetition is on the list: duplicated logic." },
            { id: "d", text: "Redundancy", correct: true, explanation: "Redundancy is not one of the seven; duplication is covered by Repetition." },
          ],
          answer: "Redundancy",
          answerFrom: "material",
          hint: "One option only sounds like a smell.",
          explanation: "The seven are rigidity, fragility, immobility, viscosity, complexity, repetition and opacity.",
          misconception: "Treating every quality word as an official smell.",
          quotes: ["Which of the following is NOT one of the 7 design smells?"],
          learner: { selected: ["a"], wrong: true },
        },
        {
          kind: "flashcard",
          topic: "Bridge",
          objective: "State what Bridge decouples",
          prompt: "What does Bridge separate?",
          answer: "An abstraction from its implementation.",
          answerFrom: "inferred",
          hint: "Two hierarchies.",
          explanation: "Each side can vary independently.",
          misconception: "Confusing Bridge with Adapter.",
          quotes: ["What does Bridge separate? (no answer shown)"],
          learner: { wrong: null },
        },
        {
          kind: "flashcard",
          topic: "Bridge",
          objective: "Duplicate of an existing card",
          prompt: "Why use Bridge for reports and renderers?",
          answer: "x",
          hint: "y",
          explanation: "z",
          misconception: "w",
          quotes: ["missing quote that is not in the paste"],
        },
      ],
      ignored: ["score banner"],
    });
  };
  const mode = await service.call("ingest.start", { deckTitle: "Canvas 错题", folder: "SWE5006 / M3", mistakes: "auto" });
  assert.equal(mode.deckId, null);
  assert.equal((await service.call("snapshot")).ingest.deckTitle, "Canvas 错题");
  const result = await service.call("ingest", { text: paste });
  assert.equal(calls, 2); // one parse, one repair attempt for the invalid third item
  assert.equal(result.newDeck, true);
  assert.equal(result.folder, "SWE5006 / M3");
  assert.equal(result.added.length, 2);
  assert.equal(result.added[0].mistake, true);
  assert.equal(result.added[1].answerInferred, true);
  assert.equal(result.skipped.length, 1);
  const state = await service.call("export");
  const deck = state.decks.find((d) => d.id === result.deckId);
  assert.equal(deck.cards[0].options.find((o) => o.correct).text, "Redundancy");
  assert.equal(deck.cards[1].flag, "答案由模型推断，待核对");
  assert.equal(state.sources.find((x) => x.id === result.sourceId).text, paste);
  const map = await service.call("map");
  assert.equal(map.decks.find((d) => d.id === result.deckId).counts.weak, 1);
  assert.equal((await service.call("ingest.status")).added, 2);

  // Pasting the same material again adds nothing.
  const again = await service.call("ingest", { text: paste });
  assert.equal(again.added.length, 0);
  assert.equal(again.duplicates.length, 2);
  assert.equal(again.sourceId, null);
  assert.equal((await service.call("export")).sources.length, 2);
  const stopped = await service.call("ingest.stop");
  assert.equal(stopped.added, 2);
  assert.equal((await service.call("snapshot")).ingest, null);

  // lastRun points at the run the learner touched most recently.
  const run = await service.call("review.start", { deckId: result.deckId, mode: "quiz" });
  assert.equal((await service.call("snapshot")).lastRun.id, run.id);
});
test("card references resolve by card id when deckId is empty or wrong, with clear errors", async () => {
  const service = await ready();
  const other = { ...structuredClone(q), id: "o1", objective: "Other objective", prompt: "Another deck question?" };
  await service.call("draft.save", { deck: { id: "d2", title: "Other", cards: [other] } });
  await service.call("draft.publish", { id: "d2" });
  const linked = await service.call("card.link", { deckId: "d", cardId: "q", requires: { deckId: "", cardId: "o1" } });
  assert.deepEqual(linked.requires, { deckId: "d2", cardId: "o1" });
  const view = await service.call("card.get", { cardId: "q" });
  assert.equal(view.deckId, "d");
  assert.equal(view.prerequisites[0].deckTitle, "Other");
  assert.equal((await service.call("card.get", { deckId: "d", cardId: "o1" })).deckId, "d2");
  await assert.rejects(
    service.call("card.link", { cardId: "q", requires: { cardId: "nope" } }),
    /Prerequisite question not found \(cardId nope\)/,
  );
  const run = await service.call("review.start", { mode: "path", scope: [{ cardId: "o1" }] });
  assert.equal(run.card.id, "o1");
});


test("Study cancellation stops the active phase and skips queued jobs, scoped to its library", async () => {
  const service = await ready(), other = await ready();
  let started, calls = 0;
  const began = new Promise((resolve) => { started = resolve; });
  service.complete = async (_system, _prompt, execution) => {
    calls++;
    started();
    return new Promise((_resolve, reject) => {
      execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true });
    });
  };
  const first = await service.call("generate", { sourceIds: ["s"], count: 5 });
  await began;
  const second = await service.call("generate", { sourceIds: ["s"], count: 5 });
  await assert.rejects(other.call("job.cancel", { jobId: first.jobId }), /not found/i);
  await assert.rejects(service.call("job.cancel", {}), /Specify/);
  const cancelled = await service.call("job.cancel", { all: true });
  assert.equal(cancelled.jobs.find((j) => j.id === second.jobId).status, "cancelled");
  const done = await service.call("job.wait", { jobId: first.jobId });
  assert.equal(done.status, "cancelled");
  assert.match(done.stage, /cancelled/);
  assert.equal((await service.call("job.wait", { jobId: second.jobId })).status, "cancelled");
  assert.equal(calls, 1, "no repair, replan or queued model call after cancellation");
  assert.equal((await service.call("job.cancel", { jobId: first.jobId })).jobs[0].status, "cancelled");
});

test("cancelling parallel generation retains the approved checkpoint and permits its publication", { timeout: 10000 }, async () => {
  const root = await fresh(), releases = [];
  let started, checkpointed, counter = 0;
  const readyWorkers = new Promise((resolve) => started = resolve);
  const firstSave = new Promise((resolve) => checkpointed = resolve);
  const fixture = withQualityStages(async (system, prompt) => {
    if (system.includes("editor")) return JSON.stringify({ issues: [] });
    const req = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
    return JSON.stringify({ title: "Parallel", cards: Array.from({ length: req.count }, () => {
      const n = ++counter;
      return { ...structuredClone(q), id: `q${n}`, prompt: `Distinct question ${n}?`, objective: `Objective ${n}` };
    }) });
  });
  const service = new StudyService(root, { complete: async (system, prompt, execution) => {
    if (system.startsWith("You author")) {
      const childId = `child-${releases.length}`;
      execution.setMessenger(async () => ({ childId, messageId: `receipt-${childId}` }));
      await new Promise((resolve) => { releases.push(resolve); if (releases.length === 3) started(); });
    }
    return fixture(system, prompt.split("\n\nAdditional learner requirements")[0]);
  } });
  const originalCall = service.call.bind(service);
  service.call = async (action, args) => {
    const result = await originalCall(action, args);
    if (action === "draft.save") checkpointed(result);
    return result;
  };
  await service.call("source.add", source);
  const job = await service.call("generate", { sourceIds: ["s"], count: 11, kind: "flashcard" });
  let early;
  try {
    await readyWorkers;
    const sent = await service.call("job.message", { jobId: job.jobId, message: "Keep each question focused" });
    assert.equal(sent.receipts.length, 3);
    assert.ok(sent.receipts.every((receipt) => receipt.delivered));
    releases[0](); early = await firstSave;
    assert.ok(early.cards.length > 0 && early.cards.length < 11);
    const persisted = await new StudyService(root).call("export");
    assert.equal(persisted.drafts[0].id, early.id);
    assert.equal(persisted.drafts[0].cards.length, early.cards.length);
    const sentAgain = await service.call("job.message", { jobId: job.jobId, message: "Use neutral hints" });
    assert.equal(sentAgain.receipts.length, 2);
    await assert.rejects(service.call("draft.publish", { id: early.id }), /still updating/);
  } finally { await service.call("job.cancel", { jobId: job.jobId }); releases.forEach((release) => release()); }
  const done = await service.call("job.wait", { jobId: job.jobId });
  assert.equal(done.status, "cancelled");
  assert.equal(done.draftId, early.id);
  assert.equal(done.draft.cards, early.cards.length);
  await service.call("draft.publish", { id: early.id, draftVersion: (await service.call("export")).drafts[0].draftVersion });
});


test("the total execution budget aborts a phase without starting later work", async (t) => {
  const service = await ready();
  let started, calls = 0;
  const began = new Promise((resolve) => { started = resolve; });
  service.complete = async (_system, _prompt, execution) => {
    calls++; started();
    return new Promise((_resolve, reject) => execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true }));
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const job = await service.call("generate", { sourceIds: ["s"], count: 10 });
  await began;
  t.mock.timers.tick(20 * 60 * 1000);
  const done = await service.call("job.wait", { jobId: job.jobId });
  assert.equal(done.status, "failed");
  assert.match(done.stage, /20-minute total budget/);
  assert.equal(calls, 1);
});
