import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDeck } from "../lib/domain.js";
import { StudyService } from "../lib/service.js";
import {
  publishNotebook,
  searchNotebooks,
} from "../lib/notebooks.js";

const source = {
  id: "s1",
  title: "Memento notes",
  text: "The Caretaker manages snapshot history without inspecting snapshot contents. The Originator creates snapshots.",
};
const quiz = (id, topic) => ({
  id,
  kind: "quiz",
  topic,
  objective: `Explain ${topic} precisely`,
  prompt: `Which component owns the ${topic} responsibility?`,
  answer: "Caretaker",
  hint: "Separate ownership from storage.",
  explanation: "The Caretaker manages the history.",
  misconception: "Confusing storage with management.",
  citations: [
    {
      sourceId: "s1",
      quote: "The Caretaker manages snapshot history without inspecting snapshot contents.",
    },
  ],
  options: [
    { id: "a", text: "Caretaker", correct: true, explanation: "It manages history." },
    { id: "b", text: "Memento", correct: false, explanation: "It stores one state." },
    { id: "c", text: "Originator", correct: false, explanation: "It creates snapshots." },
  ],
});
const clozeCard = () => ({
  id: "c1",
  kind: "cloze",
  topic: "Caretaker",
  objective: "Recall who manages snapshot history",
  prompt: "The {{b1}} manages snapshot history.",
  answer: "The Caretaker manages snapshot history.",
  hint: "Who owns the history?",
  explanation: "The Caretaker manages history without inspecting contents.",
  misconception: "Confusing the Memento with its manager.",
  citations: [
    {
      sourceId: "s1",
      quote: "The Caretaker manages snapshot history without inspecting snapshot contents.",
    },
  ],
  cloze: {
    text: "The {{b1}} manages snapshot history.",
    answers: [{ id: "b1", value: "Caretaker", accept: ["the caretaker"] }],
  },
});
async function library() {
  const root = await mkdtemp(join(tmpdir(), "study-feat-"));
  const service = new StudyService(root);
  await service.call("source.add", source);
  await service.call("draft.save", {
    deck: { id: "d1", title: "Patterns", cards: [quiz("q1", "History"), quiz("q2", "Creation")] },
  });
  await service.call("draft.publish", { id: "d1" });
  return { root, service };
}
const close = async (root) => rm(root, { recursive: true, force: true });

test("cloze passes quality gates and grades blanks with accepted variants", async () => {
  const d = {
    id: "d2",
    title: "Cloze",
    cards: [clozeCard()],
  };
  assert.deepEqual(validateDeck(d, [source]).errors, []);
  d.cards[0].cloze.answers[0].value = "";
  assert.match(validateDeck(d, [source]).errors.join(), /value/i);
  d.cards[0].cloze.answers[0].value = "Caretaker";
  d.cards[0].cloze.text = "No marker here.";
  assert.match(validateDeck(d, [source]).errors.join(), /marker/i);
  d.cards[0].cloze.text = "The {{b1}} manages snapshot history.";

  const { root, service } = await library();
  try {
    await service.call("draft.save", { deck: d });
    await service.call("draft.publish", { id: "d2" });
    const run = await service.call("review.start", { deckId: "d2", mode: "quiz" });
    assert.equal(run.card.kind, "cloze");
    assert.deepEqual(run.card.cloze.blanks, [{ id: "b1" }]);
    assert.equal("answers" in run.card.cloze, false);
    assert.equal(JSON.stringify(run.card).includes('"value":'), false);
    assert.equal(JSON.stringify(run.card).includes('"accept":'), false);
    const right = await service.call("review.answer", {
      runId: run.id,
      cardId: "c1",
      answers: { b1: "  CARETAKER " },
    });
    assert.equal(right.feedback.correct, true);
    assert.equal(right.feedback.grade, 4);
    assert.ok(right.feedback.details[0].correct);
    const revealed = await service.call("review.reveal", { runId: run.id, cardId: "c1" });
    assert.equal(revealed.solution.cloze.answers[0].value, "Caretaker");
    await service.call("review.end", { runId: run.id });

    const wrongRun = await service.call("review.start", { deckId: "d2", mode: "quiz", fresh: true });
    const miss = await service.call("review.answer", {
      runId: wrongRun.id,
      cardId: "c1",
      answers: { b1: "Originator" },
    });
    assert.equal(miss.feedback.correct, false);
    assert.equal(miss.feedback.grade, 1);
    assert.equal(miss.feedback.details[0].expected, "Caretaker");
  } finally {
    await close(root);
  }
});

test("mock exam records silently, refuses reveal, grades and reports on submit", async () => {
  const { root, service } = await library();
  try {
    const run0 = await service.call("review.start", {
      mode: "exam",
      scope: [{ deckId: "d1" }],
      count: 2,
      fresh: true,
    });
    assert.equal(run0.mode, "exam");
    assert.equal(run0.total, 2);
    const first = run0.card;
    let run = await service.call("review.answer", {
      runId: run0.id,
      cardId: first.id,
      selected: ["a"],
    });
    assert.equal(run.feedback, null);
    // Exam answers stay changeable and leak nothing.
    run = await service.call("review.answer", {
      runId: run0.id,
      cardId: first.id,
      selected: ["b"],
    });
    assert.equal(run.feedback, null);
    assert.equal(run.revealed, false);
    // The projection exposes the learner's own selections for panel restore.
    assert.equal(run.picks.length, 2);
    assert.deepEqual(run.picks[0].selected, ["b"]);
    assert.equal(run.picks[0].cardId, first.id);
    assert.equal(run.picks[1].selected, null);
    await assert.rejects(
      service.call("review.reveal", { runId: run0.id, cardId: first.id }),
      /Submit the exam/,
    );
    run = await service.call("review.move", { runId: run0.id, direction: 1 });
    const secondCard = run.card;
    run = await service.call("review.answer", {
      runId: run0.id,
      cardId: secondCard.id,
      selected: ["a"],
    });
    assert.deepEqual(run.picks[1].selected, ["a"]);
    // Clearing every option withdraws the answer.
    run = await service.call("review.answer", {
      runId: run0.id,
      cardId: secondCard.id,
      selected: [],
    });
    assert.equal(run.picks[1].selected, null);

    const report = await service.call("exam.submit", { runId: run0.id });
    assert.equal(report.total, 2);
    assert.equal(report.answered, 1);
    assert.equal(report.unanswered, 1);
    assert.equal(report.correct, 0);
    assert.equal(report.scorePct, 0);
    assert.equal(report.wrong.length, 1);
    assert.equal(report.weakScope.length, 1);
    assert.ok(report.byTopic.length >= 1 && report.byDeck.length === 1);
    // Wrong answer scheduled as a lapse; the withdrawn one untouched.
    const state = await service.call("export");
    const grades = Object.fromEntries(
      state.attempts.map((a) => [a.quiz_id, a.grade]),
    );
    assert.equal(grades[report.wrong[0].cardId], 1);
    assert.equal(grades[secondCard.id], undefined);
    await assert.rejects(
      service.call("exam.submit", { runId: run0.id }),
      /already submitted/,
    );
    // The report's weak scope re-practices through the normal path.
    const redo = await service.call("review.start", {
      mode: "path",
      scope: report.weakScope,
      fresh: true,
    });
    assert.equal(redo.total, 1);
  } finally {
    await close(root);
  }
});

test("wrongbook aggregates latest wrong answers across decks", async () => {
  const { root, service } = await library();
  try {
    assert.deepEqual((await service.call("wrongbook")).items, []);
    const run = await service.call("review.start", { deckId: "d1", mode: "quiz" });
    const card = run.card;
    await service.call("review.answer", { runId: run.id, cardId: card.id, selected: ["b"] });
    const book = await service.call("wrongbook");
    assert.equal(book.items.length, 1);
    assert.equal(book.items[0].cardId, card.id);
    assert.equal(book.items[0].deckTitle, "Patterns");
    assert.equal(book.items[0].lastGrade, 1);
  } finally {
    await close(root);
  }
});

test("stats: streak, heatmap zero-fill, trend and weak topics", async () => {
  const { root, service } = await library();
  try {
    const run0 = await service.call("review.start", { deckId: "d1", mode: "quiz" });
    await service.call("review.answer", { runId: run0.id, cardId: run0.card.id, selected: ["a"] });
    const moved = await service.call("review.move", { runId: run0.id, direction: 1 });
    await service.call("review.answer", { runId: run0.id, cardId: moved.card.id, selected: ["b"] });
    const stats = await service.call("stats");
    assert.equal(stats.totals.attempts, 2);
    assert.equal(stats.totals.correctRate, 50);
    assert.ok(stats.totals.streak >= 1);
    assert.equal(stats.heatmap.length, 182);
    assert.equal(stats.heatmap.at(-1).count, 2);
    assert.equal(stats.heatmap.at(-2).count, 0);
    const today = stats.trend.at(-1);
    assert.equal(today.count, 2);
    assert.equal(today.avg, 2.5);
    assert.ok(stats.weakTopics.some((t) => t.wrong === 1));
  } finally {
    await close(root);
  }
});

test("graph: structure tree with prereq edges and ordered path", async () => {
  const { root, service } = await library();
  try {
    await service.call("draft.save", { deck: { id: "d2", title: "Cloze", cards: [clozeCard()] } });
    await service.call("draft.publish", { id: "d2" });
    await service.call("card.link", {
      deckId: "d1",
      cardId: "q1",
      requires: { deckId: "d2", cardId: "c1" },
    });
    const graph = await service.call("graph", {});
    const kinds = graph.nodes.map((n) => n.kind);
    assert.ok(kinds.includes("deck") && kinds.includes("topic") && kinds.includes("card"));
    const prereq = graph.edges.filter((e) => e.type === "prereq");
    assert.equal(prereq.length, 1);
    assert.ok(graph.nodes.some((n) => n.id === prereq[0].from));
    assert.ok(graph.nodes.some((n) => n.id === prereq[0].to));
    const scoped = await service.call("graph", { scope: [{ deckId: "d1", topic: "History" }] });
    assert.ok(scoped.nodes.every((n) => n.deckId === "d1"));
    assert.ok(scoped.nodes.some((n) => n.topic === "History"));
    assert.ok(scoped.nodes.every((n) => n.topic !== "Creation"));

    const path = await service.call("graph", { mode: "path" });
    assert.equal(path.mode, "path");
    assert.ok(path.nodes.length >= 1);
    assert.ok(path.nodes.every((n) => n.kind === "card"));
    const orders = path.edges.filter((e) => e.type === "order");
    assert.equal(orders.length, Math.max(0, path.nodes.length - 1));
    assert.deepEqual(
      orders.map((e) => e.seq),
      orders.map((_, i) => i),
    );
  } finally {
    await close(root);
  }
});

test("notebook.search spans published libraries read-only", async () => {
  const home = await mkdtemp(join(tmpdir(), "study-nb-home-"));
  process.env.DSH_HOME = home;
  try {
    const a = await library();
    const bRoot = await mkdtemp(join(tmpdir(), "study-nb-b-"));
    const b = new StudyService(bRoot);
    await b.call("source.add", source);
    await b.call("draft.save", { deck: { id: "d2", title: "Cloze", cards: [clozeCard()] } });
    await b.call("draft.publish", { id: "d2" });
    await publishNotebook(a.root, a.root);
    await publishNotebook(bRoot, bRoot);
    const hits = await searchNotebooks("caretaker");
    assert.equal(hits.items.length, 1);
    assert.equal(hits.items[0].deckId, "d2");
    assert.equal(hits.items[0].cardId, "c1");
    assert.equal(hits.items[0].workspace, bRoot);
    const decks = await searchNotebooks("patterns");
    assert.equal(decks.items.length, 1);
    assert.equal(decks.items[0].deckId, "d1");
    assert.deepEqual((await searchNotebooks("nonexistent-xyz")).items, []);
    await assert.rejects(searchNotebooks(""), /query/);
    await close(a.root);
    await close(bRoot);
  } finally {
    delete process.env.DSH_HOME;
    await rm(home, { recursive: true, force: true });
  }
});
