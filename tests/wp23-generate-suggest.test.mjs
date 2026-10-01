/* WP23 · generate.suggest: the 帮我想想 assist on the 创建题组 form.
   It sends only compact signals (source titles and headings, the course exam
   profile, the learner's weak topics and goal) to the light model and returns
   validated, clipped focus suggestions. Without a model, or when the model
   fails, the same action answers from local data and never throws. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import {
  outlineOf, sourceOutlines, buildSuggestPrompt, normalizeSuggestion, localSuggestion, weakTopicsFor, SUGGEST_LIMITS,
} from "../lib/contexts/generation/suggest.js";

const BODY = "This body sentence must never be sent to the model because only titles and headings are allowed here.";
const notes = [
  "# Distributed systems",
  BODY,
  "## Consensus and Raft",
  BODY,
  "1.2 Replication strategies",
  BODY,
  "第三章 一致性模型",
  BODY,
].join("\n");

async function library(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "study-wp23-"));
  const service = new StudyService(root, options);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const a = await service.call("source.add", { title: "Distributed notes", text: notes, courses: ["SWE5001"] });
  const b = await service.call("source.add", { title: "Cloud storage", text: "# Object storage\n" + BODY, courses: ["SWE5001"] });
  await service.call("course.save", { name: "SWE5001", exam: { format: "open-book-case", totalMarks: 60, sections: [{ title: "Case study", marks: 40, topics: ["Trade-offs"] }] } });
  await service.store.update((s) => {
    const card = (id, topic) => ({ id, kind: "flashcard", topic, prompt: `${id}?`, answer: "a" });
    s.decks.push({ id: "d1", title: "Deck", course: "SWE5001", cards: [card("c1", "Raft elections"), card("c2", "Raft elections"), card("c3", "Sharding"), card("c4", "Caching")] },
      { id: "d2", title: "Other course", course: "OTHER", cards: [card("o1", "Unrelated weak topic")] });
    for (const [deckId, quiz_id, grade] of [["d1", "c1", 1], ["d1", "c2", 2], ["d1", "c3", 1], ["d1", "c4", 5], ["d2", "o1", 1]])
      s.attempts.push({ deckId, quiz_id, assessment: "self", grade, timestamp: new Date().toISOString() });
  });
  return { service, ids: [a.id, b.id] };
}

const reply = (value) => async () => typeof value === "string" ? value : JSON.stringify(value);

test("outlineOf keeps only headings: markdown, numbered and chapter lines, never body text", () => {
  const headings = outlineOf(notes);
  assert.deepEqual(headings, ["Distributed systems", "Consensus and Raft", "1.2 Replication strategies", "第三章 一致性模型"]);
  assert.ok(headings.every((line) => !line.includes("body sentence")));
  assert.deepEqual(outlineOf("plain prose without any structure at all. " + BODY), []);
  assert.equal(outlineOf(Array.from({ length: 80 }, (_, i) => `## Heading ${i}`).join("\n")).length, SUGGEST_LIMITS.headingsPerSource);
});

test("sourceOutlines groups PDF pages into one document and caps the total size", () => {
  const pages = [1, 2, 3].map((page) => ({ id: `p${page}`, title: `slides.pdf · p.${page}`, text: `## Topic ${page}\n${BODY}`,
    document: { id: "h".repeat(64), format: "pdf", page, filename: "slides.pdf" } }));
  const outlines = sourceOutlines(pages);
  assert.equal(outlines.length, 1);
  assert.equal(outlines[0].title, "slides.pdf");
  assert.deepEqual(outlines[0].headings, ["Topic 1", "Topic 2", "Topic 3"]);
  const many = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, title: `Material ${i} ${"x".repeat(40)}`, text: Array.from({ length: 20 }, (_, j) => `## ${"heading ".repeat(6)}${j}`).join("\n") }));
  const capped = sourceOutlines(many);
  assert.ok(JSON.stringify(capped).length <= SUGGEST_LIMITS.outlineChars + 200, "outline payload stays near the cap");
});

test("the prompt carries titles, headings, the exam profile, weak topics and goal, and no source body", async (t) => {
  const prompts = [];
  const { service, ids } = await library(t, { light: async (system, prompt) => { prompts.push({ system, prompt }); return JSON.stringify({ focus: ["Raft vs Paxos"], count: 8, difficulty: "application", why: "Weak on Raft." }); } });
  const result = await service.call("generate.suggest", { sourceIds: ids, course: "SWE5001", goal: "exam" });
  assert.equal(result.source, "model");
  assert.equal(prompts.length, 1, "one light call");
  const { prompt } = prompts[0];
  for (const needle of ["Distributed notes", "Consensus and Raft", "第三章 一致性模型", "Cloud storage", "Object storage", "open-book-case", "Case study", "Trade-offs", "Raft elections", '"goal":"exam"'])
    assert.ok(prompt.includes(needle), `prompt mentions ${needle}`);
  assert.ok(!prompt.includes("body sentence"), "no source text beyond headings");
  assert.ok(!prompt.includes("Unrelated weak topic"), "weak topics of other courses are not sent");
  assert.ok(prompt.length < 6500, `compact prompt (${prompt.length})`);
  assert.match(prompts[0].system, /JSON/);
  assert.match(prompts[0].system, /untrusted/i, "headings are evidence, not instructions");
});

test("weakTopicsFor ranks the course's weak topics and ignores other courses", async (t) => {
  const { service } = await library(t);
  const state = await service.store.read();
  const topics = weakTopicsFor(state, "SWE5001");
  assert.deepEqual(topics.map((item) => item.topic), ["Raft elections", "Sharding"]);
  assert.equal(topics[0].weak, 2);
  assert.deepEqual(weakTopicsFor(state, "OTHER").map((item) => item.topic), ["Unrelated weak topic"]);
  assert.deepEqual(weakTopicsFor(state, "Nothing"), []);
});

test("normalizeSuggestion validates, clips and drops what the schema forbids", () => {
  const value = normalizeSuggestion({
    focus: [" Raft vs Paxos ", "x".repeat(200), "", 42, "Raft vs Paxos", "a", "b", "c", "d"],
    count: 99, difficulty: "nightmare", kind: "essay", why: "w".repeat(500),
  });
  assert.equal(value.focus.length, SUGGEST_LIMITS.focus);
  assert.equal(value.focus[0], "Raft vs Paxos");
  assert.ok(value.focus.every((item) => item.length <= SUGGEST_LIMITS.focusChars));
  assert.equal(new Set(value.focus).size, value.focus.length, "duplicates removed");
  assert.equal(value.count, 30, "count is clamped to 1-30");
  assert.equal(value.difficulty, undefined, "unknown difficulty dropped");
  assert.equal(value.kind, undefined, "unknown kind dropped");
  assert.ok(value.why.length <= SUGGEST_LIMITS.whyChars);
  const good = normalizeSuggestion({ focus: ["A"], count: 12.6, difficulty: "advanced", kind: "mixed" });
  assert.deepEqual([good.count, good.difficulty, good.kind], [13, "advanced", "mixed"]);
  assert.throws(() => normalizeSuggestion({ focus: [] }), /focus/);
  assert.throws(() => normalizeSuggestion("nope"), /focus/);
  assert.equal(normalizeSuggestion({ focus: ["A"], kind: "case" }).kind, undefined);
});

test("a reply wrapped in prose or a code fence still parses", async (t) => {
  const { service, ids } = await library(t, { light: reply('Sure!\n```json\n{"focus":["Replication"],"count":6,"why":"short"}\n```') });
  const result = await service.call("generate.suggest", { sourceIds: ids, course: "SWE5001" });
  assert.equal(result.source, "model");
  assert.deepEqual(result.focus, ["Replication"]);
  assert.equal(result.count, 6);
});

test("without a model the action answers locally from weak topics and headings, without throwing", async (t) => {
  const { service, ids } = await library(t);
  const result = await service.call("generate.suggest", { sourceIds: ids, course: "SWE5001" });
  assert.equal(result.source, "local");
  assert.equal(result.unavailable.reason, "no-model");
  assert.equal(result.focus[0], "Raft elections", "weak topics first");
  assert.ok(result.focus.includes("Consensus and Raft"), "then source headings");
  assert.ok(result.focus.length <= SUGGEST_LIMITS.focus);
  assert.equal(result.count, undefined);
  assert.equal(result.difficulty, undefined);
});

test("a failing or unreadable model falls back to local suggestions and keeps the error for friendly mapping", async (t) => {
  const failing = await library(t, { light: async () => { throw new Error("429 Too Many Requests: rate limit"); } });
  const one = await failing.service.call("generate.suggest", { sourceIds: failing.ids, course: "SWE5001" });
  assert.equal(one.source, "local");
  assert.equal(one.unavailable.reason, "failed");
  assert.match(one.unavailable.message, /rate limit/);
  assert.ok(one.focus.length > 0);
  const garbage = await library(t, { light: reply("I cannot help with that") });
  const two = await garbage.service.call("generate.suggest", { sourceIds: garbage.ids, course: "SWE5001" });
  assert.equal(two.source, "local");
  assert.equal(two.unavailable.reason, "failed");
});

test("the action is read-only and validates its input", async (t) => {
  const { service, ids } = await library(t, { light: reply({ focus: ["A"] }) });
  const before = JSON.stringify(await service.store.read());
  await service.call("generate.suggest", { sourceIds: ids, course: "SWE5001" });
  assert.equal(JSON.stringify(await service.store.read()), before, "no state written");
  await assert.rejects(service.call("generate.suggest", { sourceIds: "nope" }), /sourceIds/);
  const empty = await service.call("generate.suggest", { sourceIds: [], course: "SWE5001" });
  assert.equal(empty.source, "model", "weak topics alone are enough signal");
  const none = await (await library(t, { light: reply({ focus: ["A"] }) })).service.call("generate.suggest", { sourceIds: [], course: "Nothing" });
  assert.equal(none.source, "local", "no sources and no weak topics: nothing worth a model call");
  assert.deepEqual(none.focus, []);
});

test("buildSuggestPrompt is deterministic and carries the requested language", () => {
  const signals = { course: "C", sources: [{ title: "T", headings: ["H"] }], weakTopics: [], goal: "interview" };
  const prompt = buildSuggestPrompt(signals, { language: "en" });
  assert.equal(prompt.prompt, buildSuggestPrompt(signals, { language: "en" }).prompt);
  assert.match(JSON.stringify(JSON.parse(prompt.prompt)), /interview/);
  assert.match(prompt.system, /English/);
  assert.match(buildSuggestPrompt(signals, { language: "zh" }).system, /中文|Chinese/);
});

test("localSuggestion merges weak topics before headings and dedupes", () => {
  const value = localSuggestion({ weakTopics: [{ topic: "A", weak: 3 }, { topic: "B", weak: 1 }], outlines: [{ title: "t", headings: ["B", "C", "D", "E", "F"] }] });
  assert.deepEqual(value.focus, ["A", "B", "C", "D", "E"]);
  assert.equal(value.source, "local");
});

