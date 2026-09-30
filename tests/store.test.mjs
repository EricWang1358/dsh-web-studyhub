import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, emptyState, normalizeState, LATEST_VERSION } from "../lib/store.js";
import { StudyService } from "../lib/service.js";
import { spawn } from "node:child_process";
import { once } from "node:events";

test('BOM-prefixed library manifests, shards and legacy files preserve their data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-bom-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { id: 'audio-source', title: 'Recording', text: 'Embedded \uFEFF remains.' };
  await mkdir(join(root, 'shards', 'sources'), { recursive: true });
  await writeFile(join(root, 'shards', 'sources', 'audio.json'), '\uFEFF' + JSON.stringify(source));
  const manifest = { ...emptyState(), format: 'study-sharded', shards: { sources: ['sources/audio.json'] } };
  await writeFile(join(root, 'study-workspace.json'), '\uFEFF' + JSON.stringify(manifest));
  assert.deepEqual((await new Store(root).read()).sources[0], source);
  const legacyRoot = join(root, 'legacy');
  await mkdir(legacyRoot);
  const raw = '\uFEFF' + JSON.stringify({ ...emptyState(), sources: [source] });
  await writeFile(join(legacyRoot, 'study-workspace.json'), raw);
  const legacy = new Store(legacyRoot);
  assert.equal((await legacy.read()).sources[0].text, source.text);
  await legacy.update(state => { state.sources[0].title = 'Updated recording'; });
  assert.equal((await legacy.read()).sources[0].title, 'Updated recording');
});

test('one damaged shard leaves healthy content readable and blocks destructive partial writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', { title: 'Healthy', text: 'Healthy recording.' });
  await service.call('source.add', { title: 'Damaged', text: 'Recoverable recording.' });
  const manifest = JSON.parse(await readFile(service.store.path, 'utf8'));
  const original = await readFile(join(root, 'shards', manifest.shards.sources[1]), 'utf8');
  manifest.shards.sources[1] = 'sources/damaged.json';
  const brokenPath = join(root, 'shards', manifest.shards.sources[1]);
  await writeFile(brokenPath, '{"id":"audio",');
  // A fresh manifest stat invalidates the previous healthy cache.
  await writeFile(service.store.path, JSON.stringify(manifest) + '\n');
  const snapshot = await service.call('snapshot');
  assert.deepEqual(snapshot.sources.map(source => source.title), ['Healthy']);
  assert.equal(snapshot.storageIssues.length, 1);
  assert.equal(snapshot.storageIssues[0].file, `shards/${manifest.shards.sources[1]}`);
  assert.ok((await service.call('map')).decks);
  assert.ok((await service.call('settings')).first_interval_days);
  await assert.rejects(service.call('export'), /损坏文件/);
  await assert.rejects(service.call('source.add', { title: 'Unsafe', text: 'Must not erase the damaged entry.' }), /损坏文件/);
  assert.equal(await readFile(brokenPath, 'utf8'), '{"id":"audio",');
  assert.equal(await readFile(service.store.path, 'utf8'), JSON.stringify(manifest) + '\n');
  // Repairing only the shard must recover on the next poll, without a restart.
  await writeFile(brokenPath, original);
  const recovered = await service.call('snapshot', { since: snapshot.fingerprint });
  assert.equal(recovered.unchanged, undefined);
  assert.equal(recovered.sources.length, 2);
  assert.deepEqual(recovered.storageIssues, []);
  await service.call('source.add', { title: 'After repair', text: 'Writes work again.' });
  assert.equal((await service.call('snapshot')).sources.length, 3);
});

test("a full export restores the library and preserves the replaced state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call("source.add", { title: "Original", text: "Original study material" });
  const exported = await service.call("export");
  await service.call("source.add", { title: "Later", text: "Later study material" });
  const before = await service.call("export");
  await assert.rejects(service.call("restore", { state: { format: "study-sharded", shards: {} } }), /完整 JSON 备份/);
  assert.deepEqual(await service.call("export"), before, "invalid input cannot replace the library");
  const result = await service.call("restore", { state: exported });
  assert.equal(result.sources, 1);
  assert.equal((await new StudyService(root).call("export")).sources[0].title, "Original");
  const savedPrevious = JSON.parse(await readFile(result.backupPath, "utf8"));
  assert.equal(savedPrevious.sources.length, 2);
  assert.equal(savedPrevious.sources[1].title, "Later");
});

// These tests start PowerShell to hold the lock; a cold start on a CI runner can take
// several seconds, so their timeout guards against a hang rather than measuring speed.
const LOCK_TEST_TIMEOUT = 60000;

async function holdWindowsFile(path) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    '$f = [System.IO.File]::Open($env:STUDY_TEST_LOCK_PATH, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine("locked"); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }',
  ], { windowsHide: true, env: { ...process.env, STUDY_TEST_LOCK_PATH: path }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let released = false;
  await Promise.race([
    once(child.stdout, "data").then(([data]) => assert.match(data.toString(), /locked/)),
    exited.then(() => { throw new Error("File lock helper exited before acquiring lock"); }),
  ]);
  return async () => { if (!released && child.exitCode === null) { released = true; child.stdin.end("release\n"); } await exited; };
}

test("Windows temporary file sharing lock does not discard a study update", { skip: process.platform !== "win32", timeout: LOCK_TEST_TIMEOUT }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-sharing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update((s) => { s.settings.first_interval_days = 2; });
  const unlock = await holdWindowsFile(store.path);
  const timer = setTimeout(() => { void unlock(); }, 600);
  let mutations = 0;
  try {
    await store.update((s) => { mutations++; s.settings.first_interval_days = 3; });
    assert.equal((await store.read()).settings.first_interval_days, 3);
    assert.equal((await store.read()).revision, 2);
    assert.equal(mutations, 1, "retry must not replay the mutation");
  } finally { clearTimeout(timer); await unlock(); }
});

test("Windows persistent sharing lock preserves committed bytes and releases the store lock", { skip: process.platform !== "win32", timeout: LOCK_TEST_TIMEOUT }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-sharing-persistent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update((s) => { s.settings.first_interval_days = 2; });
  const before = await readFile(store.path, "utf8");
  const unlock = await holdWindowsFile(store.path);
  let mutations = 0;
  try {
    await assert.rejects(store.update((s) => { mutations++; s.settings.first_interval_days = 3; }), (error) => {
      assert.equal(error.code, "EPERM");
      assert.match(error.message, /原学习库未被覆盖/);
      return true;
    });
    assert.equal(mutations, 1);
    assert.equal(await readFile(store.path, "utf8"), before);
    assert.deepEqual((await readdir(root)).filter((name) => name !== "shards"), ["study-workspace.json"],
      "only unreferenced shards may be left behind, never a temp manifest");
  } finally { await unlock(); }
  await store.update((s) => { s.settings.first_interval_days = 4; });
  assert.equal((await store.read()).settings.first_interval_days, 4);
  assert.equal((await store.read()).revision, 2);
});

const complete = async () => {
  throw new Error("no model in tests");
};

test("normalizeState restores fields missing from older libraries", () => {
  const legacy = { version: 1, revision: 3, settings: { minimum: 2 }, sources: [] };
  const s = normalizeState(legacy);
  for (const f of ["decks", "drafts", "attempts", "runs", "teaching"])
    assert.deepEqual(s[f], [], `${f} filled`);
  assert.equal(s.revision, 3, "revision untouched");
  assert.ok(s.settings.first_interval_days, "settings completed from defaults");
  assert.equal(s.settings.minimum, 2, "stored settings win over defaults");
});

test("normalizeState accepts a missing version field and refuses newer ones", () => {
  assert.equal(normalizeState({}).version, LATEST_VERSION, "a version 1 library migrates in memory");
  assert.throws(() => normalizeState({ version: LATEST_VERSION + 1 }), /newer/);
});

test("store.read normalizes a legacy file on disk and the next update persists the shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-store-"));
  await writeFile(
    join(root, "study-workspace.json"),
    JSON.stringify({ version: 1, revision: 1, settings: {} }),
  );
  const store = new Store(root);
  const s = await store.read();
  assert.deepEqual(s.teaching, []);
  const service = new StudyService(root, { complete });
  await service.call("settings", {
    minimum_ease_factor: 1.3,
    initial_ease_factor: 2.5,
    first_interval_days: 1,
    second_interval_days: 6,
  });
  const after = JSON.parse(await store.read().then((x) => JSON.stringify(x)));
  assert.ok(Array.isArray(after.teaching), "normalized fields persisted");
  assert.equal(after.settings.first_interval_days, 1);
});

test("emptyState matches the latest version shape", () => {
  const s = emptyState();
  assert.equal(s.version, LATEST_VERSION);
  assert.ok(Array.isArray(s.teaching) && Array.isArray(s.runs));
});

test("malformed existing state is rejected without overwriting its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-invalid-"));
  const store = new Store(root);
  try {
    for (const invalid of [null, [], "bad", { decks: { saved: "data" } }, { sources: null }, { version: "1" }, { revision: -1 }, { settings: [] }]) {
      const raw = JSON.stringify(invalid);
      await writeFile(store.path, raw);
      await assert.rejects(store.update((s) => { s.settings.first_interval_days = 2; }), /Invalid library/);
      assert.equal(await readFile(store.path, "utf8"), raw);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const shardFiles = async (root) => {
  const out = [];
  for (const dir of await readdir(join(root, "shards")).catch(() => []))
    for (const name of await readdir(join(root, "shards", dir))) out.push(`${dir}/${name}`);
  return out.sort();
};
const deckOf = (id, cards = 1) => ({ id, title: id, cards: Array.from({ length: cards }, (_, i) => ({ id: `${id}-${i}`, prompt: "p" })) });

test("commits write only changed shards behind an atomic manifest and collect the old ones", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-shards-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update((s) => {
    s.decks.push(deckOf("a"), deckOf("b"));
    s.sources.push({ id: "src", title: "S", text: "x".repeat(1000) });
    s.attempts.push(...Array.from({ length: 2500 }, (_, i) => ({ id: `t${i}`, grade: 3 })));
  });
  const manifest = JSON.parse(await readFile(store.path, "utf8"));
  assert.equal(manifest.format, "study-sharded");
  assert.equal(manifest.version, LATEST_VERSION, "older builds refuse the manifest instead of reading an empty library");
  assert.equal(manifest.shards.decks.length, 2);
  assert.equal(manifest.shards.attempts.length, 3, "attempts are chunked");
  assert.equal(manifest.decks, undefined, "collections live in shards, not the manifest");
  const before = await shardFiles(root);

  await store.update((s) => { s.decks[1].title = "renamed"; s.attempts.push({ id: "last", grade: 1 }); });
  const after = await shardFiles(root);
  const changed = after.filter((f) => !before.includes(f));
  assert.equal(changed.length, 2, "only deck b and the last attempts chunk are rewritten");
  assert.ok(changed.some((f) => f.startsWith("decks/b.")) && changed.some((f) => f.startsWith("attempts/2.")));
  assert.equal(before.filter((f) => !after.includes(f)).length, 2, "their previous versions are collected");

  const fresh = await new Store(root).read();
  assert.equal(fresh.decks[1].title, "renamed");
  assert.equal(fresh.attempts.length, 2501);
  assert.equal(fresh.attempts.at(-1).id, "last", "chunk order is preserved");

  await store.update((s) => { s.decks.splice(0, 1); });
  assert.ok(!(await shardFiles(root)).some((f) => f.startsWith("decks/a.")), "a removed deck's shard is deleted");
});

test("practice steps preserve unrelated historical shards while saving progress", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-practice-shards-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  const card = (id) => ({ id, kind: "quiz", topic: "Paths", objective: `Locate ${id}`,
    prompt: `Which path for ${id}?`, answer: "/items", hint: "Use a noun",
    explanation: "The path names the resource.", misconception: "Actions do not name collections.",
    citations: [], options: [
      { id: "a", text: "/items", correct: true, explanation: "Resource" },
      { id: "b", text: "/getItems", correct: false, explanation: "Action" },
      { id: "c", text: "/findItems", correct: false, explanation: "Action" },
    ] });
  await service.store.update((s) => {
    s.sources.push({ id: "source", title: "Source", text: "Resource paths use nouns." });
    s.decks.push({ id: "deck", title: "Paths", cards: [card("q1"), card("q2")] });
  });
  const oldRun = await service.call("review.start", { mode: "new", deckId: "deck", count: 2 });
  const run = await service.call("review.start", { mode: "new", deckId: "deck", count: 2, fresh: true });
  const manifest = async () => (JSON.parse(await readFile(join(root, "study-workspace.json"), "utf8"))).shards;
  const before = await manifest();
  const oldIndex = (await service.store.read()).runs.findIndex((item) => item.id === oldRun.id);
  const currentIndex = (await service.store.read()).runs.findIndex((item) => item.id === run.id);
  const answered = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["a"] });
  const afterAnswer = await manifest();
  assert.equal(afterAnswer.runs[oldIndex], before.runs[oldIndex]);
  assert.notEqual(afterAnswer.runs[currentIndex], before.runs[currentIndex]);
  assert.notEqual(afterAnswer.decks[0], before.decks[0]);
  assert.equal(afterAnswer.sources[0], before.sources[0]);
  assert.notDeepEqual(afterAnswer.attempts, before.attempts);
  assert.equal(answered.answered, 1);

  await service.call("review.move", { runId: run.id, direction: 1 });
  const afterMove = await manifest();
  assert.notEqual(afterMove.runs[currentIndex], afterAnswer.runs[currentIndex]);
  assert.equal(afterMove.runs[oldIndex], afterAnswer.runs[oldIndex]);
  assert.equal(afterMove.decks[0], afterAnswer.decks[0]);
  assert.deepEqual(afterMove.attempts, afterAnswer.attempts);
  const reopened = await new Store(root).read();
  assert.equal(reopened.runs[currentIndex].index, 1);
  assert.equal(reopened.decks[0].cards.find((item) => item.id === run.card.id).review.repetitions, 1);
});

test("a failed mutation writes nothing and leaves the cached library intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-shards-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update((s) => { s.decks.push(deckOf("a")); s.ingest = { active: true, added: 1 }; });
  const manifest = await readFile(store.path, "utf8");
  const files = await shardFiles(root);
  await assert.rejects(store.update((s) => { s.decks[0].title = "half"; s.ingest.added = 99; throw new Error("boom"); }), /boom/);
  assert.equal(await readFile(store.path, "utf8"), manifest);
  assert.deepEqual(await shardFiles(root), files);
  const s = await store.read();
  assert.equal(s.decks[0].title, "a");
  assert.equal(s.ingest.added, 1, "nested manifest fields are not shared with working copies");
});

test("a version 1 monolithic library opens, and its first commit keeps a backup and shards it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-shards-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = { version: 1, revision: 7, settings: {}, decks: [deckOf("old", 3)], sources: [], drafts: [], attempts: [{ id: "a1", grade: 4 }], runs: [], teaching: [] };
  const raw = JSON.stringify(legacy, null, 2);
  await writeFile(join(root, "study-workspace.json"), raw);
  const store = new Store(root);
  const read = await store.read();
  assert.equal(read.decks[0].cards.length, 3);
  assert.equal(read.version, LATEST_VERSION);
  await store.update((s) => { s.settings.first_interval_days = 2; });
  const backups = await readdir(join(root, "backups"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(root, "backups", backups[0]), "utf8"), raw, "the original bytes are kept");
  const manifest = JSON.parse(await readFile(store.path, "utf8"));
  assert.equal(manifest.format, "study-sharded");
  assert.equal(manifest.revision, 8);
  const reopened = await new Store(root).read();
  assert.deepEqual(reopened.decks, legacy.decks);
  assert.deepEqual(reopened.attempts, legacy.attempts);
  await store.update((s) => { s.settings.first_interval_days = 3; });
  assert.equal((await readdir(join(root, "backups"))).length, 1, "only the first sharded commit backs up");
});

test("reads are cached per manifest stat and pick up another writer's commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-shards-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update((s) => { s.decks.push(deckOf("a")); });
  assert.equal(await store.read(), await new Store(root).read(), "unchanged manifest: the same parsed library");
  // Another process commits: new shard, new manifest.
  const manifest = JSON.parse(await readFile(store.path, "utf8"));
  await writeFile(join(root, "shards", "decks", "external.ext.json"), JSON.stringify(deckOf("external")));
  manifest.shards.decks.push("decks/external.ext.json");
  manifest.revision++;
  await writeFile(store.path, JSON.stringify(manifest));
  const s = await store.read();
  assert.deepEqual(s.decks.map((d) => d.id), ["a", "external"]);
});

test("service flows never mutate the shared cached library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-shards-frozen-"));
  t.after(() => { delete process.env.STUDY_STORE_FREEZE; return rm(root, { recursive: true, force: true }); });
  process.env.STUDY_STORE_FREEZE = "1";
  const service = new StudyService(root);
  const quote = "Bridge separates an abstraction from its implementation.";
  await service.call("source.add", { id: "s", title: "Bridge", text: quote });
  const card = (id, kind) => ({ id, kind, topic: "Bridge", objective: `o-${id}`, prompt: `Why ${id}?`, answer: "Separation", hint: "Two dimensions",
    explanation: "They vary independently.", misconception: "Subclass everything.", citations: [{ sourceId: "s", quote }],
    ...(kind === "quiz" ? { options: [{ id: "a", text: "Separate", correct: true, explanation: "yes" }, { id: "b", text: "Merge", correct: false, explanation: "no" }, { id: "c", text: "Copy", correct: false, explanation: "no" }] } : {}) });
  await service.call("draft.save", { deck: { id: "d", title: "Patterns", cards: [card("q1", "quiz"), card("q2", "quiz")] } });
  await service.call("draft.publish", { id: "d" });
  let run = await service.call("review.start", { deckId: "d", mode: "quiz" });
  run = await service.call("review.answer", { runId: run.id, cardId: run.card.id, selected: ["b"] });
  run = await service.call("review.move", { runId: run.id, direction: 1 });
  await service.call("review.get", { runId: run.id });
  for (const action of ["snapshot", "map", "stats", "wrongbook", "coach.status", "coach.profile"]) await service.call(action);
  await service.call("graph", { mode: "path" });
  const edit = await service.call("deck.edit", { id: "d" });
  edit.title = "Renamed";
  assert.equal((await service.call("export")).drafts[0].title, "Patterns", "a caller's copy is its own");
});
