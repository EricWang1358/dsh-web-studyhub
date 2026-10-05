import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { estimateFromState } from "../lib/token-estimate.js";
import { extraQuestionDefault } from "../lib/draft-continuation.js";
import { withQualityStages } from "./helpers/assessment.mjs";
import { settleJob } from "./helpers/wait.mjs";

/* #196: 「用未覆盖的资料补题」 adds questions to the deck that is open, from the sources that deck has not covered,
   through the same continuation pipeline as 继续补齐. It never makes a new deck. */

const sourceA = { id: "page-a", title: "Book p.1", text: "Architecture includes the principles guiding a system's design and evolution over time." };
const sourceB = { id: "page-b", title: "Book p.2", text: "A trade-off analysis weighs the cost of each architectural characteristic against the others." };
const card = (n, sourceId, text) => ({ id: `q${n}`, kind: "flashcard", topic: "Architecture", objective: `Seeded target ${n}`,
  prompt: `Seeded question ${n}: what does the passage establish?`, answer: `Answer ${n}.`, hint: "Think about the scope of the statement.",
  explanation: "The quoted passage states it.", misconception: "Confusing scope.", citations: [{ sourceId, quote: text }] });

async function seeded(t, { drafted = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-fill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", sourceA);
  await service.call("source.add", sourceB);
  const saved = await service.call("draft.save", { deck: { id: "deck-a", title: "第1步 架构思维", course: "Arch", cards: [card(1, sourceA.id, sourceA.text)],
    editorial: { requested: 1, generated: 1, parts: 1, completedParts: 1, failures: [],
      coverage: { selected: 2, cited: 1, sources: [{ id: sourceA.id, title: sourceA.title, planned: 1, accepted: 1 }, { id: sourceB.id, title: sourceB.title, planned: 0, accepted: 0 }],
        uncited: [{ id: sourceB.id, title: sourceB.title }] },
      generation: { sourceIds: [sourceA.id, sourceB.id], kind: "flashcard", language: "English", difficulty: "advanced", focus: "trade-offs", notation: "text", course: "Arch" },
      ...drafted } } });
  return { service, saved };
}
const recorder = (seen) => withQualityStages(async (system, prompt) => {
  if (system.includes("editor")) return JSON.stringify({ issues: [] });
  const request = JSON.parse(prompt.split("REQUEST DATA:\n")[1]);
  seen.push(request);
  return JSON.stringify({ title: "A name the model made up", cards: Array.from({ length: request.count }, (_, i) =>
    card(10 + i, request.sources[0].id, request.sources[0].text)).map((item, i) => ({ ...item, id: `n${i + 1}`, objective: `New target ${i + 1}`, prompt: `New question ${i + 1}?` })) });
});

test("adding from uncovered sources puts the new questions into the same draft, not a new deck", async (t) => {
  const { service, saved } = await seeded(t);
  const seen = [];
  service.complete = recorder(seen);
  const started = await service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion, extraSourceIds: [sourceB.id], count: 2 });
  assert.equal(started.draftId, saved.id);
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, "complete", job.stage);
  const state = await service.call("export");
  assert.equal(state.drafts.length, 1, "no second draft appears");
  assert.equal(state.decks.length, 0, "no new deck appears");
  const draft = state.drafts[0];
  assert.equal(draft.id, saved.id);
  assert.equal(draft.title, "第1步 架构思维", "the model does not rename the deck");
  assert.equal(draft.cards.length, 3, "the deck gained the new cards");
  assert.ok(draft.cards.slice(1).every((added) => added.citations.every((ref) => ref.sourceId === sourceB.id)), "the new cards come from the uncovered source");
  assert.equal(draft.editorial.requested, 3, "the target grew by what was added");
  assert.deepEqual(draft.editorial.coverage.uncited, [], "the source is covered now");
  assert.ok(draft.editorial.generation.sourceIds.includes(sourceB.id) && draft.editorial.generation.sourceIds.includes(sourceA.id));
  assert.ok(seen.length && seen.every((request) => request.sources.every((source) => source.id === sourceB.id)), "the model is shown only the uncovered source");
  assert.ok(seen.every((request) => request.language === "English" && request.difficulty === "advanced" && request.kind === "flashcard" && request.focus === "trade-offs"),
    "kind, language, difficulty and focus are the deck's own");
  assert.ok(seen.every((request) => request.alreadyCovered.some((objective) => objective === "Seeded target 1")), "the deck's existing targets are not repeated");
});

test("a deck that merges into a published deck keeps merging after more questions were added", async (t) => {
  const { service } = await seeded(t);
  await service.store.update((state) => { state.decks.push({ id: "deck-pub", title: "Published", course: "Arch", cards: [], createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z" }); });
  const merging = await service.call("draft.save", { deck: { id: "merge", title: "Pending", course: "Arch", mergeTargetId: "deck-pub", cards: [card(1, sourceA.id, sourceA.text)],
    editorial: { requested: 1, generated: 1, parts: 1, completedParts: 1, failures: [], generation: { sourceIds: [sourceA.id, sourceB.id], kind: "flashcard", language: "中文", mergeTargetId: "deck-pub" } } } });
  service.complete = recorder([]);
  const started = await service.call("generate", { resumeDraftId: merging.id, draftVersion: merging.draftVersion, extraSourceIds: [sourceB.id], count: 1 });
  assert.equal((await settleJob(service, started.jobId)).status, "complete");
  const state = await service.call("export");
  const draft = state.drafts.find((item) => item.id === "merge");
  assert.equal(draft.cards.length, 2);
  assert.equal(draft.mergeTargetId, "deck-pub", "the pending questions still merge into the published deck on publish");
  assert.equal(state.decks.length, 1);
});

test("adding from sources is refused without a draft, a count, a known source, or while the deck is busy", async (t) => {
  const { service, saved } = await seeded(t);
  service.complete = recorder([]);
  await assert.rejects(service.call("generate", { extraSourceIds: [sourceB.id], count: 2, sourceIds: [sourceB.id] }), /目标|draft|草稿/i);
  await assert.rejects(service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion, extraSourceIds: [sourceB.id] }), /题数|count|1–30/i);
  await assert.rejects(service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion, extraSourceIds: ["missing"], count: 1 }), /资料|source/i);
  await assert.rejects(service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion, extraSourceIds: [], count: 1 }), /资料|source/i);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const model = recorder([]);
  service.complete = async (system, prompt, context) => { await gate; return model(system, prompt, context); };
  const first = await service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion, extraSourceIds: [sourceB.id], count: 1 });
  await assert.rejects(service.call("generate", { resumeDraftId: saved.id, draftVersion: saved.draftVersion, extraSourceIds: [sourceB.id], count: 1 }), /正在生成|already|running/i);
  release();
  assert.equal((await settleJob(service, first.jobId)).status, "complete");
});

test("the estimate before adding from sources prices the asked number from those sources alone", () => {
  const long = (n) => `Section ${n}. ${"Architecture includes the principles guiding a system's design and evolution. ".repeat(40)}`;
  const state = { sources: [{ id: "a", title: "A", text: long(1) }, { id: "b", title: "B", text: long(2) }], decks: [], courses: [], settings: {}, attempts: [], runs: [],
    drafts: [{ id: "d", title: "T", cards: [{ id: "c", kind: "flashcard", objective: "x" }], editorial: { requested: 1, parts: 1, completedParts: 1,
      generation: { sourceIds: ["a", "b"], kind: "flashcard", language: "English" } } }] };
  const five = estimateFromState("generate", { resumeDraftId: "d", extraSourceIds: ["b"], count: 5 }, state, {});
  const one = estimateFromState("generate", { resumeDraftId: "d", extraSourceIds: ["b"], count: 1 }, state, {});
  assert.ok(five.calls.low >= 4, "evidence, concrete answers, author and review");
  const author = (estimate) => estimate.stages.find((stage) => stage.id === "author");
  assert.ok(author(five).outputTokens.high > author(one).outputTokens.high, "five questions are written, not one");
  assert.equal(estimateFromState("generate", { resumeDraftId: "d", extraSourceIds: ["b"] }, state, {}).calls.high, 0, "no count, nothing to price");
});

test("the default number of added questions follows the deck's own density and stays inside the limits", () => {
  const draft = (cards, covered) => ({ cards: Array.from({ length: cards }, (_, i) => ({ id: `c${i}` })),
    editorial: { coverage: { sources: Array.from({ length: covered }, (_, i) => ({ id: `s${i}`, accepted: 1 })) } } });
  assert.equal(extraQuestionDefault(draft(25, 25), 15), 15, "one question per covered page, as the deck was written");
  assert.equal(extraQuestionDefault(draft(10, 10), 100), 30, "never above the 30-question limit");
  assert.equal(extraQuestionDefault(draft(1, 10), 4), 2, "a thin deck still asks for a useful minimum");
  assert.equal(extraQuestionDefault({ cards: [], editorial: {} }, 3), 3);
  assert.equal(extraQuestionDefault(draft(5, 5), 0), 0, "nothing uncovered, nothing to add");
});
