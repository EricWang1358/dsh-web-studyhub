import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyService } from "../lib/service.js";
import { cognitiveLevel, debriefRules, evidenceWindows, runMetrics } from "../lib/coach.js";
import { createFakeModel } from "../scripts/fake-model.mjs";

const source = {
  id: "src",
  title: "Memento notes",
  text: "The Caretaker manages snapshot history without inspecting snapshot contents. A Memento stores an opaque snapshot of internal state. The Originator creates and restores its own snapshots.",
};
const quiz = (n, prompt, topic = "Memento") => ({
  id: `q${n}`,
  kind: "quiz",
  topic,
  objective: `objective ${n}`,
  prompt,
  answer: "Caretaker",
  hint: "Who keeps the history?",
  explanation: "The Caretaker keeps history; the Originator restores state.",
  misconception: "Treating the Memento as the history manager.",
  citations: [{ sourceId: "src", quote: "The Caretaker manages snapshot history without inspecting snapshot contents." }],
  options: [
    { id: "a", text: "Caretaker", correct: true, explanation: "It manages history without reading snapshots." },
    { id: "b", text: "Memento", correct: false, explanation: "It is the snapshot, not its manager." },
    { id: "c", text: "Originator", correct: false, explanation: "It creates and restores snapshots." },
  ],
});
const prompts = [
  "Memento 模式中哪个角色管理历史？",
  "Caretaker 和 Memento 的区别是什么？",
  "为什么 Caretaker 不读取快照内容？",
  "Originator 负责哪一步？",
  "谁创建快照？",
];

async function setup(t, { coach = true, latencyMs = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-coach-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = [];
  const light = createFakeModel({ latencyMs, log });
  const service = new StudyService(root, { complete: light, completeLight: light, coach });
  await service.call("source.add", source);
  await service.call("draft.save", { deck: { id: "d", title: "Patterns", cards: prompts.map((p, i) => quiz(i + 1, p)) } });
  await service.call("draft.publish", { id: "d" });
  return { root, service, log, light };
}
const tasks = (log, word) => log.filter((x) => x.prompt.includes(word)).length;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("cognitive level is decided by wording without a model", () => {
  assert.equal(cognitiveLevel({ prompt: "Memento 是什么？" }), "recall");
  assert.equal(cognitiveLevel({ prompt: "Caretaker 和 Memento 的区别？" }), "concept");
  assert.equal(cognitiveLevel({ prompt: "Caretaker 和 Memento 的区别是什么？" }), "concept", "contrast beats 是什么");
  assert.equal(cognitiveLevel({ prompt: "某团队在设计撤销功能时应该怎么划分职责？" }), "apply");
  assert.equal(cognitiveLevel({ prompt: "Given a payment service, which would you choose?" }), "apply");
  assert.equal(cognitiveLevel({ prompt: "区别？" }, "apply"), "apply", "a stored level overrides the heuristic");
});

test("evidence windows are exact source slices around cited quotes within budget", () => {
  const long = { id: "L", title: "Long", text: "x".repeat(5000) + source.text + "y".repeat(5000) };
  const windows = evidenceWindows([long], [quiz(1, "p")].map((c) => ({ ...c, citations: [{ sourceId: "L", quote: c.citations[0].quote }] })), { radius: 100 });
  assert.equal(windows.length, 1);
  assert.ok(long.text.includes(windows[0].text));
  assert.ok(windows[0].text.includes(source.text.slice(0, 60)));
  assert.ok(windows[0].text.length < 500);
});

test("a wrong answer prefetches one nudge; the panel reuses it and correct answers cost nothing", async (t) => {
  const { service, log } = await setup(t, { latencyMs: 20 });
  let run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  const wrongId = run.card.options.find((o) => o.text !== "Caretaker").id;
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [wrongId] });
  const [a, b] = await Promise.all([service.call("coach.nudge", { runId: run.id }), service.call("coach.nudge", { runId: run.id })]);
  assert.equal(tasks(log, "刚答错"), 1, "prefetch and two panel requests share one model call");
  assert.equal(a.thread.length, 1);
  assert.deepEqual(a.thread, b.thread);
  const note = a.thread[0];
  assert.ok(note.point && note.explain);
  assert.equal(note.check.answer, undefined, "the check key stays hidden until tapped");
  const view = await service.call("review.get", { runId: run.id });
  assert.equal(view.coach[0].id, note.id, "the review projection carries the thread");
  assert.equal(view.level, cognitiveLevel(run.card));

  const checked = await service.call("coach.reply", { noteId: note.id, reply: "check", choice: 1 });
  assert.deepEqual(checked.thread[0].checked, { choice: 1, correct: true });
  assert.equal(checked.thread[0].check.answer, 1);
  const confused = await service.call("coach.reply", { noteId: note.id, reply: "confused" });
  assert.equal(confused.thread[0].followups.length, 1);
  await service.call("coach.reply", { noteId: note.id, reply: "confused" });
  await service.call("coach.reply", { noteId: note.id, reply: "confused" });
  assert.equal(tasks(log, "仍然不懂"), 2, "at most two extra explanations per point");

  run = await service.call("review.move", { runId: run.id, direction: 1 });
  const before = log.length;
  await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options.find((o) => o.text === "Caretaker").id] });
  await settle();
  assert.equal(log.length, before, "a correct answer makes no model call");
  const learner = (await service.call("export")).learner;
  assert.equal(learner.signals.got, 1);
  assert.equal(learner.signals.confused, 3);
});

test("without the coach flag answering never calls the model", async (t) => {
  const { service, log } = await setup(t, { coach: false });
  const run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options.find((o) => o.text !== "Caretaker").id] });
  await settle();
  assert.equal(log.length, 0);
});

test("thumbs-down tags rewrite the card in the background without wiping the answered question", async (t) => {
  const { service, log } = await setup(t);
  let run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options[0].id] });
  const ref = { deckId: "d", cardId: run.card.id };
  const result = await service.call("coach.feedback", { ...ref, vote: "down", tags: ["bad-options", "nonsense"] });
  assert.deepEqual(result.tags, ["bad-options"]);
  assert.deepEqual(result.scheduled, ["rewrite"]);
  const again = await service.call("coach.feedback", { ...ref, vote: "down", tags: ["bad-options"] });
  assert.deepEqual(again.scheduled, [], "repeating a tag does not rewrite twice");
  await service.call("coach.prepare"); // drains the background coach queue
  const state = await service.call("export");
  const card = state.decks[0].cards.find((c) => c.id === ref.cardId);
  assert.match(card.options[0].explanation, /已按反馈/);
  assert.equal(state.feedback.length, 1);
  assert.equal(tasks(log, "反馈标签"), 1);
  const view = await service.call("review.get", { runId: run.id });
  assert.ok(view.feedback, "the answered question keeps its feedback after the rewrite");
  assert.ok(view.solution.options.some((o) => /已按反馈/.test(o.explanation)),
    "same answer key: the improved explanations show in place on the answered question");
  assert.equal(view.vote.vote, "down");
  const update = view.coach.find((n) => n.type === "update");
  assert.ok(update?.revertable);
  await service.call("coach.revert", ref);
  const reverted = (await service.call("export")).decks[0].cards.find((c) => c.id === ref.cardId);
  assert.doesNotMatch(reverted.options[0].explanation, /已按反馈/);
  assert.ok((await service.call("review.get", { runId: run.id })).feedback);
});

test("with consent, misses become validated variants that one tap turns into a practice run", async (t) => {
  const { service, log } = await setup(t);
  let run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options.find((o) => o.text !== "Caretaker").id] });
  await service.call("coach.prepare");
  assert.equal(tasks(log, "为每个 target"), 0, "no variants without consent");
  const status = await service.call("coach.consent", { prep: true });
  assert.equal(status.consent, true);
  const prepared = await service.call("coach.prepare");
  assert.equal(prepared.ready, 1);
  assert.equal(tasks(log, "为每个 target"), 1, "the recent miss is prepared in one batch");
  const practice = await service.call("coach.practice");
  assert.equal(practice.mode, "path");
  assert.equal(practice.total, 1);
  const state = await service.call("export");
  const deck = state.decks.find((d) => d.systemKind === "coach");
  assert.equal(deck.title, "为你定制");
  assert.equal(deck.cards[0].origin.cardId, run.card.id);
  assert.equal(state.learner.levels[deck.cards[0].id], "apply");
  assert.equal((await service.call("coach.status")).ready, 0);
  await assert.rejects(service.call("coach.practice"), /还没有备好/);
});

test("debrief turns a concept-only session into an application offer and updates the profile once", async (t) => {
  const { service, log } = await setup(t);
  await service.call("coach.consent", { prep: true });
  await service.call("coach.goal", { goal: "work" });
  let run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  while (!run.complete) {
    run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options.find((o) => o.text === "Caretaker").id] });
    run = await service.call("review.move", { runId: run.id, direction: 1 });
  }
  const [debrief, twin] = await Promise.all([service.call("coach.debrief", { runId: run.id }), service.call("coach.debrief", { runId: run.id })]);
  assert.equal(twin.at, debrief.at, "prefetch and summary requests share one debrief");
  assert.equal(debrief.insights[0].code, "concept-only");
  assert.equal(debrief.headline, "概念会了，别停在纸上谈兵");
  assert.equal(debrief.preparing, true);
  await service.call("coach.prepare");
  assert.ok((await service.call("coach.status")).ready >= 1);
  const again = await service.call("coach.debrief", { runId: run.id });
  assert.equal(again.at, debrief.at, "a finished run's debrief is cached");
  assert.equal(tasks(log, "本轮指标"), 1);
  const learner = (await service.call("export")).learner;
  assert.match(learner.summary, /工作中落地/);
});

test("debrief rules need no model", () => {
  const metrics = { answered: 6, correct: 6, accuracy: 100, lowShare: 100, levels: { recall: { n: 2, correct: 2 }, concept: { n: 4, correct: 4 }, apply: { n: 0, correct: 0 } }, weakTopics: [], tags: {} };
  const rules = debriefRules(metrics, { consent: true, modelReady: true });
  assert.equal(rules.insights[0].code, "concept-only");
  assert.equal(rules.wantsPrep, true);
  assert.equal(debriefRules(metrics, { ready: 3 }).next, "practice_prepared");
  assert.equal(runMetrics({ feedback: [], learner: null }, { entries: [] }).answered, 0);
});

test("snapshot polling returns unchanged when nothing visible moved", async (t) => {
  const { service } = await setup(t, { coach: false });
  const first = await service.call("snapshot");
  assert.ok(first.fingerprint);
  assert.deepEqual(await service.call("snapshot", { since: first.fingerprint }), { unchanged: true, fingerprint: first.fingerprint });
  const read = service.store.read;
  service.store.read = () => assert.fail("an unchanged poll must not read the library");
  assert.equal((await service.call("snapshot", { since: first.fingerprint })).unchanged, true);
  service.store.read = read;
  await service.call("coach.goal", { goal: "exam" });
  const next = await service.call("snapshot", { since: first.fingerprint });
  assert.equal(next.unchanged, undefined);
  assert.equal(next.coach.goal, "exam");
});

test("the learner can inspect and clear what the coach remembers", async (t) => {
  const { service } = await setup(t, { coach: false });
  await service.call("coach.consent", { prep: true });
  await service.call("coach.goal", { goal: "interview" });
  assert.deepEqual((({ consent, goal }) => ({ consent, goal }))(await service.call("coach.profile")), { consent: true, goal: "interview" });
  await assert.rejects(service.call("coach.goal", { goal: "hack" }), /Unknown goal/);
  const cleared = await service.call("coach.forget");
  assert.equal(cleared.goal, "");
  assert.equal(cleared.consent, null);
  const state = await service.call("export");
  assert.equal(state.learner.summary, "");
  assert.ok(state.decks[0].cards.length, "practice data is untouched");
});

test("a rewrite that changes the answer key keeps the answered snapshot until the next attempt", async (t) => {
  const { root } = await setup(t, { coach: false });
  const flip = async (system, prompt) => JSON.parse(prompt).task.includes("反馈标签")
    ? JSON.stringify({ patch: { options: [{ id: "a", correct: false }, { id: "b", correct: true }], answer: "Memento" }, summary: "更正答案" })
    : "{}";
  const service = new StudyService(root, { complete: flip, completeLight: flip, coach: true });
  let run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options[0].id] });
  await service.call("coach.feedback", { deckId: "d", cardId: run.card.id, vote: "down", tags: ["wrong-answer"] });
  await service.call("coach.prepare");
  const live = (await service.call("export")).decks[0].cards.find((c) => c.id === run.card.id);
  assert.equal(live.options.find((o) => o.correct).id, "b", "the library card has the corrected key");
  const view = await service.call("review.get", { runId: run.id });
  assert.equal(view.solution.options.find((o) => o.correct).id, "a", "the answered entry still grades against what was answered");
  assert.ok(view.feedback);
});

test("a 太难 scaffold becomes a prerequisite of its original and variants show where they came from", async (t) => {
  const { service } = await setup(t);
  await service.call("coach.consent", { prep: true });
  const run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  const origin = run.card.id;
  await service.call("coach.feedback", { deckId: "d", cardId: origin, vote: "down", tags: ["too-hard"] });
  await service.call("coach.prepare");
  const practice = await service.call("coach.practice");
  assert.equal(practice.origin.reason, "too-hard");
  assert.equal(practice.origin.cardId, origin);
  const state = await service.call("export");
  const scaffold = state.decks.find((d) => d.systemKind === "coach").cards[0];
  assert.equal(scaffold.kind, "flashcard");
  assert.deepEqual(state.decks[0].cards.find((c) => c.id === origin).requires, [{ deckId: practice.deckId, cardId: scaffold.id }]);
});

test("an answered entry frozen by an older coach fix heals to the new wording when the key is unchanged", async (t) => {
  const { service } = await setup(t, { coach: false });
  let run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options[0].id] });
  // Simulate the old behaviour: library card reworded, open entry pinned to its snapshot.
  const { Store } = await import("../lib/store.js");
  await new Store(service.store.root).update((s) => {
    const card = s.decks[0].cards.find((c) => c.id === run.card.id);
    card.prompt = `${card.prompt}（按反馈补足了条件）`;
    s.runs.find((r) => r.id === run.id).entries[run.index].keepSnapshot = true;
  });
  const view = await service.call("review.get", { runId: run.id });
  assert.match(view.card.prompt, /补足了条件/);
  assert.ok(view.feedback, "the learner's result stays");
  assert.equal(view.contentUpdated, false);
});

test("source.search finds terms across every source in one call and returns only snippets", async (t) => {
  const { service } = await setup(t, { coach: false });
  const filler = "Architecture views describe a system from the viewpoint of its stakeholders. ".repeat(40);
  await service.call("source.add", { id: "scrum", title: "Agile notes", text: `${filler}The Scrum Master facilitates the team, while the Product Owner owns the backlog. ${filler}` });
  await service.call("source.add", { id: "ops", title: "Ops", text: `${filler}The system owner funds and accepts the system.` });
  const found = await service.call("source.search", { query: "Scrum Master | Product Owner | system owner" });
  assert.deepEqual(found.terms, ["scrum master", "product owner", "system owner"]);
  assert.equal(found.searchedSources, 3);
  assert.deepEqual(found.results.map((r) => r.sourceId), ["scrum", "ops"], "sources matching more terms rank first");
  const snippet = found.results[0].snippets[0];
  assert.ok(snippet.text.length < 400, "a snippet, not the document");
  assert.ok(snippet.text.includes("Scrum Master"));
  const page = await service.call("source.get", { id: "scrum", offset: snippet.offset, limit: 300 });
  assert.ok(page.text.startsWith(snippet.text.slice(0, 50)), "offsets point back into source.get");
  assert.equal((await service.call("source.search", { query: "Kubernetes" })).matchedSources, 0);
  assert.deepEqual((await service.call("source.search", { query: "agile  scrum" })).terms, ["agile", "scrum"]);
  await assert.rejects(service.call("source.search", { query: " " }), /at least one term/);
  const list = await service.call("source.list", { query: "ops" });
  assert.deepEqual(list.sources.map((x) => x.id), ["ops"]);
  assert.equal(list.sources[0].text, undefined);
  const cards = await service.call("card.search", { query: "Caretaker 区别" });
  assert.ok(cards.results.length >= 1);
  assert.ok(cards.results.every((c) => c.cardId && c.deckId && c.prompt.length <= 160));
});

test("a stem rewrite on a cloze card changes the text the learner sees, without a false 'answer again' warning", async (t) => {
  const { root } = await setup(t, { coach: false });
  const quote = "The Caretaker manages snapshot history without inspecting snapshot contents.";
  const rewrite = async (system, prompt) => {
    const data = JSON.parse(prompt);
    if (!data.task.includes("反馈标签")) return "{}";
    assert.equal(data.card.cloze.text, "谁管理快照历史？{{who}}", "the model sees the displayed cloze text");
    return JSON.stringify({ patch: { prompt: "在 Memento 模式里，不读取快照内容却负责管理历史的角色是{{who}}。" }, summary: "补足条件" });
  };
  const service = new StudyService(root, { complete: rewrite, completeLight: rewrite, coach: true });
  await service.call("draft.save", { deck: { id: "c", title: "Cloze", cards: [{
    id: "z1", kind: "cloze", topic: "Memento", objective: "cloze objective", prompt: "谁管理快照历史？{{who}}", answer: "Caretaker",
    hint: "不是快照本身", explanation: "Caretaker 管理历史。", misconception: "以为是 Memento。", citations: [{ sourceId: "src", quote }],
    cloze: { text: "谁管理快照历史？{{who}}", answers: [{ id: "who", value: "Caretaker" }] },
  }] } });
  await service.call("draft.publish", { id: "c" });
  const run = await service.call("review.start", { deckId: "c", mode: "quiz" });
  await service.call("coach.feedback", { deckId: "c", cardId: "z1", vote: "down", tags: ["stem-vague"] });
  await service.call("coach.prepare");
  const view = await service.call("review.get", { runId: run.id });
  assert.match(view.card.cloze.text, /不读取快照内容/, "the shown cloze text follows the reworded stem");
  assert.equal(view.card.cloze.blanks.length, 1);
  assert.equal(view.contentUpdated, false, "an unanswered question is not told to answer again");
  // Agents can also patch the displayed text directly.
  await service.call("card.update", { deckId: "c", cardId: "z1", patch: { cloze: { text: "管理历史而不读取快照的是{{who}}。" } }, reason: "wording" });
  assert.equal((await service.call("export")).decks.find((d) => d.id === "c").cards[0].cloze.answers[0].value, "Caretaker", "answers stay when only the text is patched");
});
