import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { emptyState } from "../lib/store.js";
import { focusProgress, focusCoverageOf, FOCUS_PRACTICE_LIMIT } from "../lib/focus-progress.js";
import { libraryContracts, studyToolDescription } from "../lib/study-contracts.js";
import { writesFor } from "../lib/runtime/domain-contracts.js";
import { assistantRefusal } from "../lib/assistant-boundary.js";

/* 重点 × 掌握度 (#690 S1): for each saved focus topic of a course, how many questions it has and how far the learner is.
   Pure: the state and a clock in, a plain object out; no model call and no storage. */

const NOW = Date.parse("2026-10-05T08:00:00Z");
const fresh = { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null };
const learned = (days, reps = 1) => ({ repetitions: reps, interval_days: days, ease_factor: 2.5, due_at: "2026-10-20T00:00:00Z" });
const card = (id, topic, extra = {}) => ({ id, kind: "flashcard", topic, objective: `Understand ${topic}`, prompt: `Question ${id}`, answer: "A", review: fresh, ...extra });
const attempt = (deckId, quiz_id, grade) => ({ deckId, quiz_id, grade, timestamp: "2026-10-04T08:00:00Z" });

function library() {
  const state = emptyState();
  state.courses = [
    { id: "c-os", name: "OS", focusTopics: ["死锁", "信号量", "页面置换"] },
    { id: "c-ch3", name: "OS / 第 3 章", focusTopics: ["TLB"] },
  ];
  state.decks = [
    { id: "d-os", title: "OS basics", course: "OS", cards: [
      card("dead-weak", "死锁条件"),
      card("dead-ok", "死锁预防", { review: learned(30, 3) }),
      card("sem-new-a", "信号量"),
      card("sem-new-b", "信号量 PV"),
      card("unrelated", "调度"),
      card("both", "信号量与死锁的关系", { review: learned(2) }),
      card("sus", "死锁检测", { suspended: true }),
    ] },
    { id: "d-ch3", title: "Chapter 3", course: "OS / 第 3 章", cards: [card("tlb-1", "TLB 命中率", { review: learned(8) })] },
    { id: "d-old", title: "Archived", course: "OS", archived: true, cards: [card("arch", "页面置换算法")] },
  ];
  state.attempts = [attempt("d-os", "dead-weak", 1), attempt("d-os", "dead-ok", 5), attempt("d-os", "both", 4)];
  return state;
}

test("a course without focus topics answers at once with an empty readout", () => {
  const state = library();
  state.courses = [];
  assert.deepEqual(focusProgress(state, "OS", { now: NOW }), { course: "OS", topics: [], total: 0, done: 0, weak: 0, none: 0, weakScope: [] });
  assert.equal(focusProgress(emptyState(), null, { now: NOW }).total, 0);
  assert.equal(focusProgress(library(), "*", { now: NOW }).total, 0, "all courses is not a course");
});

test("each saved topic counts its questions by level and takes the status of its worst question", () => {
  const progress = focusProgress(library(), "OS", { now: NOW });
  const by = Object.fromEntries(progress.topics.map(item => [item.topic, item]));
  assert.deepEqual(Object.keys(by).sort(), ["TLB", "信号量", "死锁", "页面置换"].sort(), "a chapter's topics count when viewing the whole course");
  // 死锁: one weak, one mastered, one matching both topics (learning); the suspended one is out.
  assert.equal(by["死锁"].cards, 3);
  assert.deepEqual(by["死锁"].counts, { new: 0, weak: 1, learning: 1, familiar: 0, mastered: 1 });
  assert.equal(by["死锁"].status, "weak");
  assert.deepEqual(by["死锁"].weakCards, [{ deckId: "d-os", cardId: "dead-weak" }]);
  // 信号量: two new and the shared one.
  assert.equal(by["信号量"].cards, 3);
  assert.equal(by["信号量"].counts.new, 2);
  assert.equal(by["信号量"].status, "active");
  assert.deepEqual(by["信号量"].weakCards, []);
  // 页面置换: only the archived deck has a question, which does not count.
  assert.equal(by["页面置换"].cards, 0);
  assert.equal(by["页面置换"].status, "none");
  assert.equal(by["页面置换"].mastery, 0);
  // TLB: one familiar question in the chapter deck.
  assert.equal(by["TLB"].counts.familiar, 1);
  assert.equal(by["TLB"].mastery, 75);
});

test("a topic is done only at 80% mastery with no weak question, all new is todo", () => {
  const state = emptyState();
  state.courses = [{ id: "c", name: "Net", focusTopics: ["TCP", "UDP", "DNS"] }];
  state.decks = [{ id: "d", title: "Net", course: "Net", cards: [
    card("t1", "TCP", { review: learned(30, 3) }), card("t2", "TCP 拥塞", { review: learned(30, 3) }),
    card("u1", "UDP"), card("u2", "UDP 校验和"),
    card("n1", "DNS", { review: learned(30, 3) }), card("n2", "DNS 缓存", { review: learned(30, 3) }),
  ] }];
  state.attempts = [attempt("d", "n2", 1)];
  const by = Object.fromEntries(focusProgress(state, "Net", { now: NOW }).topics.map(item => [item.topic, item]));
  assert.equal(by.TCP.status, "done");
  assert.equal(by.UDP.status, "todo");
  assert.equal(by.DNS.status, "weak", "one weak answer holds a topic back whatever the average");
});

test("topics are ordered weak, none, then the rest, done last; ties keep the teacher's order", () => {
  const state = emptyState();
  state.courses = [{ id: "c", name: "Net", focusTopics: ["A 完成", "B 没有题", "C 还没学", "D 薄弱", "E 完成", "F 没有题", "G 学着"] }];
  state.decks = [{ id: "d", title: "Net", course: "Net", cards: [
    card("a", "A 完成", { review: learned(30, 3) }), card("e", "E 完成", { review: learned(30, 3) }),
    card("c", "C 还没学"), card("d", "D 薄弱"), card("g", "G 学着", { review: learned(2) }),
  ] }];
  state.attempts = [attempt("d", "d", 0)];
  const progress = focusProgress(state, "Net", { now: NOW });
  assert.deepEqual(progress.topics.map(item => item.topic), ["D 薄弱", "B 没有题", "F 没有题", "C 还没学", "G 学着", "A 完成", "E 完成"]);
  assert.deepEqual([progress.total, progress.done, progress.weak, progress.none], [7, 2, 1, 2]);
});

test("a chapter course inherits the parent's topics, and a card matching two topics counts under both", () => {
  const state = library();
  const chapter = focusProgress(state, "OS / 第 3 章", { now: NOW });
  assert.ok(chapter.topics.some(item => item.topic === "死锁"), "inherited from OS");
  assert.equal(chapter.topics.find(item => item.topic === "TLB").cards, 1);
  const whole = focusProgress(state, "OS", { now: NOW });
  const both = ["死锁", "信号量"].map(name => whole.topics.find(item => item.topic === name).counts.learning);
  assert.deepEqual(both, [1, 1]);
});

test("the weak scope lists each weak question once, in topic order, capped at one round", () => {
  const state = emptyState();
  state.courses = [{ id: "c", name: "Net", focusTopics: ["TCP", "UDP"] }];
  const cards = Array.from({ length: FOCUS_PRACTICE_LIMIT + 10 }, (_, i) => card(`q${i}`, i % 2 ? "TCP UDP" : "TCP"));
  state.decks = [{ id: "d", title: "Net", course: "Net", cards }];
  state.attempts = cards.map(c => attempt("d", c.id, 1));
  const progress = focusProgress(state, "Net", { now: NOW });
  assert.equal(progress.weakScope.length, FOCUS_PRACTICE_LIMIT);
  assert.equal(new Set(progress.weakScope.map(ref => ref.cardId)).size, FOCUS_PRACTICE_LIMIT, "a question matching two topics is listed once");
  assert.deepEqual(progress.weakScope[0], { deckId: "d", cardId: "q0" });
  assert.equal(progress.topics.find(item => item.topic === "UDP").weakCards.length, 30);
});

test("the readout is part of the snapshot only for a course with topics, and course.focusProgress reads any course without writing", async t => {
  const root = await mkdtemp(join(tmpdir(), "study-focus-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const state = library();
  await service.store.update(own => { own.courses = state.courses; own.decks = state.decks; own.attempts = state.attempts; });
  await service.call("focus.set", { course: "OS" });
  const before = JSON.stringify(await service.call("export"));
  const snapshot = await service.call("snapshot");
  assert.equal(snapshot.focus.progress.course, "OS");
  assert.equal(snapshot.focus.progress.weak, 1);
  const read = await service.call("course.focusProgress", { course: "OS / 第 3 章" });
  assert.equal(read.course, "OS / 第 3 章");
  assert.ok(read.topics.length >= 4);
  assert.equal((await service.call("course.focusProgress")).course, "OS", "the current course by default");
  assert.equal(JSON.stringify(await service.call("export")), before, "reading writes nothing");
  await service.call("focus.set", { course: null });
  await service.store.update(own => { own.courses = []; });
  assert.equal((await service.call("snapshot")).focus.progress, undefined, "a course without topics adds nothing to the snapshot");
});

test("course.focusProgress is declared read only, listed for discovery and described where the main chat reads about the plan", () => {
  assert.deepEqual(writesFor("library", "course.focusProgress"), []);
  assert.equal(assistantRefusal("course.focusProgress"), null);
  assert.match(studyToolDescription, /Discovery: [^\n]*book\.mock\.plan, course\.focusProgress, book\.toc/);
  assert.match(libraryContracts.plan, /course\.focusProgress \{course\?\} reads the course's saved focus topics/);
  assert.match(libraryContracts.plan, /weakScope/);
  assert.ok(libraryContracts.plan.length < 3000, "the plan area stays short enough to read in one go");
});

test("focusCoverageOf counts which saved focus topics have a matching active question and returns null without focus topics", () => {
  const state = library();
  assert.equal(focusCoverageOf(emptyState(), { course: "OS", cards: [] }), null);
  assert.equal(focusCoverageOf(state, { course: "*", cards: state.decks[0].cards }), null);
  const partial = focusCoverageOf(state, { course: "OS", cards: state.decks[0].cards });
  assert.deepEqual(partial, { total: 4, covered: 2, uncovered: ["页面置换", "TLB"] }, "suspended cards do not count; chapter focus topics are included");
  const full = focusCoverageOf(state, {
    course: "OS",
    cards: [...state.decks[0].cards, card("p1", "页面置换 LRU"), card("t1", "TLB 快表")],
  });
  assert.deepEqual(full, { total: 4, covered: 4, uncovered: [] });
});
