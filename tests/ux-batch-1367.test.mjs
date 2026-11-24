import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { StudyService } from "../lib/service.js";
import { taskProgress } from "../lib/daily-plan/tasks.js";
import { deriveItemStatus, computeSessionProgress } from "../lib/study-progress.js";
import { buildCompactScene } from "../lib/study-scene.js";
import { computeCoachEvidence, normalizeCoachSpec } from "../lib/exam-coach.js";
import { rubricAttemptPassed } from "../lib/course-method.js";
import { projection } from "../lib/study-state.js";
import { questionSolidity } from "../lib/evidence/point-evidence.js";
import { compileConfusablesToLesson } from "../lib/companion/book-active-compile.js";
import { syncLessonIntoState } from "../lib/companion/companion-lesson.js";
import { exportCompanionFiles } from "../lib/companion/companions.js";
import { exportAttachments, retainOriginal } from "../lib/contexts/materials/files.js";
import { hasCourseBook } from "../ui/book/qa-auto.js";
import { loadUi } from "./helpers/ui-module.mjs";

const uiMod = await loadUi(`
  export { putDraftStash, pickRecoveryFor, dropDraftStash } from "./ui/app/use-drafts.js";
`);
const { putDraftStash, pickRecoveryFor, dropDraftStash } = uiMod;

function tempRoot(tag = "1367") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `studyhub-${tag}-`));
}

test("#1367-1: Socratic attempts excluded from daily-plan, study-progress, study-scene, and exam-coach (while pre-answer socratic exposure disqualifies unseen independence)", () => {
  const socraticAtt = {
    id: "att-soc-1",
    runId: "run-1",
    deckId: "d1",
    quiz_id: "c1",
    topic: "Paging",
    assessment: "socratic",
    grade: 4,
    correct: true,
    timestamp: "2026-11-24T01:00:00.000Z",
    elapsed_ms: 15000,
  };
  const card = {
    id: "task-1",
    learningTask: { kind: "practice", scope: [{ deckId: "d1", cardId: "c1" }] },
  };
  const state = {
    runs: [{ id: "run-1", dailyPlanTaskId: "task-1", deckId: "d1", entries: [{ deckId: "d1", card: { id: "c1" }, feedback: null }] }],
    attempts: [socraticAtt],
  };
  assert.deepEqual(taskProgress(state, card), { done: 0, total: 1 });

  const itemStatus = deriveItemStatus({ id: "ci1", targetCardIds: ["c1"] }, [socraticAtt]);
  assert.equal(itemStatus.status, "pending");

  const session = { id: "sess-1", createdAt: "2026-11-24T00:00:00.000Z", goal: { checkItems: [{ id: "ci1", title: "Paging", targetCardIds: ["c1"] }] } };
  const sessProg = computeSessionProgress(session, [socraticAtt]);
  assert.equal(sessProg.independentPassedCount, 0);
  assert.equal(sessProg.pendingCount, 1);

  const scene = buildCompactScene(
    { decks: [{ id: "d1", cards: [{ id: "c1", kind: "open", topic: "Paging", prompt: "What is TLB?" }] }], runs: [], attempts: [socraticAtt] },
    { session: { id: "sess-1", focus: { kind: "card", deckId: "d1", cardId: "c1" } } },
  );
  assert.equal(scene.recentAttempts.length, 0);

  // Exam coach: socratic-only card is NOT practiced/passed, and formal pass AFTER socratic is assistedOrExposedCount (not unseenIndependentPassCount)
  const spec = normalizeCoachSpec({
    taskFamilies: [{ id: "f1", title: "Paging", primaryFormat: "open", quota: 1, questionsPerUnit: 1, priority: "core", topics: ["Paging"] }],
  }, "OS");
  const openCard = {
    id: "c1", kind: "open", topic: "Paging", prompt: "Explain TLB hit ratio.", answer: "Hit rate * access time.",
    explanation: "TLB caches page table entries.", objective: "Compute EAT", hint: "Consider hit and miss.",
    misconception: "Forgetting memory access.", coachSpecVersion: spec.specVersion,
  };
  const coachStateOnlySoc = {
    courses: [{ id: "co1", name: "OS" }],
    sources: [],
    decks: [{ id: "d1", title: "OS", course: "OS", cards: [openCard] }],
    attempts: [socraticAtt],
    feedback: [],
    learner: { solutionExposures: [] },
  };
  const r1 = computeCoachEvidence(coachStateOnlySoc, { course: "OS", spec });
  assert.equal(r1.trainingCoverage.practiced, 0);
  assert.equal(r1.capabilityEvidence.unseenIndependentPassCount, 0);

  const formalAfterSoc = {
    id: "att-real-1",
    deckId: "d1",
    quiz_id: "c1",
    topic: "Paging",
    assessment: "rubric",
    score: 10,
    maxScore: 10,
    grade: 4,
    correct: true,
    timestamp: "2026-11-24T01:05:00.000Z",
  };
  const r2 = computeCoachEvidence({ ...coachStateOnlySoc, attempts: [socraticAtt, formalAfterSoc] }, { course: "OS", spec });
  assert.equal(r2.capabilityEvidence.unseenIndependentPassCount, 0);
  assert.equal(r2.capabilityEvidence.assistedOrExposedCount, 1);
});

test("#1367-2: ENOENT attachment is skipped during export (stripping dangling attachment so restore succeeds), while tampered bytes still throw", async () => {
  const root = tempRoot("1367-2");
  try {
    const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
    const att = await retainOriginal(root, pdfBytes, "pdf");
    const missingAtt = { ...att, hash: "0".repeat(64), path: `attachments/materials/${"0".repeat(64)}.pdf` };
    const docs = [
      { id: "doc1", title: "Good", format: "pdf", versions: [{ revision: 1, attachment: att }] },
      { id: "doc2", title: "Missing", format: "pdf", versions: [{ revision: 1, attachment: missingAtt }] },
    ];
    const exported = await exportAttachments(root, docs);
    assert.equal(exported.length, 1);
    assert.equal(exported[0].path, att.path);

    // Tampered file still throws
    fs.writeFileSync(path.join(root, att.path), Buffer.from("%PDF-1.4\ntampered%%EOF\n"));
    await assert.rejects(() => exportAttachments(root, [docs[0]]), /changed material original/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1367-3: manual grade override governs rubricAttemptPassed, projection().missedCards, and point-evidence partialTransfer", () => {
  // Unadjusted preserves >50% contract
  assert.equal(rubricAttemptPassed({ assessment: "rubric", score: 6, maxScore: 10, grade: 2 }), true);
  assert.equal(rubricAttemptPassed({ assessment: "rubric", score: 2, maxScore: 10, grade: 4 }), false);

  // Upward manual override: 2/10 adjusted to grade 4 -> passed
  assert.equal(rubricAttemptPassed({ assessment: "rubric", score: 2, maxScore: 10, grade: 4, correct: true, adjustedAt: "2026-11-24T01:00:00Z" }), true);
  // Downward manual override: 8/10 adjusted to grade 1 -> failed
  assert.equal(rubricAttemptPassed({ assessment: "rubric", score: 8, maxScore: 10, grade: 1, correct: false, adjustedAt: "2026-11-24T01:00:00Z" }), false);

  // projection().missedCards honors adjustedAt
  const baseRun = {
    id: "r1", deckId: "d1", mode: "review", index: 2, startedAt: "2026-11-24T00:00:00Z",
    entries: [
      { deckId: "d1", card: { id: "c1", kind: "open", topic: "T1", prompt: "P1" }, feedback: { rubric: { total: 2, max: 10 }, grade: 4, correct: true, adjustedAt: "2026-11-24T00:01:00Z" } },
      { deckId: "d1", card: { id: "c2", kind: "open", topic: "T2", prompt: "P2" }, feedback: { rubric: { total: 8, max: 10 }, grade: 1, correct: false, adjustedAt: "2026-11-24T00:02:00Z" } },
    ],
  };
  const proj = projection({ decks: [{ id: "d1", title: "D1", cards: baseRun.entries.map((e) => e.card) }], sources: [], runs: [baseRun], attempts: [], settings: {} }, baseRun);
  assert.deepEqual(proj.missedCards.map((m) => m.cardId), ["c2"]);

  // point-evidence: manually downgraded rubric attempt does NOT falsely award partialTransfer
  const sol = questionSolidity([
    { deckId: "d1", quiz_id: "c2", assessment: "rubric", score: 8, maxScore: 10, grade: 1, correct: false, adjustedAt: "2026-11-24T00:02:00Z", timestamp: "2026-11-24T00:02:00Z" },
  ]);
  const ev = sol({ deckId: "d1", cardId: "c2", level: "weak", card: { id: "c2", kind: "open" } });
  assert.equal(ev.partialTransfer, false);
});

test("#1367-4: recompiling companion retargets managed HTML to prev.id (fresh HTML & exportable) and CJK confusable slugs stay distinct", async () => {
  const pairA = { id: "C001", names: ["进程", "线程"], rows: [{ aspect: "what", cells: ["资源分配单位", "调度执行单位"] }] };
  const pairB = { id: "C001", names: ["分页", "分段"], rows: [{ aspect: "what", cells: ["固定大小物理划分", "按逻辑模块划分"] }] };
  const lessonA = compileConfusablesToLesson([pairA], { course: "操作系统", language: "zh" });
  const lessonB = compileConfusablesToLesson([pairB], { course: "操作系统", language: "zh" });
  assert.notEqual(lessonA.id, lessonB.id, "distinct Chinese confusable pairs must not collide on lesson id");
  assert.match(lessonA.id, /进程/);

  const root = tempRoot("1367-4");
  try {
    const service = new StudyService(root);
    const first = await service.call("companion.compile", { lesson: lessonA, course: "操作系统", mountMode: "companion-only" });
    const firstId = first.companion.id;
    const updatedLesson = { ...lessonA, title: "辩证对比实验：进程 vs 线程（新版）" };
    const second = await service.call("companion.compile", { lesson: updatedLesson, course: "操作系统", mountMode: "companion-only" });
    assert.equal(second.companion.id, firstId, "recompiling same lessonId reuses prev.id");
    const doc = await service.call("companion.get", { id: firstId, course: "操作系统" });
    assert.ok(doc.html.includes("（新版）"), "companion.get must read freshly retargeted HTML");
    const exported = await exportCompanionFiles(root, (await service.store.read()).courses);
    assert.equal(exported.length, 1, "exportCompanionFiles must include overwritten managed companion with matching sha256");
    assert.equal(exported[0].id, firstId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1367-5: syncLessonIntoState unarchives re-attached source, reuses unarchived companion deck without duplicate IDs, and skips duplicate on archived deck", () => {
  const lesson = compileConfusablesToLesson([{ id: "C001", names: ["TCP", "UDP"], rows: [{ aspect: "what", cells: ["面向连接", "无连接"] }] }], { course: "Networks", language: "zh" });
  const state = {
    courses: [{ id: "co1", name: "Networks" }],
    sources: [{ id: "src-companion-comp-1", title: "Old", text: "old", archived: true, companionId: "comp-1", courses: ["Networks"] }],
    decks: [{ id: "deck-comp-comp-1", title: "Old Deck", course: "Networks", companionDeck: true, cards: [] }],
    settings: {},
  };
  syncLessonIntoState(state, { course: "Networks", companionId: "comp-1", lesson, mountMode: "full-pack" });
  assert.equal(state.sources[0].archived, undefined, "re-attached source must be unarchived");
  assert.equal(state.decks.length, 1, "must reuse existing deck-comp-comp-1 without pushing duplicate");
  assert.equal(state.decks[0].companionId, "comp-1");

  // Explicitly archived deck must NOT cause a duplicate id push
  const stateArchived = {
    courses: [{ id: "co1", name: "Networks" }],
    sources: [],
    decks: [{ id: "deck-comp-comp-2", title: "Archived", course: "Networks", archived: true, cards: [] }],
    settings: {},
  };
  syncLessonIntoState(stateArchived, { course: "Networks", companionId: "comp-2", lesson, mountMode: "full-pack" });
  assert.equal(stateArchived.decks.filter((d) => d.id === "deck-comp-comp-2").length, 1);
});

test("#1367-6: companion.progress grants first-pass credit after returning from final slide preview, while blocking 1-hop straight-to-end jump", async () => {
  const root = tempRoot("1367-6");
  try {
    const service = new StudyService(root);
    const lesson = compileConfusablesToLesson([{ id: "C001", names: ["Mutex", "Semaphore"], rows: [{ aspect: "what", cells: ["Binary lock", "Counting signal"] }] }], { course: "OS", language: "en" });
    // Add a 3-option check quiz so compileLessonCards emits a `check:0` card alongside `take:*` cards
    lesson.slides.at(-1).blocks.unshift({
      t: "quiz",
      q: "Which primitive has strict ownership?",
      options: [
        { text: "Mutex", ok: true, why: "Only the locking thread unlocks a mutex." },
        { text: "Counting semaphore", ok: false, why: "Any thread can signal a semaphore." },
        { text: "Barrier", ok: false, why: "A barrier synchronizes arrival." },
      ],
    });
    const built = await service.call("companion.compile", { lesson, course: "OS", mountMode: "full-pack" });
    const compId = built.companion.id;
    const total = lesson.slides.length;

    // 1-hop jump straight to final slide with no checks -> 0 credit
    const jump = await service.call("companion.progress", { id: compId, course: "OS", slide: total, slideTotal: total, completed: true });
    assert.equal(jump.firstPassCredited, 0);

    // Go back to slide 1, then complete checks -> decoupled credit now succeeds!
    await service.call("companion.progress", { id: compId, course: "OS", slide: 1, slideTotal: total, completed: false });
    const decks = (await service.store.read()).decks;
    const checkSlots = decks.flatMap((d) => d.cards).filter((c) => c.companionRef?.companionId === compId && String(c.companionRef?.slot || "").startsWith("check:")).map((c) => c.companionRef.slot);
    assert.ok(checkSlots.length >= 1, "lesson must produce at least one check:* card");
    const checkResults = Object.fromEntries(checkSlots.map((slot) => [slot, true]));
    const afterStudy = await service.call("companion.progress", { id: compId, course: "OS", slide: total, slideTotal: total, completed: true, checkResults });
    assert.ok(afterStudy.firstPassCredited >= 1, "passing check quizzes after returning from preview must grant first-pass credit");
    const finalCards = (await service.store.read()).decks.flatMap((d) => d.cards).filter((c) => c.companionRef?.companionId === compId && /^(take|check):/.test(String(c.companionRef?.slot || "")));
    assert.ok(finalCards.length >= 3 && finalCards.every((c) => (c.review?.reps || 0) === 1), "all take:* and passed check:* cards must now have first-pass FSRS credit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1367-7, #1367-8, #1367-9: draft stash clearing, CourseSettings live dirty check, and TeachingPanel completed status", async () => {
  // #1367-7: sessionStorage stash drop + source verification
  const store = new Map();
  const mockStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const draft = { id: "dr1", title: "Edited", draftVersion: 1, cards: [] };
  const loaded = JSON.stringify({ id: "dr1", title: "Original", draftVersion: 1, cards: [] });
  putDraftStash("/tmp/root", { draft, draftText: JSON.stringify(draft), jsonMode: false, draftLoaded: loaded }, mockStorage);
  assert.ok(pickRecoveryFor("/tmp/root", { id: "dr1" }, mockStorage), "unsaved edit is recoverable on passive reopen");
  dropDraftStash("/tmp/root", "dr1", mockStorage);
  assert.equal(pickRecoveryFor("/tmp/root", { id: "dr1" }, mockStorage), null, "skipStash clears stash cleanly");

  const draftSrc = await readFile(path.resolve("ui/Draft.jsx"), "utf8");
  assert.ok(draftSrc.includes("openDraft(saved, { skipStash: true })"));
  assert.ok(draftSrc.includes("openDraft(latestDraft, { skipStash: true })"));

  // #1367-8: live hasUnsavedChanges + guardLeave in CourseSettings
  const csSrc = await readFile(path.resolve("ui/CourseSettings.jsx"), "utf8");
  assert.ok(csSrc.includes("const hasUnsavedChanges = () =>"));
  assert.ok(csSrc.includes("leavePrompt?.kind === 'leave'"));

  // #1367-9: TeachingStatus rendered outside teaching.complete ternary + teachingAction distinguishes teach.answer
  const tpSrc = await readFile(path.resolve("ui/review/TeachingPanel.jsx"), "utf8");
  assert.ok(tpSrc.includes('teachingAction === "teach.answer"'));
  assert.ok(tpSrc.indexOf("<TeachingStatus") > tpSrc.indexOf("teaching.complete"), "TeachingStatus stays rendered after the complete ternary");
});

test("#1367-10: chunked backup.upload.* + restore { uploadId } restores full backup and removes temp file", async () => {
  const root = tempRoot("1367-10");
  try {
    const service = new StudyService(root);
    await service.call("deck.import", {
      text: JSON.stringify({
        title: "Chunked Restore Deck",
        course: "Systems",
        cards: [{ id: "c-chunk-1", kind: "flashcard", topic: "IO", prompt: "What is DMA?", answer: "Direct Memory Access" }],
      }),
    });
    const backup = await service.call("export");
    const jsonBytes = Buffer.from(JSON.stringify(backup), "utf8");
    const started = await service.call("backup.upload.start", { name: "studyhub-backup.json", size: jsonBytes.length });
    const mid = Math.max(1, Math.floor(jsonBytes.length / 2));
    await service.call("backup.upload.chunk", { uploadId: started.uploadId, offset: 0, data: jsonBytes.subarray(0, mid).toString("base64") });
    await service.call("backup.upload.chunk", { uploadId: started.uploadId, offset: mid, data: jsonBytes.subarray(mid).toString("base64") });
    await service.call("backup.upload.finish", { uploadId: started.uploadId });

    // Mutate state, then restore via uploadId
    await service.call("deck.import", {
      text: JSON.stringify({ title: "Extra Deck", course: "Other", cards: [{ id: "c-extra", kind: "flashcard", topic: "X", prompt: "Q", answer: "A" }] }),
    });
    assert.equal((await service.store.read()).decks.length, 2);

    await service.call("restore", { uploadId: started.uploadId });
    const restoredDecks = (await service.store.read()).decks;
    assert.equal(restoredDecks.length, 1);
    assert.equal(restoredDecks[0].title, "Chunked Restore Deck");
    assert.equal(fs.existsSync(path.join(root, "backup-uploads", started.uploadId)), false, "temp backup upload folder must be cleaned up");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1367-11: hasCourseBook matches exact course and parent/child hierarchies ('A / B', 'A/B', nested)", () => {
  const books = new Set(["计量经济学", "Operating Systems"]);
  assert.equal(hasCourseBook(books, "计量经济学"), true);
  assert.equal(hasCourseBook(books, "计量经济学 / 第 3 章"), true);
  assert.equal(hasCourseBook(books, "计量经济学/第3章"), true);
  assert.equal(hasCourseBook(books, "Operating Systems / Memory / Paging"), true);
  assert.equal(hasCourseBook(books, "Linear Algebra / Ch 1"), false);
  assert.equal(hasCourseBook(books, ""), false);
});
