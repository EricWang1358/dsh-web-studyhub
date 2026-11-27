/* global window, document, KeyboardEvent */
/* WP12 · rubric grading inside the existing learning loop. A rubric card in a
   review run is graded by background help (assist mode `grade`) or by the
   runtime action `card.grade`; both store the result like any answer: the run
   entry's feedback (per-criterion marks, quotes, gaps, rewrite advice), an
   attempt with `assessment: 'rubric'` that schedules SM-2, and an inbox letter
   at the card. A case paper is an exam run (examKinds 'case') with the paper's
   own time limit, typed answers, highlights per run, pacing and a report with
   per-question marks and the weakest criteria. All cases are synthetic. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { publicCard } from "../lib/domain.js";
import { createAssistService, normalizeAssistRequest } from "../lib/assist.js";
import { examExpired } from "../lib/exam-timing.js";
import { rubricSkills, renderRubric } from "../lib/case-study.js";
import { createFakeModel } from "../scripts/fake-model.mjs";

const scenario = ["Orchard Cold Chain stores fresh fruit for supermarkets in three refrigerated warehouses.",
  "Temperature sensors report every minute to a desktop program written in Visual Basic in 2009.",
  "In March a warehouse lost power overnight and nobody was alerted until the morning shift arrived.",
  "Management wants customers to see live temperatures on their phones next season."].join("\n\n");
const criteria = (concept) => [
  { id: "c1", label: `Recommendation using ${concept}`, marks: 3, descriptor: `Applies ${concept} to Orchard.`, keyPoints: [`Names ${concept} correctly`] },
  { id: "c2", label: "Case linkage", marks: 2, descriptor: "Ties choices to facts of the case.", keyPoints: ["The overnight power loss calls for alerting on missing readings"] },
  { id: "c3", label: "Assumptions and trade-offs", marks: 1, descriptor: "States assumptions where the case is silent.", keyPoints: ["States an assumption"] },
];
const card = (id, n, concept, marks = 6) => ({ id, kind: "open", topic: concept, objective: `Q${n}: apply ${concept} at Orchard`,
  prompt: `Question ${n}: Applying ${concept}, what would you recommend for Orchard's monitoring platform? Justify.`,
  answer: `Use ${concept} with alerting on missing readings.`, hint: "Re-read the paragraph about March.",
  explanation: `An excellent answer applies ${concept} and ties it to the power loss.`, misconception: "Listing tools without the case.",
  marks, rubricCriteria: criteria(concept), rubric: renderRubric(criteria(concept), "en"), caseQuestion: n,
  citations: [{ sourceId: "case", quote: "In March a warehouse lost power overnight" }] });
const answer = "I recommend an event-driven architecture because the sensors already publish readings every minute.\n" +
  "Each reading becomes an event that an alerting service consumes, so a power loss raises an alarm at once.\n" +
  "I would also use Kubernetes for everything.\nThe case does not say how many sensors there are, so I assume about 500.";

async function library(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-wp12-review-"));
  const service = new StudyService(root, { complete: createFakeModel(), ...options });
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((state) => {
    state.sources.push({ id: "case", title: "Case: Orchard Cold Chain", text: scenario, courses: ["Cloud Native"] });
    state.decks.push({ id: "orchard", title: "Orchard case", course: "Cloud Native", format: "case-study",
      case: { sourceId: "case", title: "Orchard Cold Chain", totalMarks: 10, origin: "imported", language: "English",
        cues: [{ id: "cue1", paragraph: 3, quote: "In March a warehouse lost power overnight and nobody was alerted until the morning shift arrived.", implies: "Alerting" }] },
      cards: [card("q1", 1, "Event-driven architecture"), card("q2", 2, "Polyglot persistence", 4)].map((item) => {
        if (item.id === "q2") item.rubricCriteria = [{ ...criteria("Polyglot persistence")[0], marks: 2 }, { ...criteria("x")[1] }];
        if (item.id === "q2") item.rubric = renderRubric(item.rubricCriteria, "en");
        return item;
      }) });
  });
  return { service, root };
}

const ref = { deckId: "orchard", cardId: "q1" };
async function keptOpenSnapshot(service) {
  const prompt = "Applying event-driven architecture, how should Orchard react to missing temperature readings? Justify.";
  await service.call("card.update", { ...ref, patch: { prompt, answer: "Use event-driven alerts when expected readings stop." } });
  const run = await service.call("review.start", { mode: "path", scope: [ref], fresh: true });
  await service.call("card.revert", ref);
  assert.equal((await service.call("review.get", { runId: run.id })).card.prompt, prompt, "the open question keeps its old snapshot");
  return { run, prompt };
}

test("rubric grading marks the open snapshot without advancing the rewritten live question", async t => {
  const fake = createFakeModel(), payloads = [];
  const { service } = await library(t, { complete: async (system, prompt) => {
    if (system.startsWith("You grade")) payloads.push(JSON.parse(prompt));
    return fake(system, prompt);
  } });
  const { run, prompt } = await keptOpenSnapshot(service);
  const before = await service.call("export");
  await service.call("card.grade", { ...ref, runId: run.id, answer });
  assert.equal(payloads[0].questions[0].prompt, prompt);
  const after = await service.call("export"), entry = after.runs.find(item => item.id === run.id).entries[0];
  assert.deepEqual(after.decks[0].cards[0].review, before.decks[0].cards[0].review);
  assert.equal(entry.feedback.updatedAfterOpening, true);
  assert.equal(after.attempts[0].updatedAfterOpening, true);
  assert.deepEqual(after.attempts[0].before, after.attempts[0].after);
  const viewed = await service.call("review.get", { runId: run.id });
  assert.equal(viewed.navigation[0].level, "new");
  const fresh = await service.call("review.start", { mode: "path", scope: [ref], fresh: true });
  assert.equal(fresh.lastRubric, undefined, "the old snapshot grade is not the new question's last grading");
});

test("an old rubric snapshot does not add a review plan to a legacy card that has none", async t => {
  const { service } = await library(t);
  await service.store.update(state => {
    const snapshot = structuredClone(state.decks[0].cards[0]);
    snapshot.prompt = "Applying event-driven architecture, how should Orchard react to missing temperature readings? Justify.";
    state.runs.push({ id: "legacy-rubric-run", deckId: "orchard", mode: "path", scope: [ref], index: 0,
      startedAt: new Date().toISOString(), entries: [{ deckId: "orchard", card: snapshot, keepSnapshot: true,
        startedAt: Date.now(), feedback: null, revealed: false }] });
  });
  const before = await service.call("export");
  assert.equal(Object.hasOwn(before.decks[0].cards[0], "review"), false);
  await service.call("card.grade", { ...ref, runId: "legacy-rubric-run", answer });
  const after = await service.call("export");
  assert.equal(Object.hasOwn(after.decks[0].cards[0], "review"), false);
  assert.equal(after.attempts[0].updatedAfterOpening, true);
});

test("a question changed during card.grade refuses the outdated model result", async t => {
  const fake = createFakeModel();
  let markStarted, release;
  const started = new Promise(resolve => { markStarted = resolve; }), resumed = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { service } = await library(t, { complete: async (system, prompt) => {
    if (system.startsWith("You grade")) { markStarted(); await resumed; }
    return fake(system, prompt);
  } });
  const run = await service.call("review.start", { mode: "path", scope: [ref], fresh: true });
  const result = service.call("card.grade", { ...ref, runId: run.id, answer });
  await started;
  await service.call("card.update", { ...ref, patch: { prompt: "How should Orchard's monitoring platform detect the loss of temperature events?" } });
  const before = await service.call("export");
  release();
  await assert.rejects(result, /题目已更新|Question changed/i);
  const after = await service.call("export");
  assert.deepEqual(after.decks[0].cards[0].review, before.decks[0].cards[0].review);
  assert.equal(after.attempts.length, 0);
  assert.equal((await service.call("review.get", { runId: run.id })).feedback, null);
});

test("a standalone rubric call detects marks and criteria edited while the model is grading", async t => {
  const fake = createFakeModel();
  let markStarted, release;
  const started = new Promise(resolve => { markStarted = resolve; }), resumed = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { service } = await library(t, { complete: async (system, prompt) => {
    if (system.startsWith("You grade")) { markStarted(); await resumed; }
    return fake(system, prompt);
  } });
  const grading = service.call("card.grade", { ...ref, answer });
  await started;
  const draft = await service.call("deck.edit", { id: "orchard" }), edited = draft.cards.find(card => card.id === "q1");
  edited.marks = 7; edited.rubricCriteria[0].marks = 4; edited.rubric = renderRubric(edited.rubricCriteria, "en");
  await service.call("draft.save", { deck: draft });
  const publication = await service.call("draft.publish", { id: draft.id });
  assert.equal(publication.id, "orchard");
  const before = await service.call("export");
  assert.equal(before.decks[0].cards[0].marks, 7);
  release();
  await assert.rejects(grading, /题目已更新/);
  const after = await service.call("export");
  assert.deepEqual(after.decks[0].cards[0].review, before.decks[0].cards[0].review);
  assert.equal(after.attempts.length, 0);
  const current = await service.call("card.grade", { ...ref, answer });
  assert.equal(current.max, 7, "standalone practice can still grade the current question");
});

test("background rubric help also grades the open snapshot and leaves the current schedule unchanged", async t => {
  const fake = createFakeModel(), payloads = [];
  const { service, root } = await library(t, { complete: async (system, prompt) => {
    if (system.startsWith("You grade")) payloads.push(JSON.parse(prompt));
    return fake(system, prompt);
  } });
  const { run, prompt } = await keptOpenSnapshot(service), before = await service.call("export");
  const assist = createAssistService(); t.after(() => assist.dispose());
  const snapshot = before.runs.find(item => item.id === run.id).entries[0].card;
  await assist.startAssist({}, { root, service, sessionId: "panel", mode: "grade", ref, runId: run.id,
    text: answer, card: snapshot, deckTitle: "Orchard case", language: "en" });
  for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && assist.assistView(root).tasks.at(-1).status === "running";) await new Promise(resolve => setTimeout(resolve, 10));
  const done = assist.assistView(root).tasks.at(-1);
  assert.equal(done.status, "done", done.message);
  assert.equal(payloads[0].questions[0].prompt, prompt);
  const after = await service.call("export");
  assert.deepEqual(after.decks[0].cards[0].review, before.decks[0].cards[0].review);
  assert.equal(after.attempts[0].updatedAfterOpening, true);
});

test("case exam grading waits for submission and keeps the submitted answers immutable", async t => {
  let calls = 0;
  const fake = createFakeModel(), { service } = await library(t, { complete: async (system, prompt) => {
    if (system.startsWith("You grade")) calls++;
    return fake(system, prompt);
  } });
  const run = await service.call("review.start", { mode: "exam", examKinds: "case", deckId: "orchard", fresh: true });
  await service.call("review.answer", { runId: run.id, cardId: "q1", response: answer });
  await assert.rejects(service.call("card.grade", { ...ref, runId: run.id, answer }), /Submit|交卷/);
  assert.equal(calls, 0, "grading is refused before a model call");
  await service.call("exam.submit", { runId: run.id });
  await assert.rejects(service.call("card.grade", { ...ref, runId: run.id, answer: answer + "\nA revised answer after submission." }), /submitted answer|交卷.*答案/i);
  await assert.rejects(service.call("card.grade", { deckId: "orchard", cardId: "q2", runId: run.id, answer }), /submitted answer|交卷.*答案/i);
  assert.equal(calls, 0);
  const before = await service.call("exam.report", { runId: run.id });
  assert.deepEqual(before.case.questions.map(question => question.status), ["pending", "unanswered"]);
  const graded = await service.call("card.grade", { ...ref, runId: run.id, answer });
  assert.deepEqual(await service.call("card.grade", { ...ref, runId: run.id, answer }), graded);
  assert.equal((await service.call("export")).attempts.length, 1);
});

test("a submitted case paper cannot be regraded with a different first answer", async t => {
  const { service } = await library(t);
  const run = await service.call("review.start", { mode: "exam", examKinds: "case", deckId: "orchard", fresh: true });
  await service.call("review.answer", { runId: run.id, cardId: "q1", response: answer });
  await service.call("exam.submit", { runId: run.id });
  await assert.rejects(service.call("card.grade", { ...ref, runId: run.id, answer: answer + "\nThis was added after submission." }), /submitted answer|交卷.*答案/i);
  const after = await service.call("export");
  assert.equal(after.runs.find(item => item.id === run.id).entries[0].response, answer);
  assert.equal(after.attempts.length, 0);
});

test("duplicate rubric grading is idempotent and a changed answer needs a new attempt", async (t) => {
  const { service } = await library(t);
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "orchard", cardId: "q1" }], fresh: true });
  const args = { runId: run.id, deckId: "orchard", cardId: "q1", answer };
  const first = await service.call("card.grade", args);
  const before = await service.call("export");
  const repeated = await service.call("card.grade", args);
  assert.deepEqual(repeated, first);
  const after = await service.call("export");
  assert.deepEqual(after.decks[0].cards[0].review, before.decks[0].cards[0].review);
  assert.deepEqual(after.attempts, before.attempts);
  assert.equal(after.inbox.length, before.inbox.length);
  await assert.rejects(service.call("card.grade", { ...args, answer: `${answer}\nA different answer.` }), /already.*different|已.*不同/i);
  assert.deepEqual((await service.call("export")).attempts, before.attempts);
});

test("concurrent rubric submissions only schedule one answer", async (t) => {
  const { service } = await library(t);
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "orchard", cardId: "q1" }], fresh: true });
  const args = { runId: run.id, deckId: "orchard", cardId: "q1", answer };
  const results = await Promise.all([service.call("card.grade", args), service.call("card.grade", args)]);
  assert.deepEqual(results[0], results[1]);
  const state = await service.call("export");
  assert.equal(state.attempts.length, 1);
  assert.equal(state.decks[0].cards[0].review.repetitions, 1);
});

test("a specified rubric run must exist and contain the graded card", async (t) => {
  const { service } = await library(t);
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "orchard", cardId: "q1" }], fresh: true });
  await assert.rejects(service.call("card.grade", { runId: "missing", deckId: "orchard", cardId: "q1", answer }), /Review.*not found|练习.*不存在/i);
  await assert.rejects(service.call("card.grade", { runId: run.id, deckId: "orchard", cardId: "q2", answer }), /does not belong|不在.*练习/i);
  assert.equal((await service.call("export")).attempts.length, 0);
});

test("a rubric tail retry records practice without scheduling it twice", async (t) => {
  const { service } = await library(t);
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "orchard", cardId: "q1" }], fresh: true });
  await service.call("card.grade", { runId: run.id, deckId: "orchard", cardId: "q1", answer });
  const before = await service.call("export");
  await service.store.update((state) => {
    const current = state.runs.find((item) => item.id === run.id);
    current.entries.push({ deckId: "orchard", card: structuredClone(state.decks[0].cards[0]), retry: true,
      startedAt: Date.now(), feedback: null, revealed: false });
    current.index = 1;
  });
  const args = { runId: run.id, deckId: "orchard", cardId: "q1", answer: `${answer}\nI would check the sensors too.` };
  const result = await service.call("card.grade", args);
  assert.deepEqual(await service.call("card.grade", args), result);
  const after = await service.call("export");
  assert.equal(after.attempts.length, 2);
  assert.equal(after.attempts[1].retry, true);
  assert.deepEqual(after.decks[0].cards[0].review, before.decks[0].cards[0].review);
});

test("a rubric card shows its marks and criteria labels before answering, never its key points", () => {
  const view = publicCard(card("q1", 1, "Event-driven architecture"));
  assert.equal(view.marks, 6);
  assert.deepEqual(view.rubricCriteria, [{ id: "c1", label: "Recommendation using Event-driven architecture", marks: 3 },
    { id: "c2", label: "Case linkage", marks: 2 }, { id: "c3", label: "Assumptions and trade-offs", marks: 1 }]);
  assert.doesNotMatch(JSON.stringify(view), /keyPoints|descriptor|alerting on missing readings/);
});

test("card.grade in a review run stores the graded answer like any answer: feedback, rubric attempt, SM-2 and an inbox letter", async (t) => {
  const { service } = await library(t);
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "orchard" }], fresh: true });
  assert.equal(run.card.id, "q1");
  assert.equal(run.card.marks, 6);
  const result = await service.call("card.grade", { runId: run.id, deckId: "orchard", cardId: "q1", answer });
  assert.equal(result.max, 6);
  const after = await service.call("review.get", { runId: run.id });
  assert.equal(after.revealed, true, "the reference answer is revealed once graded");
  assert.equal(after.solution.answer, "Use Event-driven architecture with alerting on missing readings.");
  assert.equal(after.solution.rubricCriteria[1].keyPoints[0], "The overnight power loss calls for alerting on missing readings");
  const rubric = after.feedback.rubric;
  assert.equal(rubric.max, 6);
  assert.equal(rubric.criteria.length, 3);
  assert.ok(rubric.criteria.every((criterion) => criterion.score <= criterion.max && Array.isArray(criterion.missing)));
  assert.ok(rubric.unanchored.some((item) => /Kubernetes/.test(item.quote)), "the recommendation without a case anchor is flagged");
  assert.equal(after.feedback.grade, result.grade);
  const state = await service.store.read();
  const attempt = state.attempts.find((item) => item.assessment === "rubric");
  assert.equal(attempt.runId, run.id);
  assert.equal(attempt.score, rubric.total);
  assert.deepEqual(attempt.rubric.criteria.map((criterion) => criterion.label), rubric.criteria.map((criterion) => criterion.label));
  assert.ok(state.decks[0].cards[0].review.due_at);
  assert.ok(state.inbox.some((item) => item.kind === "grade" && item.cardId === "q1"));
  // Opening the card again later shows the last grading.
  const fresh = await service.call("review.start", { mode: "path", scope: [{ deckId: "orchard", cardId: "q1" }], fresh: true });
  assert.equal(fresh.lastRubric.total, rubric.total);
  assert.equal(fresh.lastRubric.max, 6);
});

test("background help grades in mode 'grade' through the same commit", async (t) => {
  assert.throws(() => normalizeAssistRequest("grade", "   "), /写下你的回答/);
  assert.throws(() => normalizeAssistRequest("grade", answer, ["plain"]), /批改/);
  assert.equal(normalizeAssistRequest("grade", "x".repeat(5000)).answer.length, 5000, "a long answer is accepted");
  const { service, root } = await library(t);
  const assist = createAssistService();
  t.after(() => assist.dispose());
  const run = await service.call("review.start", { mode: "path", scope: [{ deckId: "orchard" }], fresh: true });
  const state = await service.store.read();
  const task = await assist.startAssist({}, { root, service, sessionId: "panel", mode: "grade", ref: { deckId: "orchard", cardId: "q1" },
    runId: run.id, text: answer, card: state.decks[0].cards[0], deckTitle: "Orchard case", language: "en" });
  assert.equal(task.mode, "grade");
  for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && assist.assistView(root).tasks.at(-1).status === "running";) await new Promise((resolve) => setTimeout(resolve, 10));
  const done = assist.assistView(root).tasks.at(-1);
  assert.equal(done.status, "done", done.message);
  const after = await service.call("review.get", { runId: run.id });
  assert.equal(after.feedback.rubric.max, 6);
  assert.ok((await service.store.read()).attempts.some((item) => item.assessment === "rubric" && item.runId === run.id));
});

test("case exam timing preserves the valid pace and reading time saved in its course profile", async t => {
  const { service } = await library(t);
  for (const minutesPerMark of [0.25, 15]) {
    await service.call("course.save", { name: "Cloud Native", exam: { format: "open-book-case", minutesPerMark, readingMinutes: 90 } });
    const profile = await service.call("course.profile", { name: "Cloud Native" });
    const run = await service.call("review.start", { mode: "exam", examKinds: "case", deckId: "orchard", fresh: true,
      paper: { minutesPerMark: profile.exam.minutesPerMark, readingMinutes: profile.exam.readingMinutes } });
    assert.equal(run.paper.minutesPerMark, minutesPerMark, "a valid course pace must not silently become 3 minutes per mark");
    assert.equal(run.paper.readingMinutes, 90, "a valid course reading period must not become the short default");
    assert.equal(run.paper.writingMinutes, 10 * minutesPerMark);
    assert.equal(run.paper.limitMs, (90 + run.paper.writingMinutes + 2) * 60000);
    const stored = (await service.store.read()).runs.find(item => item.id === run.id);
    assert.deepEqual(stored.paper, run.paper, "actual exam timing uses the same chosen values");
  }
});

test("a case paper is an exam run with its own time limit, typed answers, highlights, pacing and a per-question report", async (t) => {
  const { service } = await library(t);
  const run = await service.call("review.start", { mode: "exam", examKinds: "case", scope: [{ deckId: "orchard" }], fresh: true,
    paper: { minutesPerMark: 3, readingMinutes: 5, handwriting: false } });
  assert.equal(run.mode, "exam");
  assert.equal(run.total, 2);
  assert.equal(run.card.id, "q1", "the questions keep the paper's order");
  assert.deepEqual({ ...run.paper, limitMs: undefined }, { deckId: "orchard", minutesPerMark: 3, readingMinutes: 5, writingMinutes: 30, totalMarks: 10,
    handwriting: false, limitMs: undefined });
  assert.equal(run.paper.limitMs, (5 + 30 + 2) * 60000, "reading + writing + a short grace");
  assert.deepEqual(run.paperCards.map((item) => [item.id, item.marks]), [["q1", 6], ["q2", 4]], "the whole paper is on one page");
  assert.doesNotMatch(JSON.stringify(run.paperCards), /keyPoints|alerting on missing readings/);
  await service.call("review.answer", { runId: run.id, cardId: "q1", response: answer });
  const highlights = await service.call("review.highlights", { runId: run.id, highlights: [
    { id: "h1", paragraph: 3, start: 3, end: 20, color: "yellow", note: "power loss" }, { id: "h2", paragraph: 9, start: 0, end: 4, color: "green" }] });
  assert.deepEqual(highlights.highlights.map((item) => item.id), ["h1"], "highlights outside the case are dropped");
  const moved = await service.call("review.move", { runId: run.id, direction: 1 });
  assert.equal(moved.card.id, "q2");
  assert.deepEqual(moved.responses.map((item) => [item.cardId, item.response]), [["q1", answer], ["q2", ""]]);
  assert.equal(moved.highlights[0].note, "power loss");
  const report = await service.call("exam.submit", { runId: run.id, timings: { readingMs: 300000, writingMs: 1500000, perQuestion: { q1: 1500000 } } });
  assert.equal(report.case.pending, 1);
  assert.deepEqual(report.case.questions.map((question) => question.status), ["pending", "unanswered"]);
  assert.deepEqual(report.case.pacing.unanswered, ["q2"]);
  assert.deepEqual(report.case.pacing.overBudget, ["q1"], "25 minutes on an 18-minute question");
  await service.call("card.grade", { runId: run.id, deckId: "orchard", cardId: "q1", answer });
  const graded = await service.call("exam.report", { runId: run.id });
  assert.equal(graded.case.pending, 0);
  assert.equal(graded.case.questions[0].status, "graded");
  assert.equal(graded.case.max, 10);
  assert.equal(graded.case.total, graded.case.questions[0].total);
  assert.ok(graded.case.weakest.length >= 1 && graded.case.weakest.length <= 3);
  assert.ok(graded.case.weakest.every((item) => item.ratio < 1));
  const exams = (await service.call("snapshot")).exams;
  assert.equal(exams[0].runId, run.id);
});

test("the paper's time limit replaces the 30-minute default; a paper-practice run never expires", () => {
  const startedAt = new Date(Date.now() - 40 * 60000).toISOString();
  assert.equal(examExpired({ startedAt }), true, "ordinary exams keep 30 minutes");
  assert.equal(examExpired({ startedAt, paper: { limitMs: 60 * 60000 } }), false);
  assert.equal(examExpired({ startedAt, paper: { limitMs: 30 * 60000 } }), true);
  assert.equal(examExpired({ startedAt, paper: { limitMs: null, handwriting: true } }), false);
});

test("rubric skills over time feed 错题与待巩固 and 统计", () => {
  const attempt = (at, linkage, assumptions) => ({ assessment: "rubric", timestamp: at, rubric: { criteria: [
    { label: "Case linkage", score: linkage, max: 2 }, { label: "Assumptions and trade-offs", score: assumptions, max: 1 }] } });
  const skills = rubricSkills([attempt("2026-09-01", 0.5, 1), attempt("2026-09-08", 1, 0), { assessment: "self", grade: 2 }]);
  assert.deepEqual(skills.map((skill) => skill.label), ["Case linkage", "Assumptions and trade-offs"], "weakest first");
  assert.equal(skills[0].ratio, 0.375);
  assert.deepEqual(skills[0].trend, [0.25, 0.5]);
  assert.equal(skills[1].latest, 0);
});

test("RubricAnswer renders checkable criterion items with live count summary (#34)", async () => {
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { loadUi } = await import("./helpers/ui-module.mjs");
  const { RubricAnswer } = await loadUi("export { RubricAnswer } from './ui/CaseWorkspace.jsx';");
  const html = renderToStaticMarkup(React.createElement(RubricAnswer, {
    run: { id: "r-rubric", card: card("q1", 1, "Event-driven") },
    data: { model: { ready: true } },
    onSubmit() {},
  }));
  assert.match(html, /评分维度 · 已自检 0\/3 项/);
  const checks = [...html.matchAll(/type="checkbox"/g)];
  assert.equal(checks.length, 3, "one shared Checkbox per rubric criterion");
  assert.doesNotMatch(html, /<button[^>]*rubric-dim/i, "no raw button on rubric checklist items");
});

test("RubricAnswer persists checkedIds per question key and submits on IME-safe Ctrl/Cmd+Enter (#34)", { timeout: 60000 }, async (t) => {
  const { build } = await import("esbuild");
  const { launchChromium } = await import("../scripts/qa/browser.mjs");
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { RubricAnswer } from './ui/CaseWorkspace.jsx';
    import { StudyServicesContext } from './ui/study-context.jsx';
    import { setUiLanguage } from './ui/i18n.js';
    setUiLanguage('zh');
    window.__submits = [];
    const criteria = [
      { id: 'c1', label: 'Dim 1', marks: 3 },
      { id: 'c2', label: 'Dim 2', marks: 2 },
      { id: 'c3', label: 'Dim 3', marks: 1 },
    ];
    function Harness() {
      const [cfg, setCfg] = React.useState({ cardId: 'q1', ready: true, busy: false, running: false });
      const [mountKey, setMountKey] = React.useState(0);
      window.__setCfg = (patch) => setCfg((c) => ({ ...c, ...patch }));
      window.__remount = () => setMountKey((k) => k + 1);
      const services = React.useMemo(() => ({
        call: async () => ({}), act: async () => {}, busy: cfg.busy, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {},
      }), [cfg.busy]);
      return (
        <StudyServicesContext.Provider value={services}>
          <div className="study-app" key={mountKey}>
            <RubricAnswer
              run={{ id: 'run-34', card: { id: cfg.cardId, kind: 'open', marks: 6, rubricCriteria: criteria } }}
              data={{ root: 'root-34', model: { ready: cfg.ready, reason: cfg.ready ? '' : 'no-route' } }}
              task={cfg.running ? { status: 'running' } : null}
              onSubmit={(val) => window.__submits.push(val)}
            />
          </div>
        </StudyServicesContext.Provider>
      );
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip("Chromium unavailable"); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://test.local/**', (route) => route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' }));
  await page.goto('http://test.local/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('.rubric-dims').waitFor();

  // Expand criteria, check 2 items -> 已自检 2/3 项, persists across remount, resets for q2.
  await page.locator('.rubric-dims summary').click();
  const boxes = page.locator('.rubric-dims input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  assert.match(await page.locator('.rubric-dims summary').innerText(), /已自检 2\/3 项/);
  await page.evaluate(() => window.__remount());
  await page.locator('.rubric-dims').waitFor();
  await page.waitForFunction(() => /已自检 2\/3 项/.test(document.querySelector('.rubric-dims summary')?.innerText || ''));
  assert.match(await page.locator('.rubric-dims summary').innerText(), /已自检 2\/3 项/, 'checkedIds persist per key');
  await page.evaluate(() => window.__setCfg({ cardId: 'q2' }));
  await page.waitForFunction(() => /已自检 0\/3 项/.test(document.querySelector('.rubric-dims summary')?.innerText || ''));
  assert.match(await page.locator('.rubric-dims summary').innerText(), /已自检 0\/3 项/, 'distinct card key starts unchecked');
  await page.evaluate(() => window.__setCfg({ cardId: 'q1' }));
  await page.waitForFunction(() => /已自检 2\/3 项/.test(document.querySelector('.rubric-dims summary')?.innerText || ''));
  assert.match(await page.locator('.rubric-dims summary').innerText(), /已自检 2\/3 项/);

  // Ctrl+Enter guardrails: empty ignored, IME isComposing/keyCode 229 ignored, busy/grading/!ready ignored, valid submits.
  const input = page.locator('.rubric-editor__input');
  await input.focus();
  await page.keyboard.press('Control+Enter');
  assert.equal(await page.evaluate(() => window.__submits.length), 0, 'empty draft ignored');
  await input.fill('Use alerting on missing telemetry.');
  await page.evaluate(() => {
    const el = document.querySelector('.rubric-editor__input');
    const ime = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true });
    el.dispatchEvent(ime);
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    el.dispatchEvent(legacy);
  });
  assert.equal(await page.evaluate(() => window.__submits.length), 0, 'IME Enter ignored');
  const submit = page.getByRole('button', { name: '提交批改', exact: true });
  await page.evaluate(() => window.__setCfg({ busy: true }));
  await submit.and(page.locator(':disabled')).waitFor();
  await input.press('Control+Enter');
  assert.equal(await page.evaluate(() => window.__submits.length), 0, 'busy ignored');
  await page.evaluate(() => window.__setCfg({ busy: false, running: true }));
  await input.and(page.locator('[readonly]')).waitFor();
  await input.press('Control+Enter');
  assert.equal(await page.evaluate(() => window.__submits.length), 0, 'grading ignored');
  await page.evaluate(() => window.__setCfg({ running: false, ready: false }));
  await input.and(page.locator(':read-write')).waitFor();
  await submit.waitFor({ state: 'hidden' });
  await input.press('Control+Enter');
  assert.equal(await page.evaluate(() => window.__submits.length), 0, 'unready model ignored');
  await page.evaluate(() => window.__setCfg({ ready: true }));
  await submit.and(page.locator(':enabled')).waitFor();
  await input.press('Control+Enter');
  assert.deepEqual(await page.evaluate(() => window.__submits), ['Use alerting on missing telemetry.']);
  assert.deepEqual(errors, []);
});
