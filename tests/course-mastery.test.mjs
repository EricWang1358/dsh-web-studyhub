import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const cards = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, kind: "flashcard", topic: "T", prompt: `${prefix}${i}?`, answer: "a" }));

test("map leads with the current course's mastery and keeps the whole library as context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-course-mastery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const now = new Date().toISOString();
  await service.store.update((s) => {
    s.decks.push({ id: "pe", title: "期末卷", folder: "Platform Engineering", cards: cards("p", 4) });
    s.decks.push({ id: "cn", title: "云原生", folder: "Cloud Native", cards: cards("c", 12) });
    // Every Platform Engineering card answered well; nothing in Cloud Native yet.
    for (let i = 0; i < 4; i++) s.attempts.push({ deckId: "pe", quiz_id: `p${i}`, grade: 5, at: now });
    s.focus = { mode: "class", course: "Platform Engineering", role: "", jd: "", targetTopics: [] };
  });
  let { mastery } = await service.call("map");
  assert.equal(mastery.course.name, "Platform Engineering");
  assert.equal(mastery.course.cards, 4);
  assert.equal(mastery.library.cards, 16);
  assert.ok(mastery.course.value > mastery.library.value, "the course figure is not diluted by other courses");
  assert.equal(mastery.library.value, Math.round(mastery.course.value * 4 / 16), "the library figure weighs every card");
  await service.call("focus.set", { course: "Cloud Native" });
  ({ mastery } = await service.call("map"));
  assert.deepEqual([mastery.course.name, mastery.course.value], ["Cloud Native", 0]);
  await service.call("focus.set", { mode: "interview", role: "SRE" });
  ({ mastery } = await service.call("map"));
  assert.equal(mastery.course, null, "interview focus has no course headline");
  assert.equal(mastery.library.cards, 16);
});

test("skeleton.topics pages the ungrouped topics so a large library never needs a shell to read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-topic-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update((s) => s.decks.push({ id: "d", title: "卷", folder: "PE",
    cards: ["A", "B", "C", "D", "E"].map((topic, i) => ({ id: `q${i}`, kind: "flashcard", topic, prompt: `${topic}?`, answer: "a" })) }));
  const all = await service.call("skeleton.topics", {});
  assert.ok(Array.isArray(all.groups.ungrouped), "without paging the result keeps its old shape");
  await service.call("topic.groups.save", { groups: [{ title: "第一组", topics: [all.topics[0].key] }] });
  const page = await service.call("skeleton.topics", { compact: true, ungrouped: true, limit: 2 });
  assert.equal(page.total, 4);
  assert.equal(page.topics.length, 2);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual(page.groups.groups.map((g) => g.title), ["第一组"]);
  assert.equal(page.groups.ungroupedCount, 4);
  assert.equal(page.groups.ungrouped, undefined, "a paged result does not repeat every key");
  // Group this page, then read again from offset 0: the next ungrouped ones come up.
  await service.call("topic.groups.save", { mode: "merge", groups: [{ title: "第一组", topics: page.topics.map((x) => x.key) }] });
  const next = await service.call("skeleton.topics", { compact: true, ungrouped: true, limit: 2 });
  assert.equal(next.total, 2);
  assert.equal(next.nextOffset, undefined);
  assert.ok(next.topics.every((x) => !page.topics.some((y) => y.key === x.key)));
});
