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
