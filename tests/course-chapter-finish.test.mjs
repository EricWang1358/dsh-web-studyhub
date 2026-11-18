import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { courseProgress, projection } from "../lib/study-state.js";
import {
  chapterSegments,
  courseChaptersBefore,
  finishedChapters,
} from "../lib/contexts/study/course-chapters-before.js";

const quizCard = (prefix, n) => ({
  id: `${prefix}${n}`,
  kind: "quiz",
  topic: `${prefix}-topic`,
  prompt: `${prefix}${n}?`,
  options: [
    { id: "a", text: "Right", correct: true },
    { id: "b", text: "Wrong", correct: false },
  ],
});

const makeCards = (prefix, count) =>
  Array.from({ length: count }, (_, i) => quizCard(prefix, i + 1));

async function setupCourse(t, specs) {
  const root = await mkdtemp(join(tmpdir(), "study-chapter-finish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update((s) => {
    for (const spec of specs) {
      s.decks.push({
        id: spec.id,
        title: spec.title,
        course: spec.course ?? "Cloud Native",
        cards: makeCards(spec.prefix, spec.count),
      });
    }
    s.focus = { mode: "class", course: "Cloud Native", role: "", jd: "", targetTopics: [] };
  });
  return service;
}

test("pure helpers: courseChaptersBefore extracts only touched chapters and finishedChapters detects first-time completion", () => {
  const route = {
    chapters: [
      { deckId: "d1", title: "01 概览", learned: 5, total: 5, weak: 0 },
      { deckId: "d2", title: "02 容器", learned: 3, total: 5, weak: 1 },
      { deckId: "d3", title: "03 编排", learned: 0, total: 4, weak: 0 },
      { deckId: "d4", title: "04 网格", learned: 0, total: 0, weak: 0 },
    ],
  };
  const before = courseChaptersBefore(route, {
    entries: [
      { deckId: "d1", card: { id: "a1" } },
      { deckId: "d2", card: { id: "b4" } },
      { deckId: "d2", card: { id: "b5" } },
      { deckId: "d2", card: { id: "b1" }, retry: true },
      { deckId: "d3", card: { id: "c1" } },
    ],
  });
  assert.deepEqual(before, [
    { index: 0, deckId: "d1", learned: 5, total: 5 },
    { index: 1, deckId: "d2", learned: 3, total: 5 },
    { index: 2, deckId: "d3", learned: 0, total: 4 },
  ]);

  const after = [
    { deckId: "d1", title: "01 概览", learned: 5, total: 5, weak: 0 }, // already done before -> excluded
    { deckId: "d2", title: "02 容器", learned: 5, total: 5, weak: 2 }, // newly finished with 2 weak
    { deckId: "d3", title: "03 编排", learned: 4, total: 4, weak: 0 }, // newly finished with 0 weak
    { deckId: "d4", title: "04 网格", learned: 0, total: 0, weak: 0 }, // total === 0 -> excluded
    { deckId: "d5", title: "05 观测", learned: 3, total: 3, weak: 0 }, // not in before -> excluded
  ];
  assert.deepEqual(finishedChapters(before, after), [
    { index: 1, title: "02 容器", total: 5, weak: 2 },
    { index: 2, title: "03 编排", total: 4, weak: 0 },
  ]);

  assert.deepEqual(chapterSegments(after), ["done", "done", "done", "upcoming", "done"]);
});

test("pure helpers: missing chaptersBefore returns empty, total === 0 never enters, and deckId prevents shifted-index mismatch", () => {
  const current = [
    { deckId: "d2", title: "02 容器", learned: 4, total: 4, weak: 0 },
    { deckId: "d0", title: "空章", learned: 0, total: 0, weak: 0 },
  ];
  assert.deepEqual(finishedChapters(undefined, current), []);
  assert.deepEqual(finishedChapters(null, current), []);
  assert.deepEqual(finishedChapters([], current), []);

  // d1 (index 0) was deleted/archived and d2 shifted to index 0: deckId mismatch prevents false positive
  const shiftedBefore = [{ index: 0, deckId: "d1", learned: 2, total: 4 }];
  assert.deepEqual(finishedChapters(shiftedBefore, current), []);

  // Without deckId, index fallback still works cleanly
  assert.deepEqual(
    finishedChapters([{ index: 0, learned: 2, total: 4 }, { index: 1, learned: 0, total: 0 }], current),
    [{ index: 0, title: "02 容器", total: 4, weak: 0 }],
  );
});

test("StudyService round lifecycle: finishing a chapter reports finished once (with weak count) and never repeats on round 2", async (t) => {
  const service = await setupCourse(t, [
    { id: "c1", title: "01 概览", prefix: "a", count: 4 },
    { id: "c2", title: "02 迁移", prefix: "b", count: 4 },
    { id: "c3", title: "03 观察", prefix: "c", count: 8 },
  ]);
  // Pre-learn first 2 cards of chapter 1 (1 weak, 1 mastered)
  const now = new Date().toISOString();
  await service.store.update((s) => {
    s.attempts.push(
      { deckId: "c1", quiz_id: "a1", grade: 1, at: now },
      { deckId: "c1", quiz_id: "a2", grade: 5, at: now },
    );
  });

  // Start round 1 (pulls weak a1 + new a3, a4 from c1 + b1..b4 from c2, total 7 cards)
  let run = await service.call("review.start", { mode: "course" });
  assert.deepEqual(run.course.finished, []);
  assert.deepEqual(run.course.segments, ["started", "upcoming", "upcoming"]);
  assert.equal(run.course.doneChapters, 0);

  // Answer a1 right (clears weak), a3 right, a4 wrong (now c1 is 4/4 with 1 weak: a4!), then end early via review.end
  for (let i = 0; i < 3; i++) {
    const cardId = run.card.id;
    const selected = cardId === "a4" ? ["b"] : ["a"];
    run = await service.call("review.answer", { runId: run.id, cardId, selected });
    run = await service.call("review.move", { runId: run.id, direction: 1 });
  }
  run = await service.call("review.end", { runId: run.id });
  assert.equal(run.complete, true);
  assert.deepEqual(run.course.finished, [{ index: 0, title: "01 概览", total: 4, weak: 1 }]);
  assert.equal(run.course.doneChapters, 1);
  assert.deepEqual(run.course.segments, ["done", "upcoming", "upcoming"]);

  // Undo isn't allowed after closed, so verify starting round 2 (which pulls weak a4 from c1 plus c2 cards) does NOT re-report c1
  let run2 = await service.call("review.start", { mode: "course", fresh: true });
  while (!run2.complete) {
    const cardId = run2.card.id;
    run2 = await service.call("review.answer", { runId: run2.id, cardId, selected: ["a"] });
    run2 = await service.call("review.move", { runId: run2.id, direction: 1 });
  }
  assert.deepEqual(run2.course.finished, [{ index: 1, title: "02 迁移", total: 4, weak: 0 }]);
  assert.equal(run2.course.doneChapters, 2);
  assert.deepEqual(run2.course.segments, ["done", "done", "started"]);
});

test("StudyService round lifecycle: multi-chapter completion in one round, undo rollback, and legacy run without chaptersBefore", async (t) => {
  const service = await setupCourse(t, [
    { id: "c1", title: "01 入门", prefix: "a", count: 2 },
    { id: "c2", title: "02 进阶", prefix: "b", count: 2 },
  ]);
  let run = await service.call("review.start", { mode: "course" });
  while (!run.complete) {
    const cardId = run.card.id;
    run = await service.call("review.answer", { runId: run.id, cardId, selected: ["a"] });
    run = await service.call("review.move", { runId: run.id, direction: 1 });
  }
  assert.deepEqual(run.course.finished, [
    { index: 0, title: "01 入门", total: 2, weak: 0 },
    { index: 1, title: "02 进阶", total: 2, weak: 0 },
  ]);
  assert.equal(run.course.doneChapters, 2);
  assert.deepEqual(run.course.segments, ["done", "done"]);

  // Undo last card -> round reopens and finished shrinks back to c1 only
  const reopened = await service.call("review.undo", { runId: run.id });
  assert.equal(reopened.complete, false);
  assert.deepEqual(reopened.course.finished, [{ index: 0, title: "01 入门", total: 2, weak: 0 }]);
  assert.equal(reopened.course.doneChapters, 1);

  // Legacy run without chaptersBefore never falsely reports finished chapters
  const exported = await service.call("export");
  const legacyRun = { ...exported.runs[0] };
  delete legacyRun.chaptersBefore;
  const projectedLegacy = projection(exported, legacyRun);
  assert.deepEqual(projectedLegacy.course.finished, []);
  assert.deepEqual(courseProgress(exported, "Cloud Native").finished, []);
});
