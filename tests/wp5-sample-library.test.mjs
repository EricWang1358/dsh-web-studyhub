/* WP5 · sample library (plan §3 D4, §4 C6): `sample.status | sample.load
   {language} | sample.remove` through the real host handler (lib/host.js, via
   the preview server), loading through real operations and removing exactly
   the sample records. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { createPreviewServer } from "../scripts/preview-server.mjs";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { Store } from "../lib/store.js";
import { validateDeck, quoteFound } from "../lib/domain.js";
import { visibleHtmlText } from "../lib/contexts/materials/files.js";
import en from "../lib/sample/en.js";
import zh from "../lib/sample/zh.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const savedHome = process.env.DSH_HOME;
test.after(() => { if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome; });
const han = /[㐀-鿿]/;

async function tempDir(t, prefix) {
  const base = join(repo, "output", "test-wp5");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function start(t, model = createFakeModel({ latencyMs: 0 })) {
  const libraryRoot = await tempDir(t, "lib-"), home = await tempDir(t, "home-");
  const server = await createPreviewServer({ libraryRoot, home, port: 0, model });
  t.after(() => server.close());
  const call = async (action, args = {}) => {
    const res = await fetch(server.url + "/api/call", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Token": server.token },
      body: JSON.stringify({ action, args }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return body.value;
  };
  return { call, libraryRoot };
}

/** The whole committed library, minus bookkeeping that every write changes. */
async function libraryState(root) {
  const state = structuredClone(await new Store(root).read());
  delete state.revision;
  delete state.sampleLibrary;
  return state;
}

const exists = (path) => access(path).then(() => true, () => false);
const markdownText = (markdown) => visibleHtmlText(new MarkdownIt({ html: false, breaks: false }).render(markdown));

/** A learner's own library: a pasted source, an imported Markdown original, a published deck, an answer and a note. */
async function userContent(call) {
  const text = "A graph is a set of vertices joined by edges. Breadth-first search visits vertices level by level, using a queue.";
  const pasted = await call("source.add", { title: "My graph notes", text, courses: ["CS1010"] });
  const imported = await call("materials.document.import", { dataBase64: Buffer.from("# Trees\n\nA tree is a connected graph without cycles. Every tree with n vertices has n - 1 edges.\n").toString("base64"),
    filename: "trees.md", format: "md", title: "Trees", courses: ["CS1010"] });
  const card = (id, prompt, answer, sourceId, quote) => ({ id, kind: "flashcard", topic: "Graphs", objective: prompt, prompt, answer,
    hint: "Think about the definition.", explanation: `${quote} That is the deciding fact.`, misconception: "Confusing graphs with trees.", citations: [{ sourceId, quote }] });
  const saved = await call("draft.save", { deck: { id: "user-graphs", title: "Graph basics", course: "CS1010", cards: [
    card("user-bfs", "How does breadth-first search visit vertices?", "Level by level, using a queue.", pasted.id, "Breadth-first search visits vertices level by level, using a queue."),
    card("user-tree", "How many edges does a tree with n vertices have?", "n - 1 edges.", imported.sourceIds[0], "Every tree with n vertices has n - 1 edges."),
  ] } });
  await call("draft.publish", { id: "user-graphs", draftVersion: saved.draftVersion });
  const run = await call("review.start", { mode: "path", scope: [{ deckId: "user-graphs" }], fresh: true });
  await call("review.reveal", { runId: run.id, cardId: run.card.id });
  await call("review.answer", { runId: run.id, cardId: run.card.id, grade: 4 });
  await call("note.create", { title: "My BFS note", cards: [{ deckId: "user-graphs", cardId: "user-bfs" }] });
  return { pasted, imported };
}

test("both sample editions carry the same cards, and every quote is in the rendered lecture", () => {
  for (const content of [en, zh]) {
    const text = markdownText(content.document.markdown);
    for (const card of [...content.deck.cards, ...content.draft.cards])
      assert.ok(quoteFound(text, card.quote), `${content.language} ${card.key}: quote not in the lecture: ${card.quote}`);
    const sources = [{ id: "lecture", text }];
    const cards = (list) => list.map(({ key, quote, ...card }) => ({ ...card, id: key, citations: [{ sourceId: "lecture", quote }] }));
    // No errors and no quality notices: the sample shows what a clean deck looks like.
    assert.deepEqual(validateDeck({ title: content.deck.title, cards: cards(content.deck.cards) }, sources), { errors: [], warnings: [] }, content.language);
    assert.deepEqual(validateDeck({ title: content.draft.title, cards: cards(content.draft.cards) }, sources), { errors: [], warnings: [] }, content.language);
  }
  const shape = (content) => content.deck.cards.map((card) => [card.key, card.kind, card.topic === "Memento" || card.topic === "Bridge" ? card.topic : "",
    (card.options || []).map((item) => `${item.id}:${item.correct}`).join(",")]);
  assert.deepEqual(shape(zh), shape(en));
  assert.deepEqual(zh.weak, en.weak);
  assert.deepEqual(zh.prerequisites, en.prerequisites);
  assert.match(zh.course, /示例/);
  assert.match(en.course, /^Sample/);
  for (const value of JSON.stringify(en).match(/"(?:[^"\\]|\\.)*"/g)) assert.doesNotMatch(value, han, `English sample contains Chinese: ${value}`);
});

test("sample.load builds a realistic sample course through real operations", async (t) => {
  const { call, libraryRoot } = await start(t);
  assert.equal((await call("sample.status")).loaded, false);
  const status = await call("sample.load", { language: "zh" });
  assert.equal(status.loaded, true);
  assert.equal(status.language, "zh");
  assert.equal(status.course, "示例课程 · 设计模式");

  const snapshot = await call("snapshot", { uiLanguage: "zh" });
  assert.equal(snapshot.sample?.loaded, true, "the snapshot says sample data is present");
  const deck = snapshot.decks.find((item) => item.id.startsWith("sample-"));
  assert.ok(deck, "a published sample deck");
  assert.match(deck.title, /示例/);
  assert.equal(deck.course, "示例课程 · 设计模式");
  assert.equal(deck.count, zh.deck.cards.length);
  const source = snapshot.sources.find((item) => item.sample === true);
  assert.ok(source, "the sample lecture is a source tagged sample");
  assert.match(source.title, /示例/);
  assert.equal(snapshot.drafts.filter((draft) => draft.sample === true).length, 1, "one pending sample draft");
  assert.ok(snapshot.notes.filter((note) => note.sample === true).length >= 2, "two sample notes");
  assert.ok(snapshot.skeletons.length >= 1, "a knowledge skeleton");
  assert.ok(snapshot.inbox.items.filter((item) => item.deckId === deck.id).length >= 2, "a couple of inbox letters");

  // The lecture is a real Markdown original: viewer, passages and question links work.
  const listed = await call("materials.document.list", {});
  const lecture = listed.documents.find((item) => item.sourceIds?.includes(source.id));
  assert.ok(lecture?.originalAvailable, "the original Markdown is retained");
  assert.equal(lecture.format, "md");
  const links = await call("materials.links.list", { documentId: lecture.documentId || lecture.id });
  assert.ok(links.links.length >= zh.deck.cards.length, "every sample question links back to its passage");
  assert.ok(links.links.every((link) => link.status === "resolved"));

  // About three weeks of practice: real stats and two weak cards.
  const state = await new Store(libraryRoot).read();
  const attempts = state.attempts.filter((attempt) => attempt.deckId === deck.id);
  assert.ok(attempts.length >= 30, `history attempts: ${attempts.length}`);
  const days = new Set(attempts.map((attempt) => attempt.timestamp.slice(0, 10)));
  assert.ok(days.size >= 14, `distinct practice days: ${days.size}`);
  const wrong = await call("wrongbook", {});
  const weak = wrong.items.filter((item) => item.deckId === deck.id).map((item) => item.cardId).sort();
  assert.deepEqual(weak, zh.weak.map((key) => `sample-${key}`).sort());
  const stats = await call("stats", {});
  assert.ok(stats.heatmap.filter((day) => day.count > 0).length >= 14, "about three weeks on the heatmap");
  assert.ok(snapshot.progress[deck.id].counts.new >= 2, "untouched cards stay new for the home plan");
  assert.ok(snapshot.today.due >= 1 && snapshot.today.weak >= 2, "today's plan has reviews and weak cards");
  assert.ok(stats.totals.streak >= 2 && stats.totals.streak < 21, `a believable streak with rest days: ${stats.totals.streak}`);
  // The tour's practice round opens on a choice question.
  assert.ok(status.practice.length >= 3);
  const round = await call("review.start", { mode: "path", scope: status.practice, fresh: true });
  assert.equal(round.card.kind, "quiz");

  // A learning-flow session paused at its prepared lesson.
  const session = state.workflowSessions.find((item) => item.sample === true);
  assert.ok(session, "a sample learning-flow session");
  const lesson = session.template.steps.find((step) => step.kind === "lesson");
  assert.equal(session.currentStepId, lesson.id);
  assert.match(session.records[lesson.id].content, /Memento/);
});

test("the English sample is English and loading twice changes nothing", async (t) => {
  const { call, libraryRoot } = await start(t);
  await call("sample.load", { language: "en" });
  const first = await libraryState(libraryRoot);
  const again = await call("sample.load", { language: "en" });
  assert.equal(again.loaded, true);
  assert.deepEqual(await libraryState(libraryRoot), first, "a second load is idempotent");
  const snapshot = await call("snapshot", { uiLanguage: "en" });
  const deck = snapshot.decks.find((item) => item.id.startsWith("sample-"));
  assert.equal(deck.course, "Sample course · Design patterns");
  const full = await call("deck.get", { id: deck.id });
  for (const card of full.cards) assert.doesNotMatch(`${card.prompt} ${card.answer} ${card.explanation}`, han);
});

test("sample.remove restores the learner's own library exactly, original files included", async (t) => {
  const { call, libraryRoot } = await start(t);
  const { imported } = await userContent(call);
  const before = await libraryState(libraryRoot);
  await call("sample.load", { language: "zh" });
  const loaded = await new Store(libraryRoot).read();
  const sampleDocument = loaded.documents.find((document) => document.sample === true);
  const attachment = join(libraryRoot, sampleDocument.versions[0].attachment.path);
  const userDocument = loaded.documents.find((document) => document.versions.some((version) => version.sourceIds.includes(imported.sourceIds[0])));
  const userAttachment = join(libraryRoot, userDocument.versions[0].attachment.path);
  assert.ok(await exists(attachment), "the sample original is retained while loaded");

  const result = await call("sample.remove", {});
  assert.equal(result.status.loaded, false);
  assert.ok(result.removed.decks >= 1 && result.removed.sources >= 1 && result.removed.attempts >= 30);
  assert.deepEqual(await libraryState(libraryRoot), before, "every user record is exactly as it was before loading");
  assert.equal(await exists(attachment), false, "the sample original file is deleted");
  assert.equal(await exists(userAttachment), true, "the learner's original file is kept");
  assert.equal((await call("sample.status")).loaded, false);
  assert.equal((await call("snapshot", {})).sample?.loaded, false);
});

test("practising sample cards and linking to them never costs the learner their own records", async (t) => {
  const { call, libraryRoot } = await start(t);
  await userContent(call);
  await call("sample.load", { language: "en" });
  const deckId = (await call("snapshot", {})).decks.find((item) => item.id.startsWith("sample-")).id;
  // The learner practises a sample card and ties their own work to it.
  const run = await call("review.start", { mode: "path", scope: [{ deckId }], fresh: true });
  if (run.card.kind === "quiz" || run.card.kind === "multi") await call("review.answer", { runId: run.id, cardId: run.card.id, selected: [run.card.options[0].id] });
  else { await call("review.reveal", { runId: run.id, cardId: run.card.id }); await call("review.answer", { runId: run.id, cardId: run.card.id, grade: 2 }); }
  await call("card.link", { deckId: "user-graphs", cardId: "user-tree", requires: { deckId, cardId: run.card.id } });
  const mine = await call("note.create", { title: "Patterns and graphs", cards: [{ deckId, cardId: run.card.id }, { deckId: "user-graphs", cardId: "user-tree" }] });
  await call("source.add", { title: "Added after the sample", text: "Depth-first search follows one branch as far as possible before backtracking." });

  await call("sample.remove", {});
  const state = await libraryState(libraryRoot);
  const text = JSON.stringify(state);
  assert.doesNotMatch(text, /"sample":true/, "no record tagged sample remains");
  assert.ok(!text.includes(deckId), "nothing refers to the removed sample deck");
  assert.deepEqual(state.decks.map((deck) => deck.id), ["user-graphs"]);
  assert.ok(state.sources.some((source) => source.title === "Added after the sample"), "a source added later survives");
  const note = state.notes.find((item) => item.id === mine.id);
  assert.ok(note, "the learner's note survives");
  assert.deepEqual(note.cards, [{ deckId: "user-graphs", cardId: "user-tree" }], "only its link to the sample card is dropped");
  assert.ok(state.attempts.some((attempt) => attempt.deckId === "user-graphs"), "the learner's own answers survive");
  assert.deepEqual(state.decks[0].cards.find((card) => card.id === "user-tree").requires || [], []);
});

test("loading and removing the sample never calls the model (no quota spent)", async (t) => {
  let calls = 0;
  const { call } = await start(t, async () => { calls++; throw new Error("the sample must not call a model"); });
  assert.equal((await call("snapshot", {})).modelReady, true, "a model is connected");
  await call("sample.load", { language: "en" });
  const deck = (await call("snapshot", {})).decks.find((item) => item.id.startsWith("sample-"));
  assert.equal(deck.uncheckedAtPublish, 0, "the hand-written cards count as reviewed");
  await call("sample.remove", {});
  assert.equal(calls, 0);
});

test("a load interrupted half-way is cleaned up by the next load", async (t) => {
  const { call, libraryRoot } = await start(t);
  const store = new Store(libraryRoot);
  await store.update((state) => {
    state.sampleLibrary = { version: 1, status: "loading", language: "zh" };
    state.sources.push({ id: "sample-orphan", title: "half-loaded", text: "left behind by an interrupted load", sample: true, createdAt: new Date().toISOString() });
  });
  assert.equal((await call("sample.status")).loaded, false);
  await call("sample.load", { language: "zh" });
  const state = await store.read();
  assert.equal(state.sources.filter((source) => source.id === "sample-orphan").length, 0);
  // The lecture and the case scenario (WP12).
  assert.equal(state.sources.filter((source) => source.sample === true).length, 2);
});
