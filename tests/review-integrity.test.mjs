import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { reviewedCardFingerprint, reviewedCardStatus } from "../lib/review-integrity.js";
import { repairSourcesForCard } from "../lib/repair-evidence.js";
import { qualityReview } from "./helpers/assessment.mjs";

const source = { id: "s", title: "Notes", text: "Architecture sets principles that guide how a system is designed and changed." };
const card = () => ({ id: "q", kind: "flashcard", topic: "Architecture", objective: "Explain architectural principles",
  prompt: "What guides later system design?", answer: "Architectural principles.", hint: "Think of design constraints.",
  explanation: "The notes say principles guide design and change.", misconception: "Only components matter.",
  citations: [{ sourceId: "s", quote: source.text }] });

test("background repair identifies cards without a reliable source before starting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-repair-no-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async () => {
    throw new Error("A model call should not be needed without evidence");
  } });
  await service.call("source.add", source);
  await service.call("source.add", { id: "other", title: "Other", text: "Unrelated material." });
  const missingCitation = { ...card(), citations: [] };
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture",
    cards: [missingCitation] } });
  const rejected = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.equal(rejected.rejected, 1);
  assert.deepEqual(repairSourcesForCard(missingCitation, rejected.rejectedDraft,
    (await service.call("export")).sources), []);
  await assert.rejects(service.call("draft.repair", { id: rejected.rejectedDraft.id,
    draftVersion: rejected.rejectedDraft.draftVersion }), /没有可定位的资料/);
  assert.equal((await service.call("snapshot")).jobs.length, 0);
});

test("review fingerprints detect content edits but ignore property order and scheduling", () => {
  const original = card();
  const fingerprint = reviewedCardFingerprint(original);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.review = { repetitions: 3 };
  assert.equal(reviewedCardFingerprint(reordered), fingerprint);
  assert.notEqual(reviewedCardFingerprint({ ...original, explanation: "A different explanation." }), fingerprint);
  assert.deepEqual(reviewedCardStatus({ cards: [original], editorial: { reviewedCards: { q: fingerprint } } }),
    { unchanged: 1, changed: 0, total: 1 });
  assert.deepEqual(reviewedCardStatus({ cards: [{ ...original, prompt: "Changed?" }], editorial: { reviewedCards: { q: fingerprint } } }),
    { unchanged: 0, changed: 1, total: 1 });
});

test("publishing an edited card automatically rechecks it and keeps the receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-recheck-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let reviews = 0;
  const service = new StudyService(root, { complete: async (system, prompt) => {
    assert.match(system, /^Act as a strict assessment editor/);
    reviews++;
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  } });
  await service.call("source.add", source);
  const original = card();
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [original],
    editorial: { summary: "Generated", reviewedCards: { q: reviewedCardFingerprint(original) } } } });
  const edited = await service.call("draft.save", { deck: { ...saved,
    cards: [{ ...original, explanation: "The source identifies architectural principles as guidance for future design and change." }] } });
  const result = await service.call("draft.publish", { id: "d", draftVersion: edited.draftVersion });
  assert.equal(reviews, 1);
  assert.deepEqual({ autoReviewed: result.autoReviewed, unchecked: result.unchecked }, { autoReviewed: 1, unchecked: 0 });
  const published = (await service.call("export")).decks[0];
  assert.equal(published.editorial.reviewedCards.q, reviewedCardFingerprint(published.cards[0]));
  assert.equal(published.editorial.publishReview.checks.length, 1);
});

test("publishing an unchanged reviewed card needs no extra model call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-recheck-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async () => { throw new Error("Unexpected model call"); } });
  await service.call("source.add", source);
  const original = card();
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [original],
    editorial: { reviewedCards: { q: reviewedCardFingerprint(original) } } } });
  const result = await service.call("draft.publish", { id: "d", draftVersion: saved.draftVersion });
  assert.deepEqual({ autoReviewed: result.autoReviewed, unchecked: result.unchecked }, { autoReviewed: 0, unchecked: 0 });
});

test("an unattributed batch concern is isolated before sound cards publish", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-ambiguous-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const service = new StudyService(root, { complete: async (_system, prompt) => {
    const input = JSON.parse(prompt);
    const candidate = input.candidate;
    calls.push(candidate.cards.map((item) => item.id));
    const review = qualityReview(candidate);
    if (candidate.cards.length > 1) review.issues = ["One card has insufficient source support"];
    else {
      assert.deepEqual(input.priorBatchConcerns, ["One card has insufficient source support"]);
      if (candidate.cards[0].id === "bad") review.checks[0].sourceSupport = "fail";
    }
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const bad = { ...card(), id: "bad", objective: "Explain later evolution",
    prompt: "What guides later evolution?" };
  const draft = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card(), bad] } });
  const result = await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  assert.deepEqual(calls, [["q", "bad"], ["q"], ["bad"]]);
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected }, { accepted: 1, rejected: 1 });
  assert.equal((await service.call("export")).decks[0].cards[0].id, "q");
});

test("card ids that share a prefix are not confused during batch review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-review-id-prefix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const service = new StudyService(root, { complete: async (_system, prompt) => {
    calls++;
    const review = qualityReview(JSON.parse(prompt).candidate);
    review.issues = ["q10: source support is insufficient"];
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const later = { ...card(), id: "q10", objective: "Explain later evolution",
    prompt: "What guides later evolution?" };
  const draft = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card(), later] } });
  const result = await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  assert.equal(calls, 1);
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected }, { accepted: 1, rejected: 1 });
  assert.equal(result.rejectedDraft.cards[0].id, "q10");
});

test("an incomplete batch review is retried per card before publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-incomplete-batch-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const service = new StudyService(root, { complete: async (_system, prompt) => {
    calls++;
    const candidate = JSON.parse(prompt.split("\n\nYour previous review was unusable:")[0]).candidate;
    const review = qualityReview(candidate);
    if (candidate.cards.length > 1) review.checks.pop();
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const second = { ...card(), id: "q2", objective: "Explain later evolution",
    prompt: "What guides later evolution?" };
  const draft = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card(), second] } });
  const result = await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  assert.equal(calls, 4);
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected }, { accepted: 2, rejected: 0 });
});

test("a failed batch review isolates cards, then publishes an unavailable review as unchecked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-batch-review-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const service = new StudyService(root, { complete: async (_system, prompt) => {
    const candidate = JSON.parse(prompt).candidate;
    calls.push(candidate.cards.map((item) => item.id));
    if (candidate.cards.length > 1 || candidate.cards[0].id === "bad") throw new Error("Model request failed");
    return JSON.stringify(qualityReview(candidate));
  } });
  await service.call("source.add", source);
  const bad = { ...card(), id: "bad", objective: "Explain later evolution",
    prompt: "What guides later evolution?" };
  const draft = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card(), bad] } });
  const result = await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  assert.deepEqual(calls, [["q", "bad"], ["q"], ["bad"]]);
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected, unchecked: result.unchecked },
    { accepted: 2, rejected: 0, unchecked: 1 });
  assert.deepEqual((await service.call("export")).decks[0].cards.map((item) => item.id), ["q", "bad"]);
  assert.equal((await service.call("snapshot")).decks[0].uncheckedAtPublish, 1);
});

test("a single model outage does not hold back a structurally valid card", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-review-outage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async () => { throw new Error("Model request failed"); } });
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card()] } });
  const result = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected, unchecked: result.unchecked },
    { accepted: 1, rejected: 0, unchecked: 1 });
  assert.equal((await service.call("snapshot")).decks[0].uncheckedAtPublish, 1);
  const online = new StudyService(root, { complete: async (_system, prompt) =>
    JSON.stringify(qualityReview(JSON.parse(prompt).candidate)) });
  const edit = await online.call("deck.edit", { id: "d" });
  const revised = await online.call("draft.save", { deck: { ...edit,
    cards: [{ ...edit.cards[0], prompt: "Which principles guide future design?" }] } });
  await online.call("draft.publish", { id: revised.id, draftVersion: revised.draftVersion });
  assert.equal((await online.call("snapshot")).decks[0].uncheckedAtPublish, 0,
    "the warning clears once the current card has passed model review");
});

test("editing a deck with an open study run explains how to finish publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-edit-open-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const draft = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card()] } });
  await service.call("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  const run = await service.call("review.start", { deckId: "d", mode: "flashcard" });
  assert.deepEqual((await service.call("snapshot")).runs[0].deckIds, ["d"]);
  let reviewCalls = 0;
  const online = new StudyService(root, { complete: async (_system, prompt) => {
    reviewCalls++;
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  } });
  const edit = await online.call("deck.edit", { id: "d" });
  const changed = await online.call("draft.save", { deck: { ...edit,
    cards: [{ ...edit.cards[0], prompt: "What guides the future design of a system?" }] } });
  await assert.rejects(online.call("draft.publish", { id: changed.id, draftVersion: changed.draftVersion }),
    /请先完成或结束练习/);
  assert.equal(reviewCalls, 0, "an open run blocks publication before model review");
  await service.call("review.end", { runId: run.id });
  const published = await online.call("draft.publish", { id: changed.id, draftVersion: changed.draftVersion });
  assert.equal(published.accepted, 1);
  assert.ok(reviewCalls > 0);
});

test("failed automatic review keeps the card in a draft; an absent model is reported honestly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-recheck-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async (_system, prompt) => {
    const review = qualityReview(JSON.parse(prompt).candidate);
    review.checks[0].sourceSupport = "fail";
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card()] } });
  const reviewed = await service.call("draft.publish", { id: "d", draftVersion: saved.draftVersion });
  assert.deepEqual({ accepted: reviewed.accepted, rejected: reviewed.rejected }, { accepted: 0, rejected: 1 });
  assert.match(reviewed.rejectedDraft.editorial.rejectedIssues.q.join(), /sourceSupport/);
  assert.equal((await service.call("export")).decks.length, 0);
  assert.equal((await service.call("export")).drafts.length, 1);
  const offline = new StudyService(root);
  const result = await offline.call("draft.publish", { id: "d", draftVersion: reviewed.rejectedDraft.draftVersion });
  assert.deepEqual({ autoReviewed: result.autoReviewed, unchecked: result.unchecked }, { autoReviewed: 0, unchecked: 1 });
  assert.equal((await offline.call("snapshot")).decks[0].uncheckedAtPublish, 1);
});

test("manually changing a rejected card clears obsolete findings before optional repair", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-manual-fix-rejected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async (_system, prompt) => {
    const candidate = JSON.parse(prompt).candidate;
    const review = qualityReview(candidate);
    if (!candidate.cards[0].explanation.startsWith("Fixed:"))
      review.checks[0].explanationQuality = "fail";
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card()] } });
  const rejected = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.ok(rejected.rejectedDraft.editorial.rejectedIssues.q);
  const titleOnly = await service.call("draft.save", { deck: { ...rejected.rejectedDraft, title: "Architecture revised" } });
  assert.ok(titleOnly.editorial.rejectedIssues.q, "a title edit does not clear the card finding");
  const corrected = await service.call("draft.save", { deck: { ...titleOnly,
    cards: [{ ...titleOnly.cards[0], explanation: "Fixed: the source identifies principles as guidance for design and change." }] } });
  assert.deepEqual(corrected.editorial.rejectedIssues, {});
  assert.match(corrected.editorial.summary, /按新内容重新检查/);
  await assert.rejects(service.call("draft.repair", { id: corrected.id, draftVersion: corrected.draftVersion }),
    /没有待处理的题目/);
  const published = await service.call("draft.publish", { id: corrected.id, draftVersion: corrected.draftVersion });
  assert.deepEqual({ accepted: published.accepted, rejected: published.rejected }, { accepted: 1, rejected: 0 });
});

test("good cards publish first and optional background repair adds the rejected card later", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-partial-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let repairCalls = 0;
  const service = new StudyService(root, { complete: async (system, prompt) => {
    if (system.startsWith("Repair one draft card")) {
      repairCalls++;
      const input = JSON.parse(prompt);
      return JSON.stringify({ card: { ...input.card,
        explanation: "Fixed: the cited principles guide both design and later evolution." } });
    }
    assert.match(system, /^Act as a strict assessment editor/);
    const review = qualityReview(JSON.parse(prompt).candidate);
    for (const check of review.checks)
      if (check.cardId === "bad" && !JSON.parse(prompt).candidate.cards.find((item) => item.id === "bad")
        .explanation.includes("Fixed:")) {
        check.explanationQuality = "fail";
        check.explanation = "The explanation does not connect the source to the answer.";
      }
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const bad = { ...card(), id: "bad", objective: "Explain future evolution", prompt: "What guides later evolution?" };
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card(), bad] } });
  const first = await service.call("draft.publish", { id: "d", draftVersion: saved.draftVersion });
  assert.deepEqual({ accepted: first.accepted, rejected: first.rejected }, { accepted: 1, rejected: 1 });
  assert.deepEqual((await service.call("export")).decks[0].cards.map((item) => item.id), ["q"]);
  assert.equal(repairCalls, 0);
  assert.equal((await service.call("export")).drafts[0].id, first.rejectedDraft.id);
  const started = await service.call("draft.repair", { id: first.rejectedDraft.id, draftVersion: first.rejectedDraft.draftVersion });
  assert.equal((await service.call("job.wait", { jobId: started.jobId })).status, "complete");
  assert.equal(repairCalls, 1);
  const repaired = (await service.call("export")).drafts[0];
  assert.equal(Object.keys(repaired.editorial.rejectedIssues).length, 0);
  assert.match(repaired.cards[0].explanation, /^Fixed:/);
  const second = await service.call("draft.publish", { id: repaired.id, draftVersion: repaired.draftVersion });
  assert.deepEqual({ accepted: second.accepted, rejected: second.rejected }, { accepted: 1, rejected: 0 });
  assert.deepEqual((await service.call("export")).decks[0].cards.map((item) => item.id), ["q", "bad"]);
  assert.equal((await service.call("export")).drafts.length, 0);
});

test("background repair can restore a missing citation from the draft's original sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-repair-missing-citation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async (system, prompt) => {
    if (system.startsWith("Repair one draft card")) {
      const input = JSON.parse(prompt);
      assert.deepEqual(input.sources.map((item) => item.id), ["s"]);
      return JSON.stringify({ card: { ...input.card, citations: [{ sourceId: "s", quote: source.text }] } });
    }
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  } });
  await service.call("source.add", source);
  await service.call("source.add", { id: "other", title: "Other", text: "Unrelated material." });
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture",
    cards: [{ ...card(), citations: [] }], editorial: { generation: { sourceIds: ["s"] } } } });
  const first = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.deepEqual({ accepted: first.accepted, rejected: first.rejected }, { accepted: 0, rejected: 1 });
  const started = await service.call("draft.repair", { id: first.rejectedDraft.id,
    draftVersion: first.rejectedDraft.draftVersion });
  const job = await service.call("job.wait", { jobId: started.jobId });
  assert.deepEqual({ status: job.status, savedCount: job.savedCount }, { status: "complete", savedCount: 1 });
  const repaired = (await service.call("export")).drafts[0];
  assert.deepEqual(repaired.cards[0].citations, [{ sourceId: "s", quote: source.text }]);
  const second = await service.call("draft.publish", { id: repaired.id, draftVersion: repaired.draftVersion });
  assert.deepEqual({ accepted: second.accepted, rejected: second.rejected }, { accepted: 1, rejected: 0 });
});

test("a source chosen for missing-citation repair cannot disappear during that job", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-repair-source-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let entered, release;
  const repairing = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new StudyService(root, { complete: async (system, prompt) => {
    if (system.startsWith("Repair one draft card")) {
      entered();
      await gate;
      const input = JSON.parse(prompt);
      return JSON.stringify({ card: { ...input.card, citations: [{ sourceId: "s", quote: source.text }] } });
    }
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  } });
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture",
    cards: [{ ...card(), citations: [] }] } });
  const rejected = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  const started = await service.call("draft.repair", { id: rejected.rejectedDraft.id,
    draftVersion: rejected.rejectedDraft.draftVersion });
  await repairing;
  await assert.rejects(service.call("source.remove", { id: "s" }), /正在用于出题/);
  release();
  await service.call("job.wait", { jobId: started.jobId });
});

test("deleting a draft during background repair cancels the job without recreating the draft", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-repair-delete-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let entered, release;
  const repairing = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new StudyService(root, { complete: async (system, prompt) => {
    if (system.startsWith("Repair one draft card")) {
      entered();
      await gate;
      const input = JSON.parse(prompt);
      return JSON.stringify({ card: { ...input.card, explanation: "Fixed: the notes support this answer." } });
    }
    const candidate = JSON.parse(prompt).candidate;
    const review = qualityReview(candidate);
    if (!candidate.cards[0].explanation.startsWith("Fixed:"))
      review.checks[0].explanationQuality = "fail";
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card()] } });
  const rejected = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  const started = await service.call("draft.repair", { id: rejected.rejectedDraft.id,
    draftVersion: rejected.rejectedDraft.draftVersion });
  await repairing;
  await service.call("draft.delete", { id: rejected.rejectedDraft.id,
    draftVersion: rejected.rejectedDraft.draftVersion });
  release();
  const job = await service.call("job.wait", { jobId: started.jobId });
  assert.equal(job.status, "cancelled");
  assert.deepEqual((await service.call("export")).drafts, []);
});

test("a stale editor cannot recreate a draft after another window deletes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-stale-deleted-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card()] } });
  await service.call("draft.delete", { id: saved.id, draftVersion: saved.draftVersion });
  await assert.rejects(service.call("draft.save", { deck: { ...saved, title: "Old window edit" } }),
    /草稿已删除或发布/);
  assert.deepEqual((await service.call("export")).drafts, []);
  const newDraft = await service.call("draft.save", { deck: { id: "new", title: "New draft", cards: [card()] } });
  assert.equal(newDraft.draftVersion, 1);
});

test("background repair does not count a duplicate of a published card as fixed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-repair-duplicate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async (system, prompt) => {
    if (system.startsWith("Repair one draft card")) {
      const input = JSON.parse(prompt);
      assert.ok(input.otherQuestions.some((item) => item.objective === card().objective));
      return JSON.stringify({ card: { ...input.card, objective: card().objective,
        explanation: "Fixed: the notes identify principles as guidance for design and change." } });
    }
    const candidate = JSON.parse(prompt).candidate;
    const review = qualityReview(candidate);
    if (candidate.cards[0].id === "bad" && !candidate.cards[0].explanation.startsWith("Fixed:"))
      review.checks[0].explanationQuality = "fail";
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const published = await service.call("draft.save", { deck: { id: "live", title: "Live", cards: [card()] } });
  await service.call("draft.publish", { id: published.id, draftVersion: published.draftVersion });
  const bad = { ...card(), id: "bad", objective: "Explain future evolution", prompt: "What guides future evolution?" };
  const edit = await service.call("deck.edit", { id: "live" });
  const saved = await service.call("draft.save", { deck: { ...edit, cards: [...edit.cards, bad] } });
  const rejected = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  const started = await service.call("draft.repair", { id: rejected.rejectedDraft.id,
    draftVersion: rejected.rejectedDraft.draftVersion });
  const job = await service.call("job.wait", { jobId: started.jobId });
  assert.deepEqual({ status: job.status, savedCount: job.savedCount }, { status: "failed", savedCount: 0 });
  const remaining = (await service.call("export")).drafts[0];
  assert.match(remaining.editorial.rejectedIssues.bad.join(), /学习目标与已通过或已发布的题目重复/);
});

test("background repair reports partial success while retaining unsolved cards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-repair-partial-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async (system, prompt) => {
    if (system.startsWith("Repair one draft card")) {
      const input = JSON.parse(prompt);
      return JSON.stringify({ card: { ...input.card,
        explanation: input.card.id === "bad1"
          ? "Fixed: the source identifies principles as guidance for design and change."
          : input.card.explanation } });
    }
    const review = qualityReview(JSON.parse(prompt).candidate);
    for (const check of review.checks) {
      const candidate = JSON.parse(prompt).candidate.cards.find((item) => item.id === check.cardId);
      if (!candidate.explanation.startsWith("Fixed:")) check.explanationQuality = "fail";
    }
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const bad1 = { ...card(), id: "bad1", objective: "Explain design", prompt: "What guides system design?" };
  const bad2 = { ...card(), id: "bad2", objective: "Explain evolution", prompt: "What guides system evolution?" };
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [bad1, bad2] } });
  const rejected = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.equal(rejected.rejected, 2);
  const started = await service.call("draft.repair", { id: rejected.rejectedDraft.id,
    draftVersion: rejected.rejectedDraft.draftVersion });
  const job = await service.call("job.wait", { jobId: started.jobId });
  assert.deepEqual({ status: job.status, savedCount: job.savedCount }, { status: "partial", savedCount: 1 });
  const remaining = (await service.call("export")).drafts[0];
  assert.equal(remaining.editorial.rejectedIssues.bad1, undefined);
  assert.ok(remaining.editorial.rejectedIssues.bad2?.length);
  const published = await service.call("draft.publish", { id: remaining.id, draftVersion: remaining.draftVersion });
  assert.deepEqual({ accepted: published.accepted, rejected: published.rejected }, { accepted: 1, rejected: 1 });
});

test("background repair corrects a duplicate once and independently reviews the second draft", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-repair-duplicate-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let repairs = 0, reviews = 0;
  const service = new StudyService(root, { complete: async (system, prompt) => {
    if (system.startsWith("Repair one draft card")) {
      const input = JSON.parse(prompt);
      repairs++;
      if (repairs === 2) assert.match(input.issues.join(), /学习目标与已通过或已发布的题目重复/);
      return JSON.stringify({ card: { ...input.card,
        objective: repairs === 1 ? card().objective : "Explain future evolution",
        explanation: "Fixed: the notes identify principles as guidance for design and change." } });
    }
    const candidate = JSON.parse(prompt).candidate;
    const review = qualityReview(candidate);
    if (candidate.cards[0].id === "bad" && !candidate.cards[0].explanation.startsWith("Fixed:"))
      review.checks[0].explanationQuality = "fail";
    if (candidate.cards[0].id === "bad" && candidate.cards[0].explanation.startsWith("Fixed:")) reviews++;
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const published = await service.call("draft.save", { deck: { id: "live", title: "Live", cards: [card()] } });
  await service.call("draft.publish", { id: published.id, draftVersion: published.draftVersion });
  const bad = { ...card(), id: "bad", objective: "Explain future evolution", prompt: "What guides future evolution?" };
  const edit = await service.call("deck.edit", { id: "live" });
  const saved = await service.call("draft.save", { deck: { ...edit, cards: [...edit.cards, bad] } });
  const rejected = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  const started = await service.call("draft.repair", { id: rejected.rejectedDraft.id,
    draftVersion: rejected.rejectedDraft.draftVersion });
  const job = await service.call("job.wait", { jobId: started.jobId });
  assert.deepEqual({ status: job.status, savedCount: job.savedCount }, { status: "complete", savedCount: 1 });
  assert.equal(repairs, 2);
  assert.equal(reviews, 1);
  const repaired = (await service.call("export")).drafts[0];
  const result = await service.call("draft.publish", { id: repaired.id, draftVersion: repaired.draftVersion });
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected }, { accepted: 1, rejected: 0 });
  assert.deepEqual((await service.call("deck.get", { id: "live" })).cards.map((item) => item.id), ["q", "bad"]);
});

test("partial edits preserve the published cards and apply repaired edits later", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-partial-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async (_system, prompt) => {
    const review = qualityReview(JSON.parse(prompt).candidate);
    for (const check of review.checks) {
      const candidate = JSON.parse(prompt).candidate.cards.find((item) => item.id === check.cardId);
      if (candidate?.prompt.includes("Broken")) check.sourceSupport = "fail";
    }
    return JSON.stringify(review);
  } });
  await service.call("source.add", source);
  const second = { ...card(), id: "q2", objective: "Explain future evolution",
    prompt: "What guides later evolution?" };
  const original = await service.call("draft.save", { deck: { id: "d", title: "Architecture",
    cards: [card(), second] } });
  await service.call("draft.publish", { id: original.id, draftVersion: original.draftVersion });
  const edit = await service.call("deck.edit", { id: "d" });
  const saved = await service.call("draft.save", { deck: { ...edit, cards: edit.cards.map((item) =>
    item.id === "q" ? { ...item, prompt: "Which principles guide future system design?" }
      : { ...item, prompt: "Broken: what guides later evolution?" }) } });
  const partial = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.deepEqual({ accepted: partial.accepted, rejected: partial.rejected }, { accepted: 1, rejected: 1 });
  const live = await service.call("deck.get", { id: "d" });
  assert.equal(live.cards.length, 2);
  assert.equal(live.cards[0].prompt, "Which principles guide future system design?");
  assert.equal(live.cards[1].prompt, "What guides later evolution?");
  assert.equal(live.editorial.reviewedCards.q2, reviewedCardFingerprint(live.cards[1]));
  assert.equal(partial.rejectedDraft.editorial.partialEdit, true);
  const fixed = await service.call("draft.save", { deck: { ...partial.rejectedDraft,
    cards: [{ ...partial.rejectedDraft.cards[0], prompt: "How do principles guide later evolution?" }] } });
  const completed = await service.call("draft.publish", { id: fixed.id, draftVersion: fixed.draftVersion });
  assert.deepEqual({ accepted: completed.accepted, rejected: completed.rejected }, { accepted: 1, rejected: 0 });
  const final = await service.call("deck.get", { id: "d" });
  assert.deepEqual(final.cards.map((item) => item.id), ["q", "q2"]);
  assert.equal(final.cards[0].prompt, "Which principles guide future system design?");
  assert.equal(final.cards[1].prompt, "How do principles guide later evolution?");
  assert.equal(final.editorial.reviewedCards.q, reviewedCardFingerprint(final.cards[0]));
  assert.equal(final.editorial.reviewedCards.q2, reviewedCardFingerprint(final.cards[1]));
});

test("an incomplete card can be saved and does not block publishing its sound sibling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-incomplete-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const unfinished = { ...card(), id: "unfinished", objective: "Explain later evolution", prompt: "" };
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card(), unfinished] } });
  assert.match(saved.quality.errors.join(), /Card 2: prompt is required/);
  const result = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected }, { accepted: 1, rejected: 1 });
  assert.deepEqual((await service.call("deck.get", { id: "d" })).quality.errors, []);
  assert.match(result.rejectedDraft.editorial.rejectedIssues.unfinished.join(), /prompt is required/);
  assert.match(result.rejectedDraft.quality.errors.join(), /prompt is required/);
});

test("an edit that duplicates an unchanged published card stays pending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-duplicate-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", source);
  const second = { ...card(), id: "second", objective: "Explain later evolution",
    prompt: "What guides later evolution?" };
  const initial = await service.call("draft.save", { deck: { id: "d", title: "Architecture",
    cards: [card(), second] } });
  await service.call("draft.publish", { id: initial.id, draftVersion: initial.draftVersion });
  const edit = await service.call("deck.edit", { id: "d" });
  const saved = await service.call("draft.save", { deck: { ...edit,
    cards: [{ ...edit.cards[0], prompt: second.prompt }, edit.cards[1]] } });
  const result = await service.call("draft.publish", { id: saved.id, draftVersion: saved.draftVersion });
  assert.deepEqual({ accepted: result.accepted, rejected: result.rejected }, { accepted: 1, rejected: 1 });
  assert.equal(result.rejectedDraft.cards[0].id, "q");
  assert.match(result.rejectedDraft.editorial.rejectedIssues.q.join(), /问题与另一道题重复/);
  const live = await service.call("deck.get", { id: "d" });
  assert.deepEqual(live.cards.map((item) => item.prompt), [card().prompt, second.prompt]);
  assert.deepEqual(live.quality.errors, []);
});

test("a concurrent edit invalidates a completed publication review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-recheck-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let service;
  service = new StudyService(root, { complete: async (_system, prompt) => {
    const state = await service.call("export");
    const draft = state.drafts[0];
    await service.call("draft.save", { deck: { ...draft, title: "Changed while reviewing" } });
    return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  } });
  await service.call("source.add", source);
  const saved = await service.call("draft.save", { deck: { id: "d", title: "Architecture", cards: [card()] } });
  await assert.rejects(service.call("draft.publish", { id: "d", draftVersion: saved.draftVersion }), /Draft changed/);
  assert.equal((await service.call("export")).drafts.length, 1);
});
