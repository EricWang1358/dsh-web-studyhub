import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDeck } from "../lib/domain.js";
import { StudyService } from "../lib/service.js";
import { wrongBook } from "../lib/insights.js";
import { createWriteQueue, mergeReviewPoll } from "../ui/async.js";

test("review polling accepts revised questions and sources without restoring stale answers", () => {
  const answered = { id: "r", index: 0, queueVersion: 0, revealed: true, feedback: { correct: true }, card: { id: "q", prompt: "old" }, sourceIds: ["old"] };
  const updated = { ...answered, queueVersion: 1, revealed: false, feedback: null, card: { id: "q", prompt: "new" }, sourceIds: ["new"] };
  assert.equal(mergeReviewPoll(answered, updated), updated);
  assert.equal(mergeReviewPoll(updated, answered), updated);
  const reanswered = { ...updated, revealed: true, feedback: { correct: false } };
  assert.equal(mergeReviewPoll(reanswered, updated), reanswered);
  const recited = { ...answered, sourceIds: ["new-source"] };
  assert.deepEqual(mergeReviewPoll(answered, recited).sourceIds, ["new-source"]);
  assert.equal(mergeReviewPoll(answered, { ...updated, id: "other" }), answered);
});
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

test("queued exam selections finish in order before grading and failed saves block submission", async () => {
  const { root, service } = await library();
  try {
    const run = await service.call("review.start", { mode: "exam", count: 1 });
    const queue = createWriteQueue();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = queue.enqueue(async () => {
      await gate;
      return service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["b"] });
    });
    const last = queue.enqueue(() => service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["a"] }));
    release();
    await Promise.all([first, last, queue.flush()]);
    await assert.rejects(queue.enqueue(() => Promise.reject(new Error("offline"))), /offline/);
    await assert.rejects(queue.flush(), /offline/);
    await queue.enqueue(() => service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["a"] }));
    await queue.flush();
    assert.equal((await service.call("exam.submit", { runId: run.id })).correct, 1);
  } finally { await close(root); }
});

test("exam projections keep the start time and card-scoped exams exclude other cards", async () => {
  const { root, service } = await library();
  try {
    const run = await service.call("review.start", { mode: "exam", scope: [{ deckId: "d1", cardId: "q1" }], count: 10 });
    assert.equal(run.total, 1);
    assert.equal(run.card.id, "q1");
    assert.ok(Number.isFinite(Date.parse(run.startedAt)));
    assert.equal((await service.call("review.get", { runId: run.id })).startedAt, run.startedAt);
    assert.equal((await service.call("snapshot")).runs.find((item) => item.id === run.id).startedAt, run.startedAt);
  } finally { await close(root); }
});

test("expired exams reject late answers and navigation but still submit saved work", async () => {
  const { root, service } = await library();
  try {
    const run = await service.call("review.start", { mode: "exam", count: 1 });
    await service.store.update((state) => {
      state.runs.find((item) => item.id === run.id).startedAt =
        new Date(Date.now() - 31 * 60 * 1000).toISOString();
    });
    await assert.rejects(service.call("review.answer", {
      runId: run.id, cardId: run.card.id, selected: ["a"],
    }), /考试时间已到/);
    await assert.rejects(service.call("review.move", { runId: run.id, direction: 1 }), /考试时间已到/);
    const report = await service.call("exam.submit", { runId: run.id });
    assert.equal(report.answered, 0);
    assert.equal(report.unanswered, 1);
    assert.equal(report.durationMs, 30 * 60 * 1000);
    assert.equal((await service.call("export")).attempts.length, 0);
  } finally { await close(root); }
});

test("mock exams cover distinct topics before drawing a second question from one topic", async () => {
  const { root, service } = await library();
  try {
    const crowded = Array.from({ length: 8 }, (_, i) => ({
      ...quiz(`common-${i}`, "Common"),
      objective: `Distinguish Common responsibility ${i}`,
      prompt: `Which component owns Common responsibility ${i}?`,
    }));
    await service.call("draft.save", { deck: { id: "d2", title: "Exam breadth", cards: [...crowded, quiz("rare", "Rare")] } });
    await service.call("draft.publish", { id: "d2" });
    const run = await service.call("review.start", { mode: "exam", scope: [{ deckId: "d2" }], count: 2 });
    const saved = (await service.call("export")).runs.find((r) => r.id === run.id);
    assert.deepEqual(new Set(saved.entries.map((e) => e.card.topic)), new Set(["Common", "Rare"]));
  } finally { await close(root); }
});

test("repeat exams use unseen questions before repeats and compare only matching scopes and sizes", async () => {
  const { root, service } = await library();
  try {
    const cards = Array.from({ length: 3 }, (_, i) => ({
      ...quiz(`repeat-${i}`, "Shared"),
      objective: `Distinguish Shared responsibility ${i}`,
      prompt: `Which component owns Shared responsibility ${i}?`,
    }));
    await service.call("draft.save", { deck: { id: "repeat", title: "Repeat pool", cards } });
    await service.call("draft.publish", { id: "repeat" });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const run = await service.call("review.start", { mode: "exam", scope: [{ deckId: "repeat" }], count: 1 });
      seen.push(run.card.id);
      if (i === 0) await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["a"] });
      const report = await service.call("exam.submit", { runId: run.id });
      if (i === 1) assert.deepEqual(report.comparison && [report.comparison.scorePct, report.comparison.deltaPct], [100, -100]);
    }
    assert.equal(new Set(seen).size, 3);
    const fourth = await service.call("review.start", { mode: "exam", scope: [{ deckId: "repeat" }], count: 1 });
    assert.ok(seen.includes(fourth.card.id));
    const differentSize = await service.call("review.start", { mode: "exam", scope: [{ deckId: "repeat" }], count: 2 });
    assert.equal((await service.call("exam.submit", { runId: differentSize.id })).comparison, null);
  } finally { await close(root); }
});

test("exam kind controls filter or balance real single and multiple choice cards", async () => {
  const { root, service } = await library();
  try {
    const multi = (id, topic) => ({ ...quiz(id, topic), kind: "multi", answer: "Caretaker and Originator",
      options: [
        { id: "a", text: "Caretaker", correct: true, explanation: "It manages history." },
        { id: "b", text: "Memento", correct: false, explanation: "It stores one state." },
        { id: "c", text: "Originator", correct: true, explanation: "It creates snapshots." },
      ] });
    await service.call("draft.save", { deck: { id: "d2", title: "Multiple choice", cards: [multi("m1", "Storage"), multi("m2", "Restore")] } });
    await service.call("draft.publish", { id: "d2" });
    const scope = [{ deckId: "d1" }, { deckId: "d2" }];
    const summary = (await service.call("snapshot")).decks.find((deck) => deck.id === "d2");
    assert.deepEqual([summary.examQuizCount, summary.examMultiCount], [0, 2]);
    await assert.rejects(service.call("review.start", { mode: "exam", scope, examKinds: "invalid" }), /Choose all/);
    await assert.rejects(service.call("review.start", { mode: "exam", scope: [{ deckId: "d1" }], examKinds: "multi" }), /没有符合题型/);
    const quizRun = await service.call("review.start", { mode: "exam", scope, count: 4, examKinds: "quiz" });
    assert.equal(quizRun.total, 2);
    assert.ok((await service.call("export")).runs.find((run) => run.id === quizRun.id).entries.every((entry) => entry.card.kind === "quiz"));
    await service.call("exam.submit", { runId: quizRun.id });
    const multiRun = await service.call("review.start", { mode: "exam", scope, count: 4, examKinds: "multi" });
    assert.equal(multiRun.total, 2);
    assert.ok((await service.call("export")).runs.find((run) => run.id === multiRun.id).entries.every((entry) => entry.card.kind === "multi"));
    await service.call("exam.submit", { runId: multiRun.id });
    const allRun = await service.call("review.start", { mode: "exam", scope, count: 4, examKinds: "all" });
    await service.call("exam.submit", { runId: allRun.id });
    const balanced = await service.call("review.start", { mode: "exam", scope, count: 4, examKinds: "balanced" });
    const kinds = (await service.call("export")).runs.find((run) => run.id === balanced.id).entries.map((entry) => entry.card.kind);
    assert.deepEqual([kinds.filter((kind) => kind === "quiz").length, kinds.filter((kind) => kind === "multi").length], [2, 2]);
    const report = await service.call("exam.submit", { runId: balanced.id });
    assert.equal(report.byKind.length, 2);
    assert.equal(report.comparison, null);
  } finally { await close(root); }
});

test("substantive card updates cannot change an exam answer key mid-attempt", async () => {
  const { root, service } = await library();
  try {
    const run = await service.call("review.start", { mode: "exam", count: 1 });
    await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["a"] });
    await assert.rejects(service.call("card.update", { deckId: "d1", cardId: run.card.id, patch: { options: [{ id: "a", correct: false }, { id: "b", correct: true }] } }), /exam/i);
    assert.equal((await service.call("exam.submit", { runId: run.id })).correct, 1);
  } finally { await close(root); }
});

test("action registry refuses inherited object properties without writing state", async () => {
  const { root, service } = await library();
  try {
    const before = await service.call("export");
    for (const action of ["toString", "constructor", "__proto__", "hasOwnProperty"])
      await assert.rejects(service.call(action), /Unknown study action/);
    assert.deepEqual(await service.call("export"), before);
  } finally { await close(root); }
});

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
    await assert.rejects(service.call("exam.report", { runId: run0.id }), /尚未交卷/);
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
    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].cardId, secondCard.id);
    assert.equal(report.weakScope.length, 2);
    assert.ok(report.byTopic.length >= 1 && report.byDeck.length === 1);
    assert.deepEqual(await new StudyService(root).call("exam.report", { runId: run0.id }), report);
    assert.equal((await service.call("snapshot")).exams[0].runId, run0.id);
    // Wrong answer scheduled as a lapse; the withdrawn one untouched.
    const state = await service.call("export");
    const grades = Object.fromEntries(
      state.attempts.map((a) => [a.quiz_id, a.grade]),
    );
    assert.equal(grades[report.wrong[0].cardId], 1);
    assert.equal(grades[secondCard.id], undefined);
    assert.deepEqual(await service.call("exam.submit", { runId: run0.id }), report);
    assert.equal((await service.call("export")).attempts.length, state.attempts.length,
      "retrying a submitted exam does not grade or schedule it twice");
    // The report's weak scope re-practices through the normal path.
    const redo = await service.call("review.start", {
      mode: "path",
      scope: report.weakScope,
      fresh: true,
    });
    assert.equal(redo.total, 2);
  } finally {
    await close(root);
  }
});

test("exam history keeps same-name topics from different decks distinguishable", async () => {
  const { root, service } = await library();
  try {
    await service.call("draft.save", { deck: { id: "d2", title: "Second course", cards: [quiz("q3", "History")] } });
    await service.call("draft.publish", { id: "d2" });
    const run = await service.call("review.start", { mode: "exam", scope: [{ deckId: "d1" }, { deckId: "d2" }], count: 3 });
    const report = await service.call("exam.submit", { runId: run.id });
    const historyRows = report.byTopic.filter((row) => row.topic === "History");
    assert.deepEqual(new Set(historyRows.map((row) => row.deckTitle)), new Set(["Patterns", "Second course"]));
    assert.equal(report.skipped.length, 3);
    assert.equal(report.weakScope.length, 3);
    assert.equal((await service.call("snapshot")).exams[0].scorePct, 0);
    assert.deepEqual((await service.call("exam.report", { runId: run.id })).byTopic, report.byTopic);
  } finally { await close(root); }
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
    assert.equal(book.items[0].assessment, "graded");
  } finally {
    await close(root);
  }
});

test("wrongbook labels low self-ratings separately from objectively wrong answers", async () => {
  const { root, service } = await library();
  try {
    const flashcard = { ...quiz("f1", "Recall"), kind: "flashcard", prompt: "Who keeps snapshot history?" };
    delete flashcard.options;
    const draft = await service.call("draft.save", { deck: { id: "f", title: "Recall", cards: [flashcard] } });
    await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
    const graded = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "q1" }], fresh: true });
    await service.call("review.answer", { runId: graded.id, cardId: "q1", selected: ["b"] });
    const self = await service.call("review.start", { deckId: "f", mode: "flashcard" });
    await service.call("review.reveal", { runId: self.id, cardId: "f1" });
    await service.call("review.answer", { runId: self.id, cardId: "f1", grade: 1 });
    const items = (await service.call("wrongbook")).items;
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.cardId === "q1").assessment, "graded");
    assert.equal(items.find((item) => item.cardId === "f1").assessment, "self");
    await service.store.update((state) => { state.attempts.forEach((attempt) => { delete attempt.assessment; }); });
    const legacy = (await service.call("wrongbook")).items;
    assert.equal(legacy.find((item) => item.cardId === "q1").assessment, "graded");
    assert.equal(legacy.find((item) => item.cardId === "f1").assessment, "self");
  } finally { await close(root); }
});

test("wrongbook paginates all available weak cards after excluding suspended cards", () => {
  const cards = Array.from({ length: 104 }, (_, index) => ({
    id: `q${index}`, kind: index === 103 ? "flashcard" : "quiz",
    topic: "Recall", prompt: `Question ${index}`, suspended: index < 2,
  }));
  const state = {
    decks: [{ id: "d", title: "Course", cards }], runs: [],
    attempts: cards.map((card, index) => ({
      deckId: "d", quiz_id: card.id, grade: 1,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 104 - index)).toISOString(),
    })),
  };
  const first = wrongBook(state);
  assert.deepEqual({ total: first.total, graded: first.gradedTotal, self: first.selfTotal,
    shown: first.items.length, firstId: first.items[0].cardId },
  { total: 102, graded: 101, self: 1, shown: 100, firstId: "q2" });
  const second = wrongBook(state, { offset: 100 });
  assert.deepEqual(second.items.map((item) => item.cardId), ["q102", "q103"]);
  assert.equal(second.items[1].assessment, "self");
  assert.throws(() => wrongBook(state, { offset: -1 }), /non-negative offset/);
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

test("stats removes recovered cards from weak topics and excludes tail retries from recent rate", async () => {
  const { root, service } = await library();
  try {
    const first = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "q1" }], fresh: true });
    await service.call("review.answer", { runId: first.id, cardId: "q1", selected: ["b"] });
    assert.equal((await service.call("stats")).weakTopics[0].wrong, 1);
    const retry = await service.call("review.move", { runId: first.id, direction: 1 });
    assert.equal(retry.card.id, "q1");
    await service.call("review.answer", { runId: first.id, cardId: "q1", selected: ["a"] });
    const afterRetry = await service.call("stats");
    assert.equal(afterRetry.totals.recentAttempts, 1);
    assert.equal(afterRetry.totals.recentRate, 0);
    assert.equal(afterRetry.weakTopics[0].wrong, 1, "a same-round retry is practice, not recovered mastery");
    assert.equal((await service.call("wrongbook")).items.length, 1);
    assert.equal((await service.call("map")).decks.find((d) => d.id === "d1").counts.weak, 1);
    const followup = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "q1" }], fresh: true });
    await service.call("review.answer", { runId: followup.id, cardId: "q1", selected: ["a"] });
    const recovered = await service.call("stats");
    assert.equal(recovered.totals.recentAttempts, 2);
    assert.equal(recovered.totals.recentRate, 50);
    assert.equal(recovered.weakTopics.length, 0);
    assert.equal((await service.call("wrongbook")).items.length, 0);
  } finally { await close(root); }
});

test("statistics separate automatically graded answers from self-assessed recall", async () => {
  const { root, service } = await library();
  try {
    const flashcard = { ...quiz("f1", "Recall"), kind: "flashcard",
      objective: "Recall the history manager", prompt: "Who keeps snapshot history?" };
    delete flashcard.options;
    const draft = await service.call("draft.save", { deck: { id: "f", title: "Recall", cards: [flashcard] } });
    await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
    const graded = await service.call("review.start", { mode: "path", scope: [{ deckId: "d1", cardId: "q1" }], fresh: true });
    await service.call("review.answer", { runId: graded.id, cardId: "q1", selected: ["b"] });
    const self = await service.call("review.start", { deckId: "f", mode: "flashcard" });
    await service.call("review.reveal", { runId: self.id, cardId: "f1" });
    await service.call("review.answer", { runId: self.id, cardId: "f1", grade: 5 });
    const stats = await service.call("stats");
    assert.deepEqual({ gradedRate: stats.totals.gradedRate, gradedAttempts: stats.totals.gradedAttempts,
      selfRate: stats.totals.selfRate, selfAttempts: stats.totals.selfAttempts },
    { gradedRate: 0, gradedAttempts: 1, selfRate: 100, selfAttempts: 1 });
    assert.deepEqual({ gradedAvg: stats.trend.at(-1).gradedAvg, selfAvg: stats.trend.at(-1).selfAvg },
      { gradedAvg: 1, selfAvg: 5 });
    assert.deepEqual({ correctRate: stats.totals.correctRate, recentRate: stats.totals.recentRate,
      recentAttempts: stats.totals.recentAttempts, avg: stats.trend.at(-1).avg },
    { correctRate: 0, recentRate: 0, recentAttempts: 1, avg: 1 },
    "legacy score fields must not treat self-ratings as objectively correct answers");
    await service.store.update((state) => { state.attempts.forEach((attempt) => { delete attempt.assessment; }); });
    const legacy = await service.call("stats");
    assert.equal(legacy.totals.gradedRate, 0);
    assert.equal(legacy.totals.selfRate, 100);
    await service.store.update((state) => { state.attempts = state.attempts.filter((attempt) => attempt.quiz_id === "f1"); });
    const onlySelf = await service.call("stats");
    assert.equal(onlySelf.totals.correctRate, null);
    assert.equal(onlySelf.totals.recentRate, null);
    assert.equal(onlySelf.trend.at(-1).avg, null);
  } finally { await close(root); }
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
