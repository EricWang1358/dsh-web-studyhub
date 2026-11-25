import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudyService } from "../lib/service.js";
import { contentKey } from "../lib/card-content.js";
import { publishedFingerprint } from "../lib/publication-fingerprint.js";
import { solution } from "../lib/study-state.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "studyhub-1325-batch2-"));
}

test("#1325-2: review.similar on a detour run excludes unanswered cards from the original returnTo round", async () => {
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    await service.call("deck.import", {
      text: JSON.stringify({
        title: "Graphs",
        course: "Algorithms",
        cards: [
          { id: "c1", kind: "flashcard", topic: "BFS", prompt: "BFS queue order?", answer: "FIFO" },
          { id: "c2", kind: "flashcard", topic: "BFS", prompt: "BFS shortest path weight?", answer: "Unweighted" },
          { id: "c3", kind: "flashcard", topic: "BFS", prompt: "BFS time complexity?", answer: "O(V + E)" },
        ],
      }),
    });
    const deck = (await service.store.read()).decks[0];
    const deckId = deck.id;
    const [c1Id, c2Id, c3Id] = deck.cards.map((c) => c.id);
    // Start original round containing c1 and c2
    const originRun = await service.call("review.start", {
      mode: "path",
      scope: [{ deckId, cardId: c1Id }, { deckId, cardId: c2Id }],
    });
    // Start detour run for c1 containing c3 (with returnTo: originRun.id)
    const detourRun = await service.call("review.start", {
      mode: "path",
      scope: [{ deckId, cardId: c3Id }],
      returnTo: originRun.id,
      similarFor: { deckId, cardId: c1Id },
    });
    // Asking for another similar card from the detour run must NOT recommend c1 or c2 from originRun!
    const { item } = await service.call("review.similar", { runId: detourRun.id, cardId: c3Id });
    assert.equal(item, null, "must exclude cards already in origin returnTo run");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1325-4: socratic & answerCard are non-content fields; draft publish preserves unchanged cards' review/socratic/answerCard and clears socratic on edited cards", async () => {
  const baseCard = {
    id: "c-case-1",
    kind: "open",
    topic: "Consensus",
    prompt: "Explain Raft leader election.",
    answer: "Candidates request votes with term numbers.",
    explanation: "Majority quorum prevents split brain.",
  };
  const validAnswerCard = {
    v: 1,
    generatedAt: "2026-11-20T00:00:00.000Z",
    signals: ["split brain"],
    facts: ["quorum"],
    concepts: ["majority"],
    assumptions: [],
    steps: ["Check votes"],
    pitfalls: [],
    marksMap: [],
    conclusion: "Quorum card",
    justification: { summary: "Majority intersection" },
  };
  const withMeta = {
    ...baseCard,
    socratic: { phase: "summary", maxHintLevel: 2, turns: [{ role: "user", text: "hi" }] },
    answerCard: validAnswerCard,
  };
  assert.equal(contentKey(baseCard), contentKey(withMeta));
  assert.equal(publishedFingerprint(baseCard), publishedFingerprint(withMeta));

  // solution() prefers live.answerCard over stale run entry card
  const sol = solution(baseCard, withMeta);
  assert.equal(sol.answerCard?.conclusion, "Quorum card");

  // Full StudyService draft edit + live socratic/answerCard + publish round-trip
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    const meta = { objective: "Understand consensus", hint: "Think of intersection.", explanation: "Any two majorities overlap.", misconception: "Assuming 50% suffices." };
    await service.call("deck.import", {
      text: JSON.stringify({
        title: "Distributed Systems",
        course: "DS",
        cards: [
          { ...meta, id: "c1", kind: "flashcard", topic: "Raft", prompt: "What prevents split brain?", answer: "Quorum majority." },
          { ...meta, id: "c2", kind: "flashcard", topic: "Paxos", prompt: "What is a ballot?", answer: "Monotonic proposal number." },
        ],
      }),
    });
    const deck = (await service.store.read()).decks[0];
    const deckId = deck.id;
    const [c1Id, c2Id] = deck.cards.map((c) => c.id);
    // Open editing draft BEFORE live card receives review/socratic/answerCard
    const draft = await service.call("deck.edit", { id: deckId });
    // Simulate live review progress + socratic + answerCard written while draft is open
    await service.store.update((s) => {
      const liveDeck = s.decks.find((d) => d.id === deckId);
      const c1 = liveDeck.cards.find((c) => c.id === c1Id);
      const c2 = liveDeck.cards.find((c) => c.id === c2Id);
      c1.review = { reps: 4, interval: 14, stability: 12, difficulty: 4.5, due_at: "2026-12-01T00:00:00.000Z" };
      c1.socratic = { phase: "hint", maxHintLevel: 1, turns: [{ role: "assistant", text: "Think about majority." }] };
      c1.answerCard = validAnswerCard;
      c2.review = { reps: 3, interval: 10, stability: 9, difficulty: 5.0, due_at: "2026-12-02T00:00:00.000Z" };
      c2.socratic = { phase: "summary", maxHintLevel: 2, turns: [{ role: "assistant", text: "Old Paxos thread." }] };
    });

    // Edit ONLY c2's prompt in the draft; leave c1 untouched
    const editedCards = draft.cards.map((c) => (c.id === c2Id ? { ...c, prompt: "What is a Prepare phase in Paxos?" } : c));
    await service.call("draft.save", { deck: { ...draft, cards: editedCards } });
    await service.call("draft.publish.quick", { id: draft.id });

    const deckAfter = await service.call("deck.get", { id: deckId });
    const c1After = deckAfter.cards.find((c) => c.id === c1Id);
    const c2After = deckAfter.cards.find((c) => c.id === c2Id);

    // Unchanged c1 preserves FSRS review, socratic, and answerCard
    assert.equal(c1After.review.reps, 4);
    assert.equal(c1After.socratic?.maxHintLevel, 1);
    assert.equal(c1After.answerCard?.conclusion, "Quorum card");

    // Edited c2 resets review AND clears stale socratic thread
    assert.equal(c2After.review.reps, undefined);
    assert.equal(c2After.review.repetitions, 0);
    assert.equal(c2After.socratic, undefined);

    // card.update rewriting c1 also clears c1.socratic
    await service.call("card.update", { deckId, cardId: c1Id, patch: { prompt: "Rewritten Raft quorum prompt?", answer: "Majority of nodes." } });
    const deckUpdated = await service.call("deck.get", { id: deckId });
    assert.equal(deckUpdated.cards.find((c) => c.id === c1Id).socratic, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1325-6 & #1325-10: course.merge relocates companion deck refs & unions generationRules; coach.forget preserves examCoach & course.rename/merge migrates learner", async () => {
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    const targetCourse = await service.call("course.save", {
      name: "Linear Algebra",
      generationRules: ["保留矩阵维度检查", "规则共通"],
    });
    const sourceCourse = await service.call("course.save", {
      name: "LA Alias",
      generationRules: ["规则共通", "给出特征值几何直觉"],
    });

    // Seed companion decks (deliberately put source's deck FIRST in state.decks to verify target is still preferred!), attempts, notes, learner.examCoach, bullets, atomicFacts
    await service.store.update((s) => {
      s.decks.push(
        {
          id: "deck-from-sup",
          title: "LA Alias Companion",
          course: "LA Alias",
          courseId: sourceCourse.id,
          companionSupplementFor: sourceCourse.id,
          cards: [{ id: "card-from-1", kind: "flashcard", topic: "Eigen", prompt: "P1", answer: "A1" }],
        },
        {
          id: "deck-target-sup",
          title: "Linear Algebra Companion",
          course: "Linear Algebra",
          courseId: targetCourse.id,
          companionSupplementFor: targetCourse.id,
          cards: [{ id: "card-target-1", kind: "flashcard", topic: "SVD", prompt: "P2", answer: "A2" }],
        },
      );
      s.attempts.push({ id: "att-1", deckId: "deck-from-sup", cardId: "card-from-1", grade: 1, correct: false, at: "2026-11-20T00:00:00.000Z" });
      s.notes.push({ id: "note-1", title: "LA Note", body: "body", cards: [{ deckId: "deck-from-sup", cardId: "card-from-1" }] });
      s.learner = {
        consent: { prep: true },
        goal: "Ace final",
        preferences: ["concise"],
        summary: "Good at SVD",
        bullets: [
          { id: "b1", text: "Watch matrix dims", course: "LA Alias", source: "user", refs: [{ kind: "hid", course: "LA Alias", hid: "h1" }] },
        ],
        atomicFacts: [
          { id: "f1", text: "Confuses trace and det", course: "LA Alias" },
        ],
        signals: { got: 1, confused: 0, easy: 0, hard: 0, up: 0, down: 0 },
        levels: {},
        solutionExposures: [{ id: "exp-1", stemHash: "abc" }],
        examCoach: {
          "Linear Algebra": { course: "Linear Algebra", version: 1, exposedSampleStems: ["stem-target"] },
          "LA Alias": { course: "LA Alias", version: 1, exposedSampleStems: ["stem-from", "stem-target"] },
        },
        updatedAt: "2026-11-20T00:00:00.000Z",
        memoryRevision: 3,
        prepRevision: 5,
      };
    });

    // 1. coach.forget preserves examCoach, solutionExposures, and increments prepRevision monotonically
    await service.call("coach.forget", {});
    let state = await service.store.read();
    assert.equal(state.learner.goal, "");
    assert.equal(state.learner.prepRevision, 6);
    assert.equal(state.learner.solutionExposures.length, 1);
    assert.ok(state.learner.examCoach["Linear Algebra"]);
    assert.ok(state.learner.examCoach["LA Alias"]);

    // Restore bullet/fact so we can verify course.merge + course.rename learner migration
    await service.store.update((s) => {
      s.learner.bullets = [{ id: "b1", text: "Watch matrix dims", course: "LA Alias", source: "user", refs: [{ kind: "hid", course: "LA Alias", hid: "h1" }] }];
      s.learner.atomicFacts = [{ id: "f1", text: "Confuses trace and det", course: "LA Alias" }];
    });

    // 2. course.merge prefers target companion deck, relocates attempt/note refs, unions generationRules, migrates learner & dedupes exposedSampleStems
    await service.call("course.merge", { into: targetCourse.id, from: [sourceCourse.id] });
    state = await service.store.read();
    const mergedCourse = state.courses.find((c) => c.id === targetCourse.id);
    assert.deepEqual(mergedCourse.generationRules, ["保留矩阵维度检查", "规则共通", "给出特征值几何直觉"]);
    assert.ok(state.decks.some((d) => d.id === "deck-target-sup"), "target's own companion deck is preserved");
    assert.ok(!state.decks.some((d) => d.id === "deck-from-sup"), "donor companion deck is dropped");
    assert.equal(state.attempts[0].deckId, "deck-target-sup", "attempt relocated to target companion deck");
    assert.equal(state.notes[0].cards[0].deckId, "deck-target-sup", "note card ref relocated");
    assert.equal(state.learner.examCoach["LA Alias"], undefined);
    assert.deepEqual(state.learner.examCoach["Linear Algebra"].exposedSampleStems, ["stem-target", "stem-from"]);
    assert.equal(state.learner.bullets[0].course, "Linear Algebra");
    assert.equal(state.learner.bullets[0].refs[0].course, "Linear Algebra");
    assert.equal(state.learner.atomicFacts[0].course, "Linear Algebra");

    // 3. course.rename migrates learner.examCoach, bullets, hid refs, atomicFacts
    await service.call("course.rename", { id: targetCourse.id, name: "Linear Algebra II" });
    state = await service.store.read();
    assert.equal(state.learner.examCoach["Linear Algebra"], undefined);
    assert.equal(state.learner.examCoach["Linear Algebra II"].course, "Linear Algebra II");
    assert.deepEqual(state.learner.examCoach["Linear Algebra II"].exposedSampleStems, ["stem-target", "stem-from"]);
    assert.equal(state.learner.bullets[0].course, "Linear Algebra II");
    assert.equal(state.learner.bullets[0].refs[0].course, "Linear Algebra II");
    assert.equal(state.learner.atomicFacts[0].course, "Linear Algebra II");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
