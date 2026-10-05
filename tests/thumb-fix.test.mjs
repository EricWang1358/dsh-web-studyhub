import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StudyService } from "../lib/service.js";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { loadUi } from "./helpers/ui-module.mjs";
import { until } from "./helpers/wait.mjs";

// #176: a 👎 with rewrite tags no longer starts a silent coach rewrite; the review page opens the one 修题 box instead.
const quote = "The Caretaker manages snapshot history without inspecting snapshot contents.";
const quiz = (n) => ({
  id: `q${n}`, kind: "quiz", topic: "Memento", objective: `objective ${n}`, prompt: `Question ${n}?`, answer: "Caretaker",
  hint: "Who keeps the history?", explanation: "The Caretaker keeps history.", misconception: "Treating the Memento as the manager.",
  citations: [{ sourceId: "src", quote }],
  options: [
    { id: "a", text: "Caretaker", correct: true, explanation: "It manages history." },
    { id: "b", text: "Memento", correct: false, explanation: "It is the snapshot." },
    { id: "c", text: "Originator", correct: false, explanation: "It restores state." },
  ],
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-thumb-fix-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const log = [];
  const light = createFakeModel({ log });
  const service = new StudyService(root, { complete: light, completeLight: light, coach: true });
  await service.call("source.add", { id: "src", title: "Memento notes", text: quote });
  await service.call("draft.save", { deck: { id: "d", title: "Patterns", cards: [1, 2, 3].map(quiz) } });
  await new StudyService(root).call("draft.publish", { id: "d" });
  return { service, log };
}
const rewriteTasks = async (service) => (await service.call("coach.status")).tasks.filter((task) => task.kind === "rewrite");
const rewriteCalls = (log) => log.filter((entry) => entry.prompt.includes("反馈标签")).length;

test("rewriteVia assist records rewrite tags but starts no coach rewrite", async (t) => {
  const { service, log } = await setup(t);
  const run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  const result = await service.call("coach.feedback", { deckId: "d", cardId: run.card.id, vote: "down", rewriteVia: "assist", tags: ["stem-vague", "source-recall"] });
  assert.deepEqual(result.tags, ["stem-vague", "source-recall"], "the tags are still recorded");
  assert.deepEqual(result.scheduled, []);
  assert.deepEqual(result.fix, ["stem-vague", "source-recall"], "the response names the tags the 修题 box should take over");
  await service.call("coach.prepare");
  assert.deepEqual(await rewriteTasks(service), [], "no rewrite task exists");
  assert.equal(rewriteCalls(log), 0, "the model was never asked to rewrite");
  const state = await service.call("export");
  assert.equal(state.feedback.length, 1);
  assert.deepEqual(state.feedback[0].tags, ["stem-vague", "source-recall"]);
});

test("rewriteVia assist keeps difficulty tags preparing tailored variants", async (t) => {
  const { service } = await setup(t);
  await service.call("coach.consent", { prep: true });
  const run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  const result = await service.call("coach.feedback", { deckId: "d", cardId: run.card.id, vote: "down", rewriteVia: "assist", tags: ["too-hard", "bad-options"] });
  assert.deepEqual(result.scheduled, ["prep"]);
  assert.deepEqual(result.fix, ["bad-options"]);
  assert.deepEqual(await rewriteTasks(service), []);
  const prepared = await service.call("coach.prepare");
  assert.ok(prepared.tasks.some((task) => task.kind === "prep"), "the variant batch ran");
});

test("a client without the flag keeps the background rewrite, started at once", async (t) => {
  const { service } = await setup(t);
  const run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  const result = await service.call("coach.feedback", { deckId: "d", cardId: run.card.id, vote: "down", tags: ["bad-options"] });
  assert.deepEqual(result.scheduled, ["rewrite"]);
  assert.equal(result.fix, undefined);
  assert.equal((await rewriteTasks(service)).length, 1, "the rewrite task exists as soon as the call returns");
  // The rewrite keeps writing into the library after the call returns; let it end before the folder is removed.
  await until(async () => (await rewriteTasks(service)).every((task) => task.status !== "running"), "the background rewrite to end");
});

const { fixSuggestionFor, REWRITE_TAG_IDS, DIFFICULTY_TAG_IDS, splitFeedbackTags } = await loadUi("export * from './ui/card-fix.js';");
const { IMPROVE_SUGGESTIONS } = await loadUi("export * from './ui/agent-prompts/card.js';");

test("fixSuggestionFor turns rewrite tags into the 修题 text, reusing the suggestion wording", () => {
  assert.equal(fixSuggestionFor(["source-recall"]), IMPROVE_SUGGESTIONS[0][1]);
  assert.equal(fixSuggestionFor(["wrong-answer"]), IMPROVE_SUGGESTIONS[1][1]);
  assert.equal(fixSuggestionFor(["stem-vague"]), IMPROVE_SUGGESTIONS[2][1]);
  assert.equal(fixSuggestionFor(["general-quality"]), IMPROVE_SUGGESTIONS[4][1]);
  assert.match(fixSuggestionFor(["bad-options"]), /干扰项/);
  assert.match(fixSuggestionFor(["unclear-explanation"]), /解析/);
  const several = fixSuggestionFor(["stem-vague", "bad-options", "stem-vague"]);
  assert.ok(several.includes(IMPROVE_SUGGESTIONS[2][1]) && /干扰项/.test(several), "several tags make one text");
  assert.equal(several.split(IMPROVE_SUGGESTIONS[2][1]).length, 2, "a tag is not repeated");
  assert.ok(several.length <= 1000, "fits the 修题 box");
  assert.equal(fixSuggestionFor(["too-easy", "too-hard", "nonsense"]), "", "difficulty tags have no 修题 text");
  assert.equal(fixSuggestionFor([]), "");
});

test("the tag sets match the server's rewrite set", async () => {
  const { REWRITE_TAGS } = await import("../lib/coach.js");
  assert.deepEqual([...REWRITE_TAG_IDS].sort(), [...REWRITE_TAGS].sort());
  assert.deepEqual([...DIFFICULTY_TAG_IDS].sort(), ["too-easy", "too-hard"]);
  assert.deepEqual(splitFeedbackTags(["too-hard", "bad-options", "x"]), { fix: ["bad-options"], difficulty: ["too-hard"] });
});

const { default: ThumbFeedback } = await loadUi("export { default } from './ui/ThumbFeedback.jsx';");
const markup = (vote) => renderToStaticMarkup(React.createElement(ThumbFeedback, {
  run: { id: "r", deckId: "d", card: { id: "c", prompt: "Why?" }, ...(vote ? { vote } : {}) },
  call: async () => ({}), canShortcut: () => true }));

test("the 👎 control never carries aria-pressed together with aria-expanded", () => {
  for (const vote of [undefined, { vote: "down", tags: [] }, { vote: "up", tags: [] }]) {
    const html = markup(vote);
    const down = html.match(/<button[^>]*aria-label="这题有问题"[^>]*>/)[0];
    assert.doesNotMatch(down, /aria-pressed/, "the tag panel trigger is an expander only");
    assert.match(down, /aria-expanded="false"/);
    const up = html.match(/<button[^>]*aria-label="这题不错"[^>]*>/)[0];
    assert.match(up, /aria-pressed/);
    assert.doesNotMatch(up, /aria-expanded/);
  }
  assert.match(markup({ vote: "down", tags: [] }), /已标记这题有问题/, "the vote is conveyed as text next to the control");
  assert.match(markup({ vote: "down", tags: [] }), /data-vote="on"/, "and as a styled state (ui/thumb-feedback.css)");
  assert.doesNotMatch(markup(undefined), /data-vote|已标记/);
});

const { feedbackOutcome } = await loadUi("export * from './ui/card-fix.js';");

test("a bare 👎 only records: no 修题, just the short note", () => {
  const bare = feedbackOutcome({ tags: ["general-quality"] }, { tags: ["general-quality"], scheduled: [], fix: ["general-quality"] }, { implicit: true });
  assert.deepEqual(bare, { fix: [], note: "已记下这个反馈" });
});

test("explicitly picked rewrite tags open 修题; difficulty tags get the prep note", () => {
  assert.deepEqual(feedbackOutcome({ tags: ["stem-vague"] }, { tags: ["stem-vague"], scheduled: [] }), { fix: ["stem-vague"], note: "" });
  assert.deepEqual(feedbackOutcome({ tags: ["too-hard"] }, { tags: ["too-hard"], scheduled: ["prep"] }), { fix: [], note: "已记下，下一轮据此准备定制题" });
  assert.deepEqual(feedbackOutcome({ tags: ["too-hard"] }, { tags: ["too-hard"], scheduled: [] }), { fix: [], note: "已记下这个反馈" });
  assert.deepEqual(feedbackOutcome({ tags: ["too-hard", "bad-options"] }, { tags: ["too-hard", "bad-options"], scheduled: ["prep"] }),
    { fix: ["bad-options"], note: "已记下，下一轮据此准备定制题" });
  assert.deepEqual(feedbackOutcome({ tags: ["general-quality"] }, { tags: ["general-quality"] }), { fix: ["general-quality"], note: "" }, "an explicit general-quality pick counts");
});

test("the bare 👎 fallback is recorded without a rewrite on the server", async (t) => {
  const { service, log } = await setup(t);
  const run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  const result = await service.call("coach.feedback", { deckId: "d", cardId: run.card.id, vote: "down", rewriteVia: "assist", tags: ["general-quality"] });
  assert.deepEqual(result.tags, ["general-quality"]);
  assert.deepEqual(result.scheduled, []);
  await service.call("coach.prepare");
  assert.deepEqual(await rewriteTasks(service), []);
  assert.equal(rewriteCalls(log), 0);
});
