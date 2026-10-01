import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StudyService } from "../lib/service.js";

const card = (id, topic) => ({ id, kind: "flashcard", topic, prompt: `${topic} 是什么？`,
  answer: `${topic} 的参考要点`, citations: [] });
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-oral-"));
  const service = new StudyService(root, options);
  await service.store.update((state) => {
    state.decks.push({ id: "d", title: "岗位基础", cards: [card("a", "架构"), card("b", "性能"), card("c", "安全")] });
    state.focus = { mode: "interview", role: "Platform Engineer", targetTopics: ["架构", "性能"] };
  });
  return service;
}

test("oral mock covers target topics, saves answers and follow-ups without mid-run grading", async () => {
  const service = await fixture();
  await service.store.update((state) => {
    state.decks[0].cards[0].kind = "quiz";
    state.decks[0].cards[0].options = [
      { id: "yes", text: "正确选项", correct: true },
      { id: "no", text: "干扰选项", correct: false },
    ];
  });
  const run = await service.call("oral.start", { count: 2 });
  assert.equal(run.total, 2);
  assert.equal(run.role, "Platform Engineer");
  assert.equal(run.entry.topic, "架构");
  assert.equal(run.entry.answer, "");
  assert.equal(run.entry.expected, undefined);
  assert.deepEqual(run.entry.options, [{ id: "yes", text: "正确选项" }, { id: "no", text: "干扰选项" }]);
  await service.call("oral.answer", { runId: run.id, cardId: run.entry.cardId, answer: "我先说概念和例子" });
  const followup = await service.call("oral.followup", { runId: run.id, cardId: run.entry.cardId });
  assert.match(followup.entry.followup, /边界|反例/);
  await service.call("oral.answer", { runId: run.id, cardId: run.entry.cardId,
    field: "followup", answer: "边界是资源限制" });
  const next = await service.call("oral.next", { runId: run.id });
  assert.equal(next.entry.topic, "性能");
  assert.equal((await service.call("export")).attempts.length, 0);
  const report = await service.call("oral.submit", { runId: run.id });
  assert.equal(report.feedbackStatus, "unassessed");
  assert.equal(report.assessed, 0);
  assert.equal(report.answered, 1);
  assert.equal((await service.call("export")).attempts.length, 0);
  assert.equal((await service.call("oral.active")), null);
  assert.equal((await new StudyService(service.store.root).call("oral.report", { runId: run.id })).entries[0].followupAnswer, "边界是资源限制");
});

test("oral feedback is recorded separately after submission and updates shared review progress once", async () => {
  const service = await fixture({
    complete: async () => JSON.stringify({ results: [
      { cardId: "a", band: "strong", reason: "解释了边界" },
      { cardId: "b", band: "weak", reason: "缺少性能指标" },
    ] }),
  });
  const start = await service.call("oral.start", { count: 2 });
  await service.call("oral.answer", { runId: start.id, cardId: "a", answer: "架构回答" });
  await service.call("oral.next", { runId: start.id });
  await service.call("oral.answer", { runId: start.id, cardId: "b", answer: "性能回答" });
  const before = await service.call("export");
  assert.equal(before.attempts.length, 0);
  const report = await service.call("oral.submit", { runId: start.id });
  assert.equal(report.feedbackStatus, "assessed");
  assert.equal(report.strong, 1);
  assert.equal(report.weak, 1);
  assert.deepEqual(report.weakTopics.map((row) => row.topic), ["性能"]);
  assert.deepEqual(report.weakScope, [{ deckId: "d", cardId: "b" }]);
  const persisted = await service.call("export");
  assert.deepEqual(persisted.attempts.map((item) => item.assessment), ["oral", "oral"]);
  assert.ok(persisted.decks[0].cards[0].review);
  assert.equal(persisted.runs.length, 0, "oral performance remains separate from written runs");
  assert.equal((await service.call("snapshot")).oralExams[0].strong, 1);
  await service.call("oral.submit", { runId: start.id });
  assert.equal((await service.call("export")).attempts.length, 2);
});

test("written mock in interview mode covers target topics and reserves a small weak-card share", async () => {
  const service = await fixture();
  await service.store.update((state) => {
    state.decks[0].cards = [
      ...[1, 2, 3].map((n) => card(`architecture-${n}`, "架构")),
      ...[1, 2, 3].map((n) => card(`performance-${n}`, "性能")),
      card("safety-1", "安全"),
    ].map((item) => ({ ...item, kind: "quiz", options: [
      { id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false },
      { id: "c", text: "C", correct: false },
    ] }));
    state.attempts.push({ id: "old-weak", deckId: "d", quiz_id: "architecture-1", grade: 1 });
  });
  const run = await service.call("review.start", { mode: "exam", count: 4, fresh: true });
  const stored = (await service.call("export")).runs.find((item) => item.id === run.id);
  assert.equal(stored.entries.length, 4);
  assert.ok(stored.entries.every((entry) => ["架构", "性能"].includes(entry.card.topic)));
  assert.ok(new Set(stored.entries.map((entry) => entry.card.topic)).size >= 2);
  assert.ok(stored.entries.some((entry) => entry.card.id === "architecture-1"));
  assert.deepEqual(stored.examTargetTopics, ["架构", "性能"]);
  const explicit = await service.call('review.start', { mode: 'exam', scope: [{ deckId: 'd', cardId: 'safety-1' }], count: 4, fresh: true });
  assert.equal(explicit.total, 1, 'an explicit written question wins over the old JD');
  assert.equal(explicit.card.id, 'safety-1');
  assert.deepEqual((await service.call('export')).runs.find(item => item.id === explicit.id).examTargetTopics, []);
});

test('oral class ignores an old JD while explicit card and topic scopes override interview targets', async () => {
  const service = await fixture();
  await service.store.update(state => { state.focus.mode = 'class'; });
  const classRun = await service.call('oral.start', { count: 3 });
  assert.equal(classRun.total, 3);
  assert.equal(classRun.role, '');
  await service.store.update(state => { state.focus.mode = 'interview'; });
  const exact = await service.call('oral.start', { scope: [{ deckId: 'd', cardId: 'c' }], count: 3 });
  assert.equal(exact.total, 1);
  assert.equal(exact.entry.cardId, 'c');
  const topic = await service.call('oral.start', { scope: [{ deckId: 'd', topic: '安全' }], count: 3 });
  assert.equal(topic.total, 1);
  assert.equal(topic.entry.topic, '安全');
  const all = await service.call('oral.start', { scope: [], count: 3 });
  assert.equal(all.total, 3);
  assert.deepEqual((await service.call('export')).oralRuns.at(-1).scope, []);
});
