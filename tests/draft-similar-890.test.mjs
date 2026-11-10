import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StudyService } from "../lib/service.js";
import { writesFor } from "../lib/runtime/domain-contracts.js";
import { assistantRefusal } from "../lib/assistant-boundary.js";
import { libraryContracts, studyToolDescription } from "../lib/study-contracts.js";
import { STEM_PREVIEW_CHARS, similarQuestions, similarQuestionsOf, stemOf } from "../lib/contexts/authoring/similar-questions.js";

/* #890 S1: `draft.similar {id}` says which questions of a draft are near-duplicates (the shared stemSimilarity, lib/stem-similarity.js) of another
   question of the SAME kind, in the draft itself or in the published decks of the draft's course, and where that other question is. It reads only. */

const quiz = (id, prompt) => ({ id, kind: "quiz", topic: "熵", objective: `目标 ${id}`, prompt, answer: "A", options: [], citations: [] });
const cloze = (id, text) => ({ id, kind: "cloze", topic: "熵", objective: `目标 ${id}`, prompt: text, cloze: { text, answers: [] }, answer: "", citations: [] });

const ENTROPY = "请简要解释熵在信息论中的含义";
const ENTROPY_AGAIN = "请简要说明熵在信息论中的含义";
const SCHEDULING = "操作系统为什么需要进程调度";
const SCHEDULING_AGAIN = "操作系统为何需要进程调度";

async function library(t, { drafts = [], decks = [] }) {
  const root = await mkdtemp(join(tmpdir(), "study-similar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update((own) => { own.drafts = drafts; own.decks = decks; });
  return service;
}

test("two rephrased questions of the same kind in one draft flag each other, and say where the other one is", async (t) => {
  const draft = { id: "d1", title: "草稿", course: "信息论", draftVersion: 2, cards: [quiz("a", ENTROPY), quiz("b", SCHEDULING), quiz("c", ENTROPY_AGAIN)] };
  const service = await library(t, { drafts: [draft] });
  const read = await service.call("draft.similar", { id: "d1" });
  assert.equal(read.status, "ok");
  assert.equal(read.draftId, "d1");
  assert.equal(read.draftVersion, 2);
  assert.deepEqual(read.similar.map((item) => [item.cardId, item.n, item.other.where, item.other.cardId, item.other.n]), [["a", 1, "draft", "c", 3], ["c", 3, "draft", "a", 1]]);
  assert.equal(read.similar[0].other.prompt, ENTROPY_AGAIN, "the other question's stem, to read it beside this one");
  assert.ok(read.similar[0].similarity >= 0.72 && read.similar[0].similarity < 1);
});

test("a question like one in a published deck of the same course names that deck and its number there; other courses and archived decks are not compared", async (t) => {
  const draft = { id: "d1", title: "草稿", course: "OS", draftVersion: 1, cards: [quiz("new", SCHEDULING_AGAIN)] };
  const decks = [
    { id: "os", title: "进程管理", course: "OS", cards: [quiz("x1", ENTROPY), quiz("x2", SCHEDULING)] },
    { id: "net", title: "计算机网络", course: "Net", cards: [quiz("y1", SCHEDULING)] },
    { id: "old", title: "旧题组", course: "OS", archived: true, cards: [quiz("z1", SCHEDULING)] },
  ];
  const service = await library(t, { drafts: [draft], decks });
  const read = await service.call("draft.similar", { id: "d1" });
  assert.equal(read.similar.length, 1);
  assert.deepEqual(read.similar[0].other, { where: "deck", deckId: "os", deckTitle: "进程管理", cardId: "x2", n: 2, prompt: SCHEDULING });
});

test("a choice question and a cloze on the same point do not flag each other", async (t) => {
  const draft = { id: "d1", title: "草稿", course: "信息论", draftVersion: 1, cards: [quiz("q", ENTROPY), cloze("c", ENTROPY_AGAIN)] };
  const decks = [{ id: "deck", title: "信息论", course: "信息论", cards: [cloze("old", ENTROPY)] }];
  const service = await library(t, { drafts: [draft], decks });
  const read = await service.call("draft.similar", { id: "d1" });
  assert.deepEqual(read.similar.map((item) => [item.cardId, item.other.cardId]), [["c", "old"]], "the cloze matches the published cloze, never the choice question");
});

test("a question is never similar to itself: not in its own draft, not as the published copy an editing draft was opened from", async (t) => {
  const deck = { id: "deck", title: "信息论", course: "信息论", contentVersion: 1, cards: [quiz("a", ENTROPY), quiz("b", SCHEDULING)] };
  const editing = { id: "d1", title: "信息论", course: "信息论", draftVersion: 1, editingDeckId: "deck", baseVersion: 1, cards: [quiz("a", ENTROPY_AGAIN), quiz("b", SCHEDULING)] };
  const service = await library(t, { drafts: [editing], decks: [deck] });
  assert.deepEqual((await service.call("draft.similar", { id: "d1" })).similar, []);
});

test("draft.similar reads without writing, is declared read only and is described in the cards area for the main chat", async (t) => {
  const draft = { id: "d1", title: "草稿", course: "信息论", draftVersion: 1, cards: [quiz("a", ENTROPY), quiz("c", ENTROPY_AGAIN)] };
  const service = await library(t, { drafts: [draft] });
  const before = JSON.stringify(await service.call("export"));
  await service.call("draft.similar", { id: "d1" });
  assert.equal(JSON.stringify(await service.call("export")), before);
  await assert.rejects(service.call("draft.similar", { id: "missing" }), /Draft/);
  assert.deepEqual(writesFor("authoring", "draft.similar"), []);
  assert.equal(assistantRefusal("draft.similar"), null);
  // Described in the lazily read `cards` area only: the always-on description does not grow with every read (#891).
  assert.match(libraryContracts.cards, /draft\.similar \{id\} reads which questions of a draft resemble another/);
  assert.doesNotMatch(studyToolDescription, /draft\.similar/);
});

/* The budget of #890: a coverage draft holds up to 500 questions and a course a few thousand. Comparing every pair took 10.6 s for 500 x 3 000
   (measured on the issue). The target is under 300 ms on a developer machine; the limit here is loose so a busy CI runner does not fail it. */
test("a 500-question draft against 3 000 published questions of the course is checked well inside the budget", (t) => {
  let seed = 20261110;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const vocabulary = Array.from({ length: 1200 }, (_, index) => String.fromCodePoint(0x4e00 + ((index * 7919) % 20000)));
  const words = (count) => Array.from({ length: count }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join("");
  const frames = [["关于", "，下列说法正确的是"], ["请解释", "的含义"], ["", "的主要作用是什么？"], ["下列哪一项最准确地描述了", ""]];
  const stem = () => { const [head, tail] = frames[Math.floor(random() * frames.length)]; return `${head}${words(45 - head.length - tail.length)}${tail}`; };
  const kinds = ["quiz", "quiz", "multi", "cloze", "open"];
  const card = (id) => ({ id, kind: kinds[Math.floor(random() * kinds.length)], prompt: stem(), answer: "", options: [], citations: [] });
  const decks = Array.from({ length: 10 }, (_, d) => ({ id: `deck${d}`, title: `题组 ${d}`, course: "OS", cards: Array.from({ length: 300 }, (_, i) => card(`p${d}-${i}`)) }));
  const draftCards = Array.from({ length: 500 }, (_, i) => card(`n${i}`));
  // Some of the new questions are a published one with one character changed: the check must still find them.
  for (let i = 0; i < 50; i += 1) { const old = decks[i % 10].cards[i]; draftCards[i * 10] = { ...old, id: `n${i * 10}`, prompt: `${old.prompt.slice(0, 20)}乙${old.prompt.slice(21)}` }; }
  const state = { drafts: [{ id: "big", title: "覆盖草稿", course: "OS", draftVersion: 1, cards: draftCards }], decks, sources: [], courses: [] };
  const stats = {}, started = performance.now();
  const read = similarQuestions(state, "big", { stats });
  const elapsed = performance.now() - started;
  t.diagnostic(`500 x 3000: ${elapsed.toFixed(1)} ms, ${read.similar.length} flagged, ${stats.compared} exact checks`);
  assert.ok(read.similar.length >= 50, "every planted near-duplicate is found");
  // The index, not the clock, is what keeps this fast: only a small share of the 500 x 3 500 pairs is ever compared exactly.
  assert.ok(stats.compared < (500 * 3500) / 50, `${stats.compared} exact checks`);
  assert.ok(elapsed < 3000, `took ${elapsed.toFixed(0)} ms`);
});

/* A harder corpus: course-like English stems built from a few frames and 40 words of one subject, so almost every stem shares many bigrams with almost
   every other one (like the corpus of the review of #909, which took 1.1-1.6 s before the position filter). Its own budget: under 1 s on a developer
   machine (docs/performance.md), about 2 s while a full parallel test run shares it; the limit here (10 s) is loose for a busy CI runner,
   and the count of exact comparisons is what guards the index. */
test("500 course-like English questions against 3 000 of a small vocabulary stay under their own budget", (t) => {
  let seed = 7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const words = ["process", "thread", "scheduler", "deadlock", "semaphore", "mutex", "page", "replacement", "virtual", "memory", "cache", "interrupt", "system", "call",
    "file", "disk", "allocation", "segment", "critical", "section", "priority", "quantum", "context", "switch", "kernel", "user", "mode", "address", "space", "fault",
    "working", "set", "producer", "consumer", "reader", "writer", "starvation", "preemption", "response", "time"];
  const frames = [["Which statement about ", " is correct?"], ["Explain the role of ", " in an operating system."], ["What is the main purpose of ", "?"],
    ["Which of the following best describes ", "?"], ["Why does ", " cause problems?"]];
  const stem = () => { const [head, tail] = pick(frames); return `${head}${Array.from({ length: 3 + Math.floor(random() * 4) }, () => pick(words)).join(" ")}${tail}`; };
  const decks = Array.from({ length: 10 }, (_, d) => ({ id: `deck${d}`, title: `Deck ${d}`, course: "OS", cards: Array.from({ length: 300 }, (_, i) => quiz(`p${d}-${i}`, stem())) }));
  const draftCards = Array.from({ length: 500 }, (_, i) => quiz(`n${i}`, i % 10 ? stem() : `x${decks[i % 10].cards[i % 300].prompt}`));
  const state = { drafts: [{ id: "big", title: "Coverage draft", course: "OS", draftVersion: 1, cards: draftCards }], decks, sources: [], courses: [] };
  const stats = {}, started = performance.now();
  const read = similarQuestions(state, "big", { stats });
  const elapsed = performance.now() - started;
  t.diagnostic(`small vocabulary, 500 x 3000: ${elapsed.toFixed(1)} ms, ${read.similar.length} flagged, ${stats.compared} exact checks of ${500 * 3500} pairs`);
  assert.ok(draftCards.every((card, i) => i % 10 || read.similar.some((item) => item.cardId === card.id)), "every planted near-duplicate is found");
  assert.ok(stats.compared < (500 * 3500) / 3, `${stats.compared} exact checks`);
  assert.ok(elapsed < 10000, `took ${elapsed.toFixed(0)} ms`);
});

const IMAGE = `![图 1](data:image/png;base64,${"iVBORw0KGgo".repeat(4000)})`;

test("an embedded image is its alt text: two questions that share only a picture are not alike, and no answer carries image bytes", async (t) => {
  const draft = { id: "d1", title: "草稿", course: "信息论", draftVersion: 1, cards: [quiz("a", `${IMAGE}\n图中电路的输出是什么？`), quiz("b", `${IMAGE}\n这条曲线说明了什么规律？`), quiz("c", `${ENTROPY}${IMAGE}`)] };
  const decks = [{ id: "deck", title: "信息论", course: "信息论", cards: [quiz("old", `${ENTROPY_AGAIN}\n${IMAGE}`)] }];
  const service = await library(t, { drafts: [draft], decks });
  const read = await service.call("draft.similar", { id: "d1" });
  assert.deepEqual(read.similar.map((item) => [item.cardId, item.other.cardId]), [["c", "old"]], "a and b share a 44 000-character picture and nothing else");
  assert.doesNotMatch(JSON.stringify(read), /data:/);
  assert.match(read.similar[0].other.prompt, /\[图 1\]/);
});

test("the answer stays small: the other question's stem is cut at a fixed length however long the stems are", () => {
  const long = (n) => `第${n}组：${"关于信息熵与编码长度之间关系的一段很长的叙述，".repeat(80)}${IMAGE}`;
  const decks = [{ id: "deck", title: "信息论", course: "信息论", cards: Array.from({ length: 60 }, (_, i) => quiz(`old${i}`, long(i))) }];
  const draft = { id: "d1", title: "草稿", course: "信息论", draftVersion: 1, cards: Array.from({ length: 60 }, (_, i) => quiz(`new${i}`, `${long(i)}。`)) };
  const read = similarQuestions({ drafts: [draft], decks, sources: [], courses: [] }, "d1");
  assert.equal(read.similar.length, 60);
  assert.ok(read.similar.every((item) => item.other.prompt.length <= STEM_PREVIEW_CHARS));
  const size = JSON.stringify(read).length;
  // 60 flagged questions with 2 000-character stems and a picture each: at most STEM_PREVIEW_CHARS + 200 characters per flagged question.
  assert.ok(size < 60 * (STEM_PREVIEW_CHARS + 200), `${size} characters`);
});

test("a cloze is compared without its {{id}} markers: the same sentence with other blank ids is the same question", () => {
  assert.equal(stemOf(cloze("c", "熵是{{b1}}的度量，单位是{{b2}}")), "熵是＿＿的度量，单位是＿＿");
  const draft = { id: "d1", title: "草稿", course: "信息论", draftVersion: 1, cards: [cloze("c", "信息熵是{{answer_first_blank}}的度量")] };
  const decks = [{ id: "deck", title: "信息论", course: "信息论", cards: [cloze("old", "信息熵是{{x}}的度量")] }];
  const read = similarQuestions({ drafts: [draft], decks, sources: [], courses: [] }, "d1");
  assert.deepEqual(read.similar.map((item) => [item.cardId, item.similarity, item.other.prompt]), [["c", 1, "信息熵是＿＿的度量"]]);
});

test("asked again while nothing it reads has changed, the answer is the last one; a changed deck or a new draft version computes again", () => {
  const draft = { id: "memo", title: "草稿", course: "信息论", draftVersion: 1, cards: [quiz("a", ENTROPY), quiz("b", ENTROPY_AGAIN)] };
  const state = { drafts: [draft], decks: [], sources: [], courses: [] };
  const first = {}, again = {}, moved = {}, edited = {};
  const answer = similarQuestionsOf(state, "memo", { stats: first });
  assert.equal(answer.similar.length, 2);
  assert.ok(first.compared > 0);
  // The draft page asks on every commit (a running job's progress); the same frozen records give the same answer, without a search.
  assert.deepEqual(similarQuestionsOf({ ...state, jobs: ["tick"] }, "memo", { stats: again }), answer);
  assert.deepEqual(again, {}, "no search the second time");
  similarQuestionsOf({ ...state, decks: [{ id: "deck", title: "信息论", course: "信息论", cards: [] }] }, "memo", { stats: moved });
  assert.ok(moved.compared > 0, "a changed deck collection is searched again");
  const next = { ...draft, draftVersion: 2, cards: [quiz("a", ENTROPY), quiz("b", SCHEDULING)] };
  assert.deepEqual(similarQuestionsOf({ ...state, drafts: [next] }, "memo", { stats: edited }).similar, []);
  assert.ok("candidates" in edited, "a new draft version is searched again");
});

test("only the last answer is kept: asking about another draft forgets the first one and the library it was computed from (#845)", () => {
  const one = { id: "one", title: "草稿", course: "信息论", draftVersion: 1, cards: [quiz("a", ENTROPY), quiz("b", ENTROPY_AGAIN)] };
  const two = { id: "two", title: "草稿", course: "信息论", draftVersion: 1, cards: [quiz("c", SCHEDULING), quiz("d", SCHEDULING_AGAIN)] };
  const state = { drafts: [one, two], decks: [], sources: [], courses: [] };
  const first = {}, other = {}, again = {}, same = {};
  similarQuestionsOf(state, "one", { stats: first });
  similarQuestionsOf(state, "two", { stats: other });
  similarQuestionsOf(state, "one", { stats: again });
  assert.ok(first.compared > 0 && other.compared > 0);
  assert.ok(again.compared > 0, "the first draft's answer was not kept once another draft was asked about");
  similarQuestionsOf(state, "one", { stats: same });
  assert.deepEqual(same, {}, "the latest one is");
});
