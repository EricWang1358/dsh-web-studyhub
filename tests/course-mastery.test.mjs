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
  await assert.rejects(() => service.call("focus.set", { mode: "interview", role: "SRE" }), /课程|course/i);
  await service.call("course.save", { name: "笔试 / 面试 · SRE", interview: { role: "SRE" } });
  await service.call("focus.set", { course: "笔试 / 面试 · SRE" });
  ({ mastery } = await service.call("map"));
  assert.equal(mastery.course, null, "an empty interview course has no mastery figure yet");
  assert.equal(mastery.library.cards, 16);
  await service.store.update((s) => {
    s.decks.push({ id: "sre", title: "SRE 真题", course: "笔试 / 面试 · SRE", cards: cards("s", 2) });
  });
  ({ mastery } = await service.call("map"));
  assert.equal(mastery.course.name, "笔试 / 面试 · SRE", "interview prep is now its own course");
  assert.equal(mastery.course.cards, 2);
  assert.equal(mastery.library.cards, 18);
});

test("course mastery excludes paused sub-courses, still measures a focused paused course, and matches studyStats", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-course-mastery-paused-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const past = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const future = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();
  const masteredReview = { interval_days: 30, repetitions: 3, due_at: future };
  const makeCard = (id, extra = {}) => ({ id, kind: "flashcard", topic: "T", prompt: `${id}?`, answer: "a", ...extra });
  const passAttempt = (deckId, quizId) => ({ id: `a-${deckId}-${quizId}`, deckId, quiz_id: quizId, grade: 5, timestamp: past });

  await service.store.update((s) => {
    s.courses.push(
      { id: "c-os", name: "OS", active: true },
      { id: "c-os-old", name: "OS / Old", active: false },
      { id: "c-p", name: "P", active: false },
      { id: "c-a", name: "A", active: true },
      { id: "c-ab", name: "A / B", active: false },
      { id: "c-abc2", name: "A / B / C2", active: true },
      { id: "c-quiet", name: "Quiet", active: true },
      { id: "c-quiet-old", name: "Quiet / Old", active: false },
    );
    // (a) Active OS (9 cards: 4 mastered + 5 new => 44%) + paused OS / Old (2 cards: both mastered => 100%).
    s.decks.push(
      {
        id: "d-os",
        title: "OS Core",
        course: "OS",
        cards: [
          ...Array.from({ length: 4 }, (_, i) => makeCard(`om${i}`, { review: masteredReview })),
          ...Array.from({ length: 5 }, (_, i) => makeCard(`on${i}`)),
        ],
      },
      {
        id: "d-os-old",
        title: "OS Old",
        course: "OS / Old",
        cards: [makeCard("oo0", { review: masteredReview }), makeCard("oo1", { review: masteredReview })],
      },
      // (d) systemKind deck filed under OS must stay out of mastery.course but stay in mastery.library.
      {
        id: "d-os-slain",
        title: "OS Slain",
        course: "OS",
        systemKind: "slain",
        cards: [makeCard("sl0", { review: masteredReview })],
      },
      // (b2) Paused parent P + sub-course P / Sub (both included when P itself is focused).
      { id: "d-p", title: "P", course: "P", cards: [makeCard("p0")] },
      { id: "d-p-sub", title: "P Sub", course: "P / Sub", cards: [makeCard("ps0", { review: masteredReview })] },
      // (c1/c2) Deep nesting: A active (50%), A/B paused (100%), A/B/C1 inherits pause (100%), A/B/C2 explicitly active (100%).
      { id: "d-a", title: "A", course: "A", cards: [makeCard("a0", { review: masteredReview }), makeCard("a1")] },
      { id: "d-ab", title: "AB", course: "A / B", cards: [makeCard("ab0", { review: masteredReview }), makeCard("ab1", { review: masteredReview })] },
      { id: "d-abc1", title: "ABC1", course: "A / B / C1", cards: [makeCard("c10", { review: masteredReview }), makeCard("c11", { review: masteredReview })] },
      { id: "d-abc2", title: "ABC2", course: "A / B / C2", cards: [makeCard("c20", { review: masteredReview }), makeCard("c21", { review: masteredReview })] },
      // Empty/all-suspended active parent whose only learnable cards sit in a paused sub-course.
      { id: "d-quiet-susp", title: "Quiet Susp", course: "Quiet", cards: [makeCard("qs0", { suspended: true })] },
      { id: "d-quiet-old", title: "Quiet Old", course: "Quiet / Old", cards: [makeCard("qo0", { review: masteredReview }), makeCard("qo1", { review: masteredReview })] },
    );
    for (let i = 0; i < 4; i++) s.attempts.push(passAttempt("d-os", `om${i}`));
    s.attempts.push(
      passAttempt("d-os-old", "oo0"), passAttempt("d-os-old", "oo1"),
      passAttempt("d-os-slain", "sl0"),
      passAttempt("d-p-sub", "ps0"),
      passAttempt("d-a", "a0"),
      passAttempt("d-ab", "ab0"), passAttempt("d-ab", "ab1"),
      passAttempt("d-abc1", "c10"), passAttempt("d-abc1", "c11"),
      passAttempt("d-abc2", "c20"), passAttempt("d-abc2", "c21"),
      passAttempt("d-quiet-old", "qo0"), passAttempt("d-quiet-old", "qo1"),
    );
    s.focus = { mode: "class", course: "OS", role: "", jd: "", targetTopics: [] };
  });

  // (a) + (d): Active OS excludes paused OS / Old AND systemKind d-os-slain; library keeps d-os-slain + active courses.
  let map = await service.call("map");
  let stats = await service.call("stats", { course: "OS" });
  assert.deepEqual(map.mastery.course, { name: "OS", value: 44, cards: 9 }, "paused sub-course and system deck excluded from current course mastery");
  assert.equal(map.mastery.course.cards, stats.totals.cards, "course mastery card count matches studyStats({ course })");
  // Library active decks: d-os (9@44), d-os-slain (1@100), d-a (2@50), d-abc2 (2@100) => 14 cards, round((44*9 + 100 + 100 + 200)/14) = 57%.
  assert.deepEqual(map.mastery.library, { value: 57, cards: 14 }, "library mastery includes active courses and system decks, excludes paused courses");

  // (b1): Focused course itself is paused => still measured.
  await service.call("focus.set", { course: "OS / Old" });
  map = await service.call("map");
  stats = await service.call("stats", { course: "OS / Old" });
  assert.deepEqual(map.mastery.course, { name: "OS / Old", value: 100, cards: 2 });
  assert.equal(map.mastery.course.cards, stats.totals.cards);

  // (b2): Focused parent course itself is paused => includes its sub-courses.
  await service.call("focus.set", { course: "P" });
  map = await service.call("map");
  stats = await service.call("stats", { course: "P" });
  assert.deepEqual(map.mastery.course, { name: "P", value: 50, cards: 2 });
  assert.equal(map.mastery.course.cards, stats.totals.cards);

  // (c1) + (c2): Deep nesting respects nearest explicit active setting (A + A/B/C2 = 4 cards @ 75%; excludes A/B & A/B/C1).
  await service.call("focus.set", { course: "A" });
  map = await service.call("map");
  stats = await service.call("stats", { course: "A" });
  assert.deepEqual(map.mastery.course, { name: "A", value: 75, cards: 4 });
  assert.equal(map.mastery.course.cards, stats.totals.cards);

  // Active course with only suspended cards (and paused sub-course) => mastery.course is null, never { name } without value/cards.
  await service.call("focus.set", { course: "Quiet" });
  map = await service.call("map");
  assert.equal(map.mastery.course, null);

  // (f): Empty focus (no courses in library, only a system deck) => mastery.course is null (guards against decksInCourse(s, null)).
  const emptyRoot = await mkdtemp(join(tmpdir(), "study-course-mastery-empty-"));
  t.after(() => rm(emptyRoot, { recursive: true, force: true }));
  const emptyService = new StudyService(emptyRoot);
  await emptyService.store.update((s) => {
    s.decks.push({
      id: "d-coach",
      title: "Coach",
      systemKind: "coach",
      cards: [makeCard("ch0", { review: masteredReview }), makeCard("ch1", { review: masteredReview })],
    });
    s.attempts.push(passAttempt("d-coach", "ch0"), passAttempt("d-coach", "ch1"));
  });
  const emptyMap = await emptyService.call("map");
  assert.equal(emptyMap.mastery.course, null, "null currentCourse never falls through to all live decks");
  assert.deepEqual(emptyMap.mastery.library, { value: 100, cards: 2 });
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
