import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { loadInteractiveUi, withBrowserGlobals, click, textOf, syntheticEvent } from "./helpers/react-harness.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_BACKUP_UPLOAD_BYTES } from "../lib/audio-upload.js";
import { backupUploadsHome } from "../lib/mineru-paths.js";

const uiMod = await loadUi(`
  export { putDraftStash, pickRecoveryFor, dropDraftStash } from "./ui/app/use-drafts.js";
  export { default as TeachingPanel } from "./ui/review/TeachingPanel.jsx";
`);
const interactiveMod = await loadInteractiveUi(`
  export { default as Draft } from "./ui/Draft.jsx";
  export { default as CourseSettings } from "./ui/CourseSettings.jsx";
  export { StudyServicesContext } from "./ui/study-context.jsx";
  export { ToastContext } from "./ui/components/index.js";
  export { setUiLanguage } from "./ui/i18n.js";
`);
const { putDraftStash, pickRecoveryFor, dropDraftStash } = uiMod;
const h = React.createElement;
const hi = interactiveMod.React.createElement;

function tempRoot(tag = "1367") {
  return fs.mkdtempSync(path.join(os.tmpdir(), `studyhub-${tag}-`));
}

test("#1367-1: Socratic attempts excluded from daily-plan, study-progress, study-scene, and exam-coach formal counts", () => {
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
    decks: [{ id: "d1", cards: [{ id: "c1" }] }],
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
  // A Socratic step never enters the answer log as an answer, and the log alone cannot prove a hint or the answer was shown:
  // the formal answer is judged on its own assistance (#1367-1, corrected by the #1395 review).
  assert.equal(r2.capabilityEvidence.unseenIndependentPassCount, 1);
  assert.equal(r2.capabilityEvidence.assistedOrExposedCount, 0);
});

test("#1367-1b: open-and-close never disqualifies a later independent pass; a hint or the answer counts only in its own round", async () => {
  const spec = normalizeCoachSpec({
    taskFamilies: [{ id: "f1", title: "Paging", primaryFormat: "open", quota: 1, questionsPerUnit: 1, priority: "core", topics: ["Paging"] }],
  }, "OS");
  const card = {
    id: "c1", kind: "open", topic: "Paging", prompt: "Explain TLB hit ratio.", answer: "Hit rate * access time.",
    explanation: "TLB caches page table entries.", objective: "Compute EAT", hint: "Consider hit and miss.",
    misconception: "Forgetting memory access.", coachSpecVersion: spec.specVersion,
  };
  const formal = {
    id: "att-formal", runId: "run-open", deckId: "d1", quiz_id: "c1", topic: "Paging", assessment: "rubric",
    score: 10, maxScore: 10, grade: 4, correct: true, timestamp: "2026-11-24T01:05:00.000Z", elapsed_ms: 90000,
  };
  const coachState = (cards, attempts) => ({
    courses: [{ id: "co1", name: "OS" }],
    sources: [],
    decks: [{ id: "d1", title: "OS", course: "OS", cards }],
    attempts,
    feedback: [],
    learner: { solutionExposures: [] },
  });

  // Opening the drawer writes nothing on the card: the later correct answer stays an unseen independent pass.
  const root = tempRoot("1367-1b");
  try {
    const service = new StudyService(root);
    await service.store.update((s) => {
      s.courses = [{ id: "co1", name: "OS" }];
      s.decks = [{ id: "d1", title: "OS", course: "OS", cards: [card] }];
    });
    const ref = { deckId: "d1", cardId: "c1" };
    const opened = await service.call("socratic.get", ref);
    assert.equal(opened.persisted, false, "opening the drawer is a read, not a Socratic record");
    assert.equal((await service.store.read()).decks[0].cards[0].socratic, undefined, "open-and-close leaves no record on the card");
    const untouched = await service.store.read();
    const afterOpen = computeCoachEvidence(coachState(untouched.decks[0].cards, [formal]), { course: "OS", spec });
    assert.equal(afterOpen.capabilityEvidence.unseenIndependentPassCount, 1, "a card whose drawer was only opened still counts an independent pass");
    assert.equal(afterOpen.capabilityEvidence.assistedOrExposedCount, 0);

    // A hint taken in a round stamps that round on the record.
    const run = await service.call("review.start", { mode: "path", scope: [ref] });
    await service.call("socratic.step", { ...ref, runId: run.id, action: "hint", offline: true });
    const hinted = (await service.store.read()).decks[0].cards[0];
    assert.equal(hinted.socratic.hintLevel, 1);
    assert.equal(hinted.socratic.helpRunId, run.id, "the hint remembers the round it was given in");

    // Same round: the answer to that round is assisted, never a clean pass.
    const answeredAt = new Date(Date.now() + 60_000).toISOString();
    const sameRound = computeCoachEvidence(coachState([hinted], [{ ...formal, runId: run.id, timestamp: answeredAt }]), { course: "OS", spec });
    assert.equal(sameRound.capabilityEvidence.assistedOrExposedCount, 1);
    assert.equal(sameRound.capabilityEvidence.unseenIndependentPassCount, 0);

    // A later round with the same record still counts as independent: the old hint does not follow the question forever.
    const laterRound = computeCoachEvidence(coachState([hinted], [{ ...formal, runId: "run-later" }]), { course: "OS", spec });
    assert.equal(laterRound.capabilityEvidence.unseenIndependentPassCount, 1);
    assert.equal(laterRound.capabilityEvidence.assistedOrExposedCount, 0);

    // A record from before this rule (no helpRunId) never disqualifies anything: history is not re-judged.
    const legacy = { ...hinted, socratic: { hintLevel: 2, maxHintLevelUsed: 2, revealed: true } };
    const rerun = computeCoachEvidence(coachState([legacy], [{ ...formal, runId: "run-later" }]), { course: "OS", spec });
    assert.equal(rerun.capabilityEvidence.unseenIndependentPassCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  // #1367-7: sessionStorage stash drop + mounted Draft save / stale-reload skipStash behavior
  const store = new Map();
  const mockStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const baseCard = { id: "c1", kind: "flashcard", topic: "T1", objective: "O1", prompt: "Q1", answer: "A1", hint: "", explanation: "", misconception: "", citations: [] };
  const origDraft = { id: "dr1", title: "Original", draftVersion: 1, cards: [baseCard] };
  const editedDraft = { id: "dr1", title: "Edited", draftVersion: 1, cards: [baseCard] };
  const loaded = JSON.stringify(origDraft);
  putDraftStash("/tmp/root", { draft: editedDraft, draftText: JSON.stringify(editedDraft), jsonMode: false, draftLoaded: loaded }, mockStorage);
  assert.ok(pickRecoveryFor("/tmp/root", { id: "dr1" }, mockStorage), "unsaved edit is recoverable on passive reopen");
  dropDraftStash("/tmp/root", "dr1", mockStorage);
  assert.equal(pickRecoveryFor("/tmp/root", { id: "dr1" }, mockStorage), null, "skipStash clears stash cleanly");

  await withBrowserGlobals(async () => {
    interactiveMod.exports.setUiLanguage("zh");
    const noop = () => {};
    const toastApi = { success: noop, info: noop, warning: noop, error: noop, show: noop, dismiss: noop };

    // 7a. Saving a dirty draft calls openDraft(saved, { skipStash: true }) and clears stashed edits so stale edits cannot re-apply.
    putDraftStash("/tmp/root", { draft: editedDraft, draftText: JSON.stringify(editedDraft), jsonMode: false, draftLoaded: loaded }, mockStorage);
    const openCalls = [];
    const savedV2 = { ...editedDraft, draftVersion: 2 };
    const handleOpenDraft = (next, opts = {}) => {
      openCalls.push({ next, opts });
      if (opts.skipStash) dropDraftStash("/tmp/root", next.id, mockStorage);
    };
    const saveServices = {
      call: async () => ({ status: "ok" }),
      act: async (action, args, after) => {
        if (action === "draft.save") {
          await after?.(savedV2);
          return savedV2;
        }
        return undefined;
      },
      busy: false,
      notify: noop,
      askInChat: noop,
      host: {},
      openSettings: noop,
      navigate: noop,
      openModal: noop,
    };
    const mountDraft = (draftProp, draftLoadedProp, draftsList, servicesOverride = saveServices) => interactiveMod.mount(() => hi(
      interactiveMod.exports.StudyServicesContext.Provider,
      { value: servicesOverride },
      hi(
        interactiveMod.exports.ToastContext.Provider,
        { value: toastApi },
        hi(interactiveMod.exports.Draft, {
          data: { root: "/tmp/root", revision: 1, sources: [], decks: [], drafts: draftsList, jobs: [], runs: [], settings: {} },
          draft: draftProp,
          draftLoaded: draftLoadedProp,
          setDraft: noop,
          draftText: JSON.stringify(draftProp, null, 2),
          setDraftText: noop,
          jsonMode: false,
          setJsonMode: noop,
          openDraft: handleOpenDraft,
          topUpDraft: noop,
          openSourceAt: noop,
          onOpenPublished: noop,
          onStartPublished: noop,
          clearRecovery: noop,
          setPage: noop,
          setModal: noop,
          blankCard: () => baseCard,
          patchCard: noop,
          parseDraft: (t) => JSON.parse(t),
        }),
      ),
    ));

    const saveMounted = mountDraft(editedDraft, loaded, [origDraft]);
    try {
      const pageEl = saveMounted.find((node) => node.type === "section" && String(node.props?.className || "").includes("draft-page"));
      assert.ok(pageEl?.props?.onKeyDown, "Draft page attaches Ctrl+S shortcut");
      await saveMounted.act(() => pageEl.props.onKeyDown(syntheticEvent({ ctrlKey: true, key: "s" })));
      assert.equal(openCalls.length, 1);
      assert.equal(openCalls[0].next.draftVersion, 2);
      assert.equal(openCalls[0].opts?.skipStash, true, "saving a draft reloads with skipStash: true");
      assert.equal(pickRecoveryFor("/tmp/root", { id: "dr1" }, mockStorage), null, "saving a draft drops its local stash");
    } finally {
      saveMounted.unmount();
    }

    // 7b. Stale draft banner "载入最新草稿" reloads latestDraft with skipStash: true and drops stale stash.
    openCalls.length = 0;
    const latestV2 = { ...origDraft, title: "Repaired Latest", draftVersion: 2 };
    putDraftStash("/tmp/root", { draft: editedDraft, draftText: JSON.stringify(editedDraft), jsonMode: false, draftLoaded: loaded }, mockStorage);
    const staleDirtyMounted = mountDraft(editedDraft, loaded, [latestV2]);
    try {
      const reloadBtn = staleDirtyMounted.find((node) => node.type === "button" && textOf(node).includes("载入最新草稿"));
      assert.ok(reloadBtn, "stale dirty draft displays 载入最新草稿 action");
      await staleDirtyMounted.act(() => click(reloadBtn));
      assert.equal(openCalls.length, 1);
      assert.equal(openCalls[0].next.title, "Repaired Latest");
      assert.equal(openCalls[0].opts?.skipStash, true, "manual stale reload passes skipStash: true");
      assert.equal(pickRecoveryFor("/tmp/root", { id: "dr1" }, mockStorage), null, "manual stale reload drops stale stash");
    } finally {
      staleDirtyMounted.unmount();
    }

    // 7c. Clean stale draft auto-reloads latestDraft via effect with skipStash: true.
    openCalls.length = 0;
    putDraftStash("/tmp/root", { draft: editedDraft, draftText: JSON.stringify(editedDraft), jsonMode: false, draftLoaded: loaded }, mockStorage);
    const staleCleanMounted = mountDraft(origDraft, loaded, [latestV2]);
    try {
      await staleCleanMounted.flush();
      assert.equal(openCalls.length, 1);
      assert.equal(openCalls[0].next.title, "Repaired Latest");
      assert.equal(openCalls[0].opts?.skipStash, true, "auto-reload of clean stale draft passes skipStash: true");
      assert.equal(pickRecoveryFor("/tmp/root", { id: "dr1" }, mockStorage), null);
    } finally {
      staleCleanMounted.unmount();
    }

    // #1367-8: CourseSettings live child-ref dirty checks (ruleDraftRef / notationDraftRef) + leavePrompt (close & leave)
    const course = { id: "co1", name: "OS", exam: { date: "2099-12-31" }, generationRules: [], notationOverrides: [] };
    const closeCalls = [];
    const settingsCalls = [];
    const csServices = {
      call: async (action) => {
        if (action === "course.examAlignment.preview") return { enabled: true, courses: [{ name: "OS", pending: 3 }] };
        if (action === "generate.weakTopics") return { topics: [] };
        return {};
      },
      act: async () => undefined,
      busy: false,
      notify: noop,
      askInChat: noop,
      host: {},
      openSettings: (section) => settingsCalls.push(section),
      navigate: noop,
      openModal: noop,
    };
    const mountCourseSettings = () => interactiveMod.mount(() => hi(
      interactiveMod.exports.StudyServicesContext.Provider,
      { value: csServices },
      hi(
        interactiveMod.exports.ToastContext.Provider,
        { value: toastApi },
        hi(interactiveMod.exports.CourseSettings, {
          data: { root: "/tmp/cs", courses: [course], sources: [], focus: { course: "OS", courseId: "co1" } },
          courseId: "co1",
          onClose: (reason) => closeCalls.push(reason),
        }),
      ),
    ));

    // 8a. Unsaved ruleDraftRef input (while draftDirty is false) blocks closing until confirmed.
    const csRule = mountCourseSettings();
    try {
      await csRule.flush();
      const ruleInput = csRule.find((node) => node.type === "input" && node.props?.["aria-label"] === "新守则");
      assert.ok(ruleInput, "CourseRulesEditor new-rule input is mounted");
      await csRule.act(() => ruleInput.props.onChange({ target: { value: "题干必须给出边界条件" } }));
      const closeBtn = csRule.find((node) => node.type === "button" && textOf(node).trim() === "关闭");
      assert.ok(closeBtn);
      await csRule.act(() => click(closeBtn));
      assert.equal(closeCalls.length, 0, "unsaved ruleDraftRef blocks immediate close");
      assert.match(csRule.text(), /放弃未保存的改动？/);
      const stayBtn = csRule.find((node) => node.type === "button" && textOf(node).trim() === "继续编辑");
      assert.ok(stayBtn);
      await csRule.act(() => click(stayBtn));
      assert.doesNotMatch(csRule.text(), /放弃未保存的改动？/);
      assert.equal(closeCalls.length, 0, "cancelling leave prompt keeps panel open");
      await csRule.act(() => click(csRule.find((node) => node.type === "button" && textOf(node).trim() === "关闭")));
      const discardBtn = csRule.find((node) => node.type === "button" && textOf(node).trim() === "放弃改动");
      assert.ok(discardBtn);
      await csRule.act(() => click(discardBtn));
      assert.deepEqual(closeCalls, ["cancel"], "confirming discard closes CourseSettings");
    } finally {
      csRule.unmount();
    }

    // 8b. Unsaved notationDraftRef input triggers guardLeave -> leavePrompt.kind === 'leave', blocking navigation until confirmed.
    closeCalls.length = 0;
    settingsCalls.length = 0;
    const csNotation = mountCourseSettings();
    try {
      await csNotation.flush();
      const notationInput = csNotation.find((node) => node.type === "input" && node.props?.["aria-label"] === "新规范名称");
      assert.ok(notationInput, "CourseNotationEditor canonical input is mounted");
      await csNotation.act(() => notationInput.props.onChange({ target: { value: "一致收敛" } }));
      const alignBtn = csNotation.find((node) => node.type === "button" && textOf(node).includes("设置 · 考前对齐"));
      assert.ok(alignBtn, "ExamAlignmentPointer leave button is rendered");
      await csNotation.act(() => click(alignBtn));
      assert.equal(settingsCalls.length, 0, "unsaved notationDraftRef blocks navigation");
      assert.equal(closeCalls.length, 0, "unsaved notationDraftRef blocks panel close before leave");
      assert.match(csNotation.text(), /放弃未保存的改动？/);
      await csNotation.act(() => click(csNotation.find((node) => node.type === "button" && textOf(node).trim() === "继续编辑")));
      assert.doesNotMatch(csNotation.text(), /放弃未保存的改动？/);
      assert.equal(settingsCalls.length, 0);
      await csNotation.act(() => click(csNotation.find((node) => node.type === "button" && textOf(node).includes("设置 · 考前对齐"))));
      await csNotation.act(() => click(csNotation.find((node) => node.type === "button" && textOf(node).trim() === "放弃改动")));
      assert.deepEqual(closeCalls, ["dismiss"], "confirming leave closes panel");
      assert.deepEqual(settingsCalls, ["settings-exam-alignment"], "confirming leave proceeds with navigation");
    } finally {
      csNotation.unmount();
    }
  });

  // #1367-9: rendered behaviour — the busy label belongs to teach.answer alone, and the status outlives the complete ternary.
  const panel = (session) => renderToStaticMarkup(h(uiMod.TeachingPanel, {
    session: {
      entry: { teaching: session.teaching, teachAnswer: "破坏循环等待条件" },
      teachingBusy: Boolean(session.busy), teachingAction: session.action ?? "", teachingError: session.error ?? "",
      actions: { teachingAct: () => {}, setTeachAnswer: () => {}, cancelTeaching: () => {}, retryTeaching: () => {} },
    },
    data: { sources: [] }, model: {}, onModelSettings: () => {},
  }));
  const step = { id: "t1", index: 0, total: 3, mode: "understanding", lesson: "先看这一步", check: "为什么按序申请就不会死锁？", complete: false };
  const skipping = panel({ teaching: step, busy: true, action: "teach.skip" });
  assert.ok(!skipping.includes("正在检查…"), "跳过这一步 must not label 检查理解 as 正在检查…");
  assert.ok(skipping.includes("正在准备当前步骤…"), "the shared status line still reports the step in flight");
  const checking = panel({ teaching: step, busy: true, action: "teach.answer" });
  assert.ok(checking.includes("正在检查…"), "检查理解 labels its own step 正在检查…");
  const done = panel({ teaching: { id: "t1", index: 2, total: 3, mode: "understanding", complete: true, transfer: "把这道题迁移到下一题" }, error: "这一步失败了" });
  assert.ok(done.includes("把这道题迁移到下一题"));
  assert.ok(done.includes("这一步失败了"), "the status line is rendered after the complete branch too");
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
    assert.equal(fs.existsSync(path.join(root, "backup-uploads")), false, "a backup upload must never create a folder inside the library");
    assert.equal(fs.existsSync(path.join(backupUploadsHome(root), started.uploadId)), false, "temp backup upload folder must be cleaned up");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1367-10b: the backup cap is what restore can actually parse, the temp copy waits outside the library, and a read failure is named as one", async () => {
  // Restore parses the whole file as one string; the cap has to stay below the V8 string ceiling (~512 MB) with room to parse.
  assert.ok(MAX_BACKUP_UPLOAD_BYTES < 400 * 1024 * 1024, "the upload cap must be a size JSON.parse can actually take");

  const root = tempRoot("1367-10b");
  try {
    const service = new StudyService(root);
    await assert.rejects(
      () => service.call("backup.upload.start", { name: "huge.json", size: MAX_BACKUP_UPLOAD_BYTES + 1 }),
      /256 MB/, "an oversized backup is refused with the real limit, not accepted and then mis-parsed",
    );

    const bytes = Buffer.from(JSON.stringify({ decks: [] }), "utf8");
    const started = await service.call("backup.upload.start", { name: "studyhub-backup.json", size: bytes.length });
    const tempDir = path.join(backupUploadsHome(root), started.uploadId);
    assert.ok(fs.existsSync(tempDir), "the upload waits in the app's own temp home");
    assert.equal(fs.existsSync(path.join(root, "backup-uploads")), false, "nothing is written into the synced library");

    await service.call("backup.upload.chunk", { uploadId: started.uploadId, offset: 0, data: bytes.toString("base64") });
    await service.call("backup.upload.finish", { uploadId: started.uploadId });
    fs.rmSync(path.join(tempDir, "studyhub-backup.json"));
    await assert.rejects(() => service.call("restore", { uploadId: started.uploadId }), (e) => {
      assert.match(e.message, /读不出来/, "an unreadable file is reported as unreadable");
      assert.doesNotMatch(e.message, /不是有效的 JSON/, "and never blamed on the JSON");
      return true;
    });
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
