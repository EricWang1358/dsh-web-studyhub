import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const card = (n, extra = {}) => ({ kind: "quiz", topic: "云迁移", objective: `判断迁移策略 ${n}`,
  prompt: `第 ${n} 题：哪种迁移方式改动最小？`, answer: "Rehost",
  explanation: "Rehost 直接搬迁，不改代码，所以改动最小。", misconception: "以为所有迁移都要重构。",
  options: [{ id: "a", text: "Rehost", correct: true, explanation: "直接搬迁，改动最小。" },
    { id: "b", text: "Refactor", correct: false, explanation: "需要改代码，改动更大。" }], ...extra });

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "study-bulk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = join(root, "banks");
  await mkdir(files);
  return { service: new StudyService(join(root, "library")), files };
}

test("a folder of question banks becomes published decks in one call, and re-running adds nothing", async (t) => {
  const { service, files } = await setup(t);
  await writeFile(join(files, "02 云迁移与 IaC.json"), JSON.stringify({ title: "02 云迁移与 IaC", cards: [1, 2, 3].map((n) => card(n)) }));
  await writeFile(join(files, "03 云持久化.json"), JSON.stringify([4, 5].map((n) => card(n, { topic: "持久化" }))));
  await writeFile(join(files, "notes.txt"), "ignored: folders import .json only");
  const first = await service.call("deck.import", { path: files, folder: "Cloud Native Solution Design" });
  assert.equal(first.imported, 2);
  assert.equal(first.added, 5);
  assert.deepEqual(first.results.map((r) => [r.title, r.created, r.added, r.total, r.folder]), [
    ["02 云迁移与 IaC", true, 3, 3, "Cloud Native Solution Design"],
    ["03 云持久化", true, 2, 2, "Cloud Native Solution Design"]], "a bare card array is titled by its file");
  const state = await service.store.read();
  assert.equal(state.decks.length, 2, "published, not left as drafts");
  assert.equal(state.drafts.length, 0);
  const again = await service.call("deck.import", { path: files, folder: "Cloud Native Solution Design" });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 5);
  assert.equal((await service.store.read()).decks.length, 2, "no duplicate decks");
});

test("an interrupted deck is filled with only the questions it lacks", async (t) => {
  const { service, files } = await setup(t);
  const bank = join(files, "02.json");
  await writeFile(bank, JSON.stringify({ title: "02 云迁移与 IaC", folder: "Cloud Native Solution Design", cards: [1, 2, 3, 4].map((n) => card(n)) }));
  // Two questions arrived earlier through chunked ingest, spaced and punctuated differently.
  await service.store.update((s) => s.decks.push({ id: "partial", title: "02 云迁移与 IaC", folder: "Cloud Native Solution Design",
    cards: [{ id: "old1", kind: "flashcard", topic: "云迁移", prompt: "第1题 哪种迁移方式改动最小", answer: "Rehost" },
      { id: "old2", kind: "flashcard", topic: "云迁移", prompt: "第 2 题：哪种迁移方式改动最小?", answer: "Rehost" }] }));
  const result = await service.call("deck.import", { path: bank });
  assert.deepEqual([result.results[0].deckId, result.results[0].created, result.results[0].added, result.results[0].skipped, result.results[0].total],
    ["partial", false, 2, 2, 4]);
  const deck = (await service.store.read()).decks.find((d) => d.id === "partial");
  assert.deepEqual(deck.cards.slice(0, 2).map((c) => c.id), ["old1", "old2"], "existing cards and their history stay put");
  assert.equal((await service.store.read()).decks.length, 1);
});

test("bad input is reported per file without stopping the others", async (t) => {
  const { service, files } = await setup(t);
  await writeFile(join(files, "a.json"), JSON.stringify({ title: "A", cards: [card(1)] }));
  await writeFile(join(files, "b.json"), "{ not json");
  const result = await service.call("deck.import", { paths: [join(files, "a.json"), join(files, "b.json")] });
  assert.equal(result.imported, 1);
  assert.equal(result.failed, 1);
  assert.match(result.results[1].error, /JSON 格式错误/);
  await assert.rejects(service.call("deck.import", { path: "relative/bank.json" }), /绝对路径/);
  await assert.rejects(service.call("deck.import", { path: join(files, "a.md") }), /找不到|只能导入/);
  const inline = await service.call("deck.import", { text: JSON.stringify({ title: "粘贴", cards: [card(9)] }) });
  assert.equal(inline.added, 1);
});

/* The hand-off plan (section 3 item 7, S3): the main chat enters a question book chapter by chapter with deck.import {draft:true}, so the learner checks
   the drafts before anything is published; only without draft (the learner said "import it directly") is it published at once. Nothing else changes. */
test("draft:true stops before publication: the decks wait as drafts, nothing is published, and each draft id comes back to publish later", async (t) => {
  const { service, files } = await setup(t);
  await writeFile(join(files, "01 第一章.json"), JSON.stringify({ title: "01 第一章", cards: [1, 2].map((n) => card(n)) }));
  await writeFile(join(files, "02 第二章.json"), JSON.stringify([3].map((n) => card(n))));
  const result = await service.call("deck.import", { path: files, folder: "期末题册", draft: true });
  assert.equal(result.imported, 2);
  assert.equal(result.added, 0, "nothing is added to a deck");
  assert.equal(result.drafted, 3);
  const state = await service.store.read();
  assert.equal(state.decks.length, 0, "not published");
  assert.equal(state.drafts.length, 2);
  assert.deepEqual(result.results.map((r) => [r.title, r.draft, r.drafted, r.added, r.deckId ?? null]), [["01 第一章", true, 2, 0, null], ["02 第二章", true, 1, 0, null]]);
  for (const r of result.results) {
    const draft = state.drafts.find((d) => d.id === r.draftId);
    assert.ok(draft, "the draft id is returned");
    assert.equal(r.draftVersion, draft.draftVersion, "with its version, for draft.publish later");
    assert.equal(draft.folder, "期末题册");
  }
  // The learner publishes one after checking it: the ordinary publication.
  const first = result.results[0];
  const published = await service.call("draft.publish.quick", { id: first.draftId, draftVersion: first.draftVersion });
  assert.equal((await service.store.read()).decks.find((d) => d.id === published.id).cards.length, 2);
});

test("draft:true into a deck that exists: the draft carries that deck as its target and only the questions it lacks; the deck is untouched until published", async (t) => {
  const { service, files } = await setup(t);
  const bank = join(files, "02.json");
  await writeFile(bank, JSON.stringify({ title: "02 云迁移与 IaC", cards: [1, 2].map((n) => card(n)) }));
  await service.call("deck.import", { path: bank });
  await writeFile(bank, JSON.stringify({ title: "02 云迁移与 IaC", cards: [1, 2, 3].map((n) => card(n)) }));
  const result = await service.call("deck.import", { path: bank, draft: true });
  const [r] = result.results;
  assert.deepEqual([r.draft, r.drafted, r.skipped, r.added], [true, 1, 2, 0]);
  const state = await service.store.read();
  assert.equal(state.decks[0].cards.length, 2, "the deck waits for the learner");
  assert.equal(state.drafts.find((d) => d.id === r.draftId).mergeTargetId, state.decks[0].id);
});

test("draft is a boolean, and the limits are the same with it (50 files, one file at most 500,000 characters, absolute paths)", async (t) => {
  const { service, files } = await setup(t);
  await writeFile(join(files, "a.json"), JSON.stringify({ title: "A", cards: [card(1)] }));
  await assert.rejects(service.call("deck.import", { path: files, draft: "yes" }), /draft/);
  await assert.rejects(service.call("deck.import", { path: "relative/bank.json", draft: true }), /绝对路径/);
  const many = Array.from({ length: 51 }, (_, n) => join(files, `m${n}.json`));
  for (const file of many) await writeFile(file, JSON.stringify({ title: file, cards: [card(1)] }));
  await assert.rejects(service.call("deck.import", { paths: many, draft: true }), /一次最多导入 50 个文件/);
  await writeFile(join(files, "big.json"), "x".repeat(2_000_001));
  const big = await service.call("deck.import", { path: join(files, "big.json"), draft: true });
  assert.match(big.results[0].error, /文件过大/);
  assert.equal((await service.store.read()).drafts.length, 0);
});
