import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, emptyState, normalizeState, LATEST_VERSION } from "../lib/store.js";
import { StudyService } from "../lib/service.js";

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
