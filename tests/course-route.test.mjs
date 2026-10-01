import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

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

test("先讲后练 opens a guided session on exactly the next batch", async (t) => {
  const service = await setup(t);
  const { session, resources, method } = await service.call("workflow.quickstart", { course: true, requestId: "course-1" });
  assert.equal(method, "route");
  assert.equal(session.pickedBy, "route");
  assert.equal(session.topic, "01 概览 · 第 7–12 题 · 进入下一章");
  assert.deepEqual(session.course, { name: "Cloud Native", label: session.topic });
  assert.equal(resources.cardCount, 10);
  assert.equal(session.template.steps.find((s) => s.kind === "practice").count, 10, "it practises the batch it taught");
  await service.call('focus.set', { course: 'PE' });
  const next = await service.call('workflow.quickstart', { course: session.course.name, requestId: 'same-course' });
  assert.equal(next.session.course.name, 'Cloud Native');
  assert.ok(next.session.scope.every(ref => ['c1', 'c2'].includes(ref.deckId)));
});

test('guided fallback uses course ownership instead of chapter folder', async t => {
  const service = await setup(t);
  await service.store.update(s => { s.decks[0].course = 'Cloud Native'; s.decks[0].folder = 'Chapter folder'; });
  const result = await service.call('workflow.quickstart', { goal: 'unmatched subject xyz', requestId: 'fallback' });
  assert.ok(result.session.scope.some(ref => ref.deckId === 'c1'));
});
