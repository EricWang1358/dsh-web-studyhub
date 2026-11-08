import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { startQuickSession } from "../lib/workflows.js";

const cards = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, kind: "flashcard", topic: `${prefix}-topic`, prompt: `${prefix}${i + 1}?`, answer: "a" }));
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-course-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const now = new Date().toISOString();
  await service.store.update((s) => {
    s.decks.push({ id: "c1", title: "01 概览", folder: "Cloud Native", cards: cards("a", 12) });
    s.decks.push({ id: "c2", title: "02 迁移", folder: "Cloud Native", cards: cards("b", 8) });
    s.decks.push({ id: "other", title: "别的课", folder: "PE", cards: cards("x", 5) });
    // Chapter one: the first 6 met, one of them weak.
    for (let i = 1; i <= 6; i++) s.attempts.push({ deckId: "c1", quiz_id: `a${i}`, grade: i === 2 ? 1 : 5, at: now });
    s.focus = { mode: "class", course: "Cloud Native", role: "", jd: "", targetTopics: [] };
  });
  return service;
}

test("the course route shows chapters in order and where the learner stands", async (t) => {
  const service = await setup(t);
  const route = await service.call("course.route");
  assert.equal(route.course, "Cloud Native");
  assert.deepEqual(route.chapters.map((c) => [c.title, c.learned, c.total, c.status]), [["01 概览", 6, 12, "current"], ["02 迁移", 0, 8, "upcoming"]]);
  assert.deepEqual([route.cards, route.learned, route.current], [20, 6, 0]);
  assert.deepEqual(route.next, { label: "01 概览 · 第 7–12 题 · 进入下一章", fresh: 10, reviews: 1 });
  const snapshot = await service.call("snapshot");
  assert.equal(snapshot.focus.route.next.fresh, 10, "the desk gets the route too");
});

test("继续课程 consolidates first, then goes on in order, and resumes an unfinished batch", async (t) => {
  const service = await setup(t);
  const run = await service.call("review.start", { mode: "course" });
  assert.equal(run.title, "课程 · Cloud Native");
  const ids = run.navigation.map((n) => n.cardId);
  assert.equal(ids[0], "a2", "the weak card comes first");
  assert.deepEqual(ids.slice(1), ["a7", "a8", "a9", "a10", "a11", "a12", "b1", "b2", "b3", "b4"], "then new cards in chapter order, into the next chapter");
  assert.equal(run.course.name, "Cloud Native");
  assert.deepEqual([run.course.learned, run.course.cards, run.course.chapter.title], [6, 20, "01 概览"]);
  const again = await service.call("review.start", { mode: "course" });
  assert.equal(again.id, run.id, "an unfinished batch is picked up where it stopped");
  const other = await service.call("review.start", { mode: "course", fresh: true, deckId: "c2", count: 3 });
  assert.notEqual(other.id, run.id);
  assert.deepEqual(other.navigation.map((n) => n.cardId).filter((id) => id.startsWith("b")), ["b1", "b2", "b3"], "a chapter can be started directly");
});

test("a fully introduced course still consolidates weak and due cards across its chapters", async (t) => {
  const service = await setup(t);
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  await service.store.update((state) => {
    for (const deck of state.decks.filter((item) => ["c1", "c2"].includes(item.id))) {
      for (const card of deck.cards) {
        const weak = card.id === "a2", due = card.id === "b8";
        card.review = { repetitions: weak ? 0 : 2, interval_days: weak ? 1 : 6,
          ease_factor: 2.5, due_at: due ? yesterday : tomorrow };
        state.attempts.push({ deckId: deck.id, quiz_id: card.id, grade: weak ? 1 : 5 });
      }
    }
  });
  const route = await service.call("course.route");
  assert.deepEqual([route.learned, route.cards, route.current, route.weak], [20, 20, null, 1]);
  assert.deepEqual(route.next, { label: "巩固已学的题", fresh: 0, reviews: 2 });
  const run = await service.call("review.start", { mode: "course" });
  assert.deepEqual(new Set(run.navigation.map((item) => item.cardId)), new Set(["a2", "b8"]));
  assert.equal(run.total, 2);
  assert.equal(run.course.learned, 20);
});

test("a fully mastered course without due cards has no next batch", async (t) => {
  const service = await setup(t);
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  await service.store.update((state) => {
    for (const deck of state.decks.filter((item) => ["c1", "c2"].includes(item.id))) {
      for (const card of deck.cards) {
        card.review = { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: tomorrow };
        state.attempts.push({ deckId: deck.id, quiz_id: card.id, grade: 5 });
      }
    }
  });
  const route = await service.call("course.route");
  assert.deepEqual([route.learned, route.mastered, route.weak, route.next], [20, 20, 0, null]);
  await assert.rejects(service.call("review.start", { mode: "course" }), /全部学完/);
});

test("先讲后练 workflow.quickstart is retired while historical route sessions remain readable", async (t) => {
  const service = await setup(t);
  await assert.rejects(() => service.call("workflow.quickstart", { course: true, requestId: "course-1" }), { code: "WORKFLOW_RETIRED" });
  let seeded;
  await service.store.update((state) => {
    seeded = startQuickSession(state, {
      goal: "01 概览 · 第 7–12 题 · 进入下一章",
      title: "01 概览 · 第 7–12 题 · 进入下一章",
      scope: [{ deckId: "c1", cardId: "a2" }, { deckId: "c1", cardId: "a7" }],
      course: { name: "Cloud Native", label: "01 概览 · 第 7–12 题 · 进入下一章" },
      method: "route",
      requestId: "legacy-route",
    });
  });
  const { session, resources } = await service.call("workflow.session.get", { id: seeded.id });
  assert.equal(session.pickedBy, "route");
  assert.equal(session.course.name, "Cloud Native");
  assert.equal(resources.cardCount, 2);
});
