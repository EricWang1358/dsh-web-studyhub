import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudyService } from "../lib/service.js";
import { courseProfileFromState } from "../lib/case-study.js";
import { generationRulesOf, ownGenerationRulesOf, resolveCourseProfileRecord } from "../lib/courses.js";
import { resolveCourseNotationLedger } from "../lib/contexts/generation/inventory/notation-merge.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "studyhub-1325-batch1-"));
}

test("#1325-1: deck.course updates deck.course, clears legacy folder, supports explicit empty string (uncategorised) and syncs drafts", async () => {
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    await service.call("deck.import", {
      text: JSON.stringify({
        title: "Ch1 Quiz",
        course: "Algorithms",
        cards: [{ kind: "flashcard", topic: "Sorting", prompt: "What is mergesort complexity?", answer: "O(n log n)" }],
      }),
    });
    const deckId = (await service.store.read()).decks[0].id;
    const draft = await service.call("deck.edit", { id: deckId });
    assert.equal(draft.course, "Algorithms");

    // Reassign to another course
    const moved = await service.call("deck.course", { id: deckId, course: "OS / Ch 3" });
    assert.equal(moved.course, "OS / Ch 3");
    const afterMove = await service.call("deck.get", { id: deckId });
    assert.equal(afterMove.course, "OS / Ch 3");
    assert.equal(afterMove.folder || "", "");

    // Explicitly move back to uncategorised with empty string ""
    const cleared = await service.call("deck.course", { id: deckId, course: "" });
    assert.equal(cleared.course, "");
    const afterClear = await service.call("deck.get", { id: deckId });
    assert.equal(afterClear.course, "");
    assert.equal(afterClear.folder || "", "");
    assert.equal(afterClear.courseId, undefined);

    // Synced draft also cleared
    const snap = await service.call("snapshot", {});
    const draftAfter = snap.drafts.find((d) => d.id === draft.id);
    assert.equal(draftAfter.course, "");

    // Missing course argument still fails
    await assert.rejects(() => service.call("deck.course", { id: deckId }), /课程名称/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1325-3: courseProfile & courseProfileFromState inherit exam, guidanceSourceIds, focusTopics, practice along courseAncestors", async () => {
  const state = {
    sources: [
      { id: "src-parent-guide", title: "Parent Rubric", courses: ["OS"] },
      { id: "src-child-guide", title: "Ch3 Rubric", courses: ["OS / Ch 3"] },
    ],
    courses: [
      {
        id: "course-os",
        name: "OS",
        aliases: ["Operating Systems"],
        exam: {
          format: "open-book-case",
          totalMarks: 100,
          writingMinutes: 150,
          readingMinutes: 25,
          minutesPerMark: 1.5,
          date: "2026-06-20",
          sections: [{ title: "Case A", marks: 50, topics: ["VM"] }],
        },
        guidanceSourceIds: ["src-parent-guide", "src-missing"],
        focusTopics: ["Virtual Memory", "Scheduling"],
        practice: { aiGradeFlashcards: true },
      },
      {
        id: "course-os-ch3",
        name: "OS / Ch 3",
        aliases: [],
        guidanceSourceIds: ["src-child-guide"],
        focusTopics: ["Paging"],
      },
    ],
  };

  // Existing child inherits parent exam, practice, unions guidance & focusTopics (filtering missing sources)
  const childProfile = courseProfileFromState(state, "OS / Ch 3");
  assert.equal(childProfile.exam.format, "open-book-case");
  assert.equal(childProfile.exam.totalMarks, 100);
  assert.equal(childProfile.exam.minutesPerMark, 1.5);
  assert.equal(childProfile.exam.readingMinutes, 25);
  assert.equal(childProfile.exam.date, "2026-06-20");
  assert.equal(childProfile.examFormatSource, "OS");
  assert.deepEqual(childProfile.guidanceSourceIds, ["src-child-guide", "src-parent-guide"]);
  assert.deepEqual(childProfile.focusTopics, ["Paging", "Virtual Memory", "Scheduling"]);
  assert.equal(childProfile.practice?.aiGradeFlashcards, true);
  assert.deepEqual(childProfile.inheritedFrom, ["OS"]);

  // Unregistered grandchild still inherits from child + parent
  const grandChildProfile = resolveCourseProfileRecord(state, "OS / Ch 3 / TLB");
  assert.equal(grandChildProfile.exam.minutesPerMark, 1.5);
  assert.deepEqual(grandChildProfile.guidanceSourceIds, ["src-child-guide", "src-parent-guide"]);
  assert.deepEqual(grandChildProfile.focusTopics, ["Paging", "Virtual Memory", "Scheduling"]);
  assert.equal(grandChildProfile.practice?.aiGradeFlashcards, true);
  assert.deepEqual(grandChildProfile.inheritedFrom, ["OS / Ch 3", "OS"]);

  // Child overriding totalMarks keeps parent minutesPerMark and derives consistent writingMinutes
  const overridden = courseProfileFromState({
    ...state,
    courses: [
      state.courses[0],
      { ...state.courses[1], exam: { totalMarks: 40 } },
    ],
  }, "OS / Ch 3");
  assert.equal(overridden.exam.totalMarks, 40);
  assert.equal(overridden.exam.minutesPerMark, 1.5);
  assert.equal(overridden.exam.writingMinutes, 60);

  // Backend course.profile also inherits parent settings
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    const guide = await service.call("source.add", { title: "Examiner Guide", text: "Rubric details for OS case analysis.", courses: ["OS"] });
    await service.call("course.save", {
      name: "OS",
      exam: { format: "open-book-case", totalMarks: 80, writingMinutes: 120, minutesPerMark: 1.5 },
      guidanceSourceIds: [guide.id],
      focusTopics: ["Deadlock"],
      practice: { aiGradeFlashcards: true },
    });
    const prof = await service.call("course.profile", { name: "OS / Ch 3" });
    assert.equal(prof.exam.totalMarks, 80);
    assert.equal(prof.exam.minutesPerMark, 1.5);
    assert.deepEqual(prof.guidanceSourceIds, [guide.id]);
    assert.deepEqual(prof.focusTopics, ["Deadlock"]);
    assert.equal(prof.practice?.aiGradeFlashcards, true);
    assert.deepEqual(prof.inheritedFrom, ["OS"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1325-5: generationRulesOf & resolveCourseNotationLedger inherit along courseAncestors with child-first priority", () => {
  const parentRules = Array.from({ length: 10 }, (_, i) => `父课守则 ${i + 1}`);
  const childRules = ["子课守则 A", "子课守则 B", "子课守则 C", "父课守则 1"];
  const state = {
    courses: [
      {
        id: "c-parent",
        name: "Math",
        generationRules: parentRules,
        notationOverrides: [
          { canonical: "Gradient", symbol: "\\nabla f", aliases: ["grad_parent"], meaning: "Parent manual gradient" },
          { canonical: "Eigenvalue", symbol: "\\lambda", aliases: [], meaning: "Parent manual eigenvalue" },
        ],
      },
      {
        id: "c-child",
        name: "Math / Ch 2",
        generationRules: childRules,
        notationOverrides: [
          { canonical: "Gradient", symbol: "\\vec{\\nabla} f", aliases: ["grad_child"], meaning: "Child manual gradient" },
        ],
      },
    ],
    sources: [
      {
        id: "outline-parent",
        provenance: "course-outline",
        courses: ["Math"],
        createdAt: "2026-01-01T00:00:00.000Z",
        courseOutline: {
          version: 1,
          notationLedger: [
            { canonical: "Gradient", symbol: "D f", aliases: ["grad_p_outline"], meaning: "Parent outline gradient" },
            { canonical: "Norm", symbol: "\\|x\\|", aliases: ["p_norm"], meaning: "Parent outline norm" },
            { canonical: "Inner Product", symbol: "\\langle x, y \\rangle", aliases: [], meaning: "Parent outline inner product" },
          ],
        },
      },
      {
        id: "outline-child",
        provenance: "course-outline",
        courses: ["Math / Ch 2"],
        createdAt: "2026-01-02T00:00:00.000Z",
        courseOutline: {
          version: 1,
          notationLedger: [
            { canonical: "Eigenvalue", symbol: "\\mu", aliases: ["eig_c_outline"], meaning: "Child outline eigenvalue" },
            { canonical: "Norm", symbol: "\\|x\\|_2", aliases: ["c_norm"], meaning: "Child outline norm" },
          ],
        },
      },
    ],
  };

  // ownGenerationRulesOf reads ONLY child's own rules (never pollutes write-back with parent rules)
  assert.deepEqual(ownGenerationRulesOf(state, "Math / Ch 2"), childRules);

  // generationRulesOf puts child rules first, then deduplicates parent rules up to limit 12
  const effectiveRules = generationRulesOf(state, "Math / Ch 2");
  assert.equal(effectiveRules.length, 12);
  assert.deepEqual(effectiveRules.slice(0, 4), childRules);
  assert.equal(effectiveRules[4], "父课守则 2");
  assert.equal(effectiveRules.filter((r) => r === "父课守则 1").length, 1);

  // Notation ledger priority: child manual > parent manual > child outline > parent outline, preserving aliases
  const ledger = resolveCourseNotationLedger(state, "Math / Ch 2");
  const byName = new Map(ledger.map((e) => [e.canonical, e]));

  // Child manual beats parent manual & parent outline, preserving aliases from both
  assert.equal(byName.get("Gradient")?.meaning, "Child manual gradient");
  assert.equal(byName.get("Gradient")?.symbol, "\\vec{\\nabla} f");
  assert.ok(byName.get("Gradient")?.aliases.includes("grad_child"));
  assert.ok(byName.get("Gradient")?.aliases.includes("grad_parent"));
  assert.ok(byName.get("Gradient")?.aliases.includes("grad_p_outline"));

  // Parent manual beats child outline
  assert.equal(byName.get("Eigenvalue")?.meaning, "Parent manual eigenvalue");
  assert.equal(byName.get("Eigenvalue")?.symbol, "\\lambda");
  assert.ok(byName.get("Eigenvalue")?.aliases.includes("eig_c_outline"));

  // Child outline beats parent outline
  assert.equal(byName.get("Norm")?.meaning, "Child outline norm");
  assert.equal(byName.get("Norm")?.symbol, "\\|x\\|_2");
  assert.ok(byName.get("Norm")?.aliases.includes("p_norm"));

  // Parent outline inherited when child has none
  assert.equal(byName.get("Inner Product")?.meaning, "Parent outline inner product");
});
