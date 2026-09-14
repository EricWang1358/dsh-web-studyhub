import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, emptyState, normalizeState, LATEST_VERSION } from "../lib/store.js";
import { StudyService } from "../lib/service.js";
import { spawn } from "node:child_process";
import { once } from "node:events";

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

test("Windows temporary file sharing lock does not discard a study update", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
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

test("Windows persistent sharing lock preserves committed bytes and releases the store lock", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
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
    assert.deepEqual(await readdir(root), ["study-workspace.json"]);
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
  assert.equal(normalizeState({}).version, 1);
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
