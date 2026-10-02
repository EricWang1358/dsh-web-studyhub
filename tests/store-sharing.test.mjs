import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.js";

/* The store keeps parsed shards, deep-frozen and keyed by content hash. Readers and read-only transaction fields get
   those shared values; a transaction copies only what it writes (and, with a `changed` hint, only the hinted items).
   Writing through a shared value throws instead of reaching the cache. */

const deck = (id, extra = {}) => ({ id, title: `Deck ${id}`, cards: [{ id: `${id}-c1`, kind: "flashcard", prompt: "?", answer: "!", review: { repetitions: 0 } }], ...extra });
const run = (id) => ({ id, deckId: "d1", mode: "flashcard", index: 0, entries: [{ deckId: "d1", card: { id: "d1-c1" } }], startedAt: "2026-09-01T00:00:00.000Z" });

async function seeded(t) {
  const root = await mkdtemp(join(tmpdir(), "study-sharing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update((state) => { state.decks = [deck("d1"), deck("d2")]; state.runs = [run("r1"), run("r2"), run("r3")]; });
  return { root, store };
}
const shardFiles = async (root, dir) => (await readdir(join(root, "shards", dir))).sort();

test("what a reader gets is deep-frozen shared data that survives commits it does not touch", async (t) => {
  const { store } = await seeded(t);
  const before = await store.read();
  assert.ok(Object.isFrozen(before.decks) && Object.isFrozen(before.decks[0]) && Object.isFrozen(before.decks[0].cards[0]), "arrays and nested records are frozen");
  assert.throws(() => { before.decks[0].title = "changed"; }, TypeError);
  assert.throws(() => { before.runs.push(run("late")); }, TypeError);
  await store.update((state) => { state.runs[0].index = 1; }, null, ["runs"]);
  const after = await store.read();
  assert.equal(after.decks, before.decks, "a collection no commit touched keeps its identity (memoised views stay valid)");
  assert.equal(after.decks[1], before.decks[1]);
  assert.notEqual(after.runs, before.runs);
  assert.equal(after.runs[0].index, 1);
  assert.equal(after.runs[1], before.runs[1], "an unchanged item of a rewritten collection is the same parsed object");
});

test("a transaction reads the fields it does not write from the shared values and copies the ones it writes", async (t) => {
  const { store } = await seeded(t);
  const shared = await store.read();
  await store.update((state) => {
    assert.equal(state.decks[0], shared.decks[0], "read-only field: the shared frozen record, nothing parsed or copied");
    assert.ok(Object.isFrozen(state.decks));
    assert.ok(!Object.isFrozen(state.runs) && !Object.isFrozen(state.runs[0]), "a written field is a private copy");
    assert.notEqual(state.runs[0], shared.runs[0]);
    assert.throws(() => { state.decks[0].title = "x"; }, TypeError, "writing through a shared value is refused");
    state.runs[1].index = 5;
  }, null, { reads: ["decks", "runs"], writes: ["runs"] });
  const read = await store.read();
  assert.equal(read.runs[1].index, 5);
  assert.equal(read.decks[0].title, "Deck d1");
});

test("a changed hint leaves the other items of the written field shared and writes one shard", async (t) => {
  const { root, store } = await seeded(t);
  const shared = await store.read();
  const before = await shardFiles(root, "runs");
  await store.update((state) => {
    assert.equal(state.runs[0], shared.runs[0], "an item the hint leaves alone is the shared frozen record");
    assert.ok(Object.isFrozen(state.runs[0]));
    assert.ok(!Object.isFrozen(state.runs[1]), "the hinted item is a private copy");
    state.runs[1].index = 2;
    assert.throws(() => { state.runs[2].index = 9; }, TypeError, "a write outside the hint is refused, never silently lost");
  }, { runs: new Set(["r2"]) }, { reads: ["runs"], writes: ["runs"] });
  const after = await shardFiles(root, "runs");
  assert.equal(after.length, before.length);
  assert.equal(after.filter((name) => !before.includes(name)).length, 1, "exactly one run shard was rewritten");
  assert.equal((await store.read()).runs[1].index, 2);
  assert.equal((await new Store(root).read()).runs[2].index, 0, "a fresh store sees the committed files, not the shared cache");
});

test("a failed transaction leaves the committed library and the shared values untouched", async (t) => {
  const { store } = await seeded(t);
  const before = await store.read();
  await assert.rejects(store.update((state) => { state.runs[0].index = 7; throw new Error("boom"); }, null, ["runs"]), /boom/);
  const after = await store.read();
  assert.equal(after.runs, before.runs);
  assert.equal(after.runs[0].index, 0);
});

test("STUDY_STORE_PRIVATE=1 turns the sharing off: every transaction parses private copies", async (t) => {
  const { store } = await seeded(t);
  process.env.STUDY_STORE_PRIVATE = "1";
  t.after(() => { delete process.env.STUDY_STORE_PRIVATE; });
  const shared = await store.read();
  await store.update((state) => {
    assert.notEqual(state.decks[0], shared.decks[0]);
    assert.ok(!Object.isFrozen(state.decks[0]));
    state.decks[0].title = "private";
  }, null, { reads: ["decks"], writes: [] });
  assert.equal((await store.read()).decks[0].title, "Deck d1", "a change to a field the transaction does not write is not persisted");
});

test("a parsed shard's text is not kept in memory, and a transaction copies the parsed value instead of reading the file", async (t) => {
  const { root, store } = await seeded(t);
  const entry = await store.load();
  for (const field of Object.keys(entry.state)) void entry.state[field];
  assert.ok(entry.files.size > 0);
  assert.ok([...entry.files.values()].every((text) => text === null), "every shard was parsed and shared, so no text is held");
  // Reading a collection of a thousand shard files back took 100-500 ms of blocking I/O: with the files gone, copies still work.
  await rm(join(root, "shards", "decks"), { recursive: true });
  await rm(join(root, "shards", "runs"), { recursive: true });
  await store.update((state) => { state.runs[1].index = 4; }, { runs: new Set(["r2"]) }, { reads: ["runs"], writes: ["runs"] });
  await store.update((state) => { state.decks[0].title = "renamed"; }, null, ["decks"]);
  const after = await store.read();
  assert.equal(after.runs[1].index, 4, "the copy was made from the file and committed");
  assert.equal(after.decks[0].title, "renamed");
  assert.equal(after.runs[0].index, 0);
  assert.equal((await new Store(root).read()).decks[0].title, "renamed", "and it is what a fresh store reads");
  // A rewrite that regenerates shard names the cache already holds (every run is serialised, one of them changed) keeps no text either.
  await store.update((state) => { state.runs[2].index = 5; }, null, ["runs"]);
  const rewritten = await store.load();
  for (const field of Object.keys(rewritten.state)) void rewritten.state[field];
  assert.ok([...rewritten.files.values()].every((text) => text === null), "no shard text stays in memory after the library is read");
});

test("a state read earlier stays complete after later commits replace and delete its shards", async (t) => {
  const { store } = await seeded(t);
  const before = await store.read();
  await store.update((state) => { state.decks = [deck("d3")]; state.runs = []; }, null, ["decks", "runs"]);
  assert.deepEqual(before.decks.map((item) => item.id), ["d1", "d2"], "the view taken earlier is untouched by what replaced it");
  assert.deepEqual(before.runs.map((item) => item.id), ["r1", "r2", "r3"]);
  assert.equal(before.decks[0].cards[0].prompt, "?");
  const now = await store.read();
  assert.deepEqual(now.decks.map((item) => item.id), ["d3"]);
  assert.deepEqual(now.runs, []);
});
