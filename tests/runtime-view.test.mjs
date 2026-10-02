import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyRuntime } from "../lib/runtime.js";
import { Store } from "../lib/store.js";
import { createStatePort } from "../lib/runtime/state-port.js";

/* state.read hands a context a private copy of its collections; state.view hands out the store's frozen shared values
   (nothing copied) for code that only looks. Both can name the fields they need. */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "study-runtime-view-"));
  const store = new Store(root), runtime = new StudyRuntime(root, { storage: store });
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  runtime.register({ id: "reader", collections: ["records", "notes2"], operations: {
    read: { ownsResult: true, execute: (args, context) => context.state.read(args.fields) },
    view: { ownsResult: true, execute: (args, context) => context.state.view(args.fields) },
  } });
  await store.update((state) => { state.records = [{ id: "a", nested: { n: 1 } }]; state.notes2 = [{ id: "n" }]; });
  return { runtime, store };
}

test("a view is the shared frozen collection, a read is a private copy", async (t) => {
  const { runtime, store } = await fixture(t);
  const shared = await store.read();
  const viewed = await runtime.call("reader.view", {});
  const copied = await runtime.call("reader.read", {});
  assert.equal(viewed.records, shared.records, "nothing was copied");
  assert.ok(Object.isFrozen(viewed.records[0].nested));
  assert.throws(() => { viewed.records[0].nested.n = 2; }, TypeError);
  assert.notEqual(copied.records, shared.records);
  copied.records[0].nested.n = 2;
  assert.equal((await store.read()).records[0].nested.n, 1, "a copy is the caller's own");
});

test("a read or a view can name the fields it needs", async (t) => {
  const { runtime } = await fixture(t);
  assert.deepEqual(Object.keys(await runtime.call("reader.view", { fields: ["records"] })).sort(), ["records", "revision"]);
  assert.deepEqual(Object.keys(await runtime.call("reader.read", { fields: ["notes2"] })).sort(), ["notes2", "revision"]);
  assert.deepEqual(Object.keys(await runtime.call("reader.read", {})).sort(), ["notes2", "records", "revision"]);
});

test("the state port's view merges defaults under the shared values and read stays a copy", async () => {
  const shared = Object.freeze([Object.freeze({ id: "x" })]);
  const context = { hasCapability: () => true, readSnapshot: async (_apis, _fields, view) => [{ revision: 1, items: view ? shared : structuredClone(shared) }],
    transaction: async () => null };
  const port = createStatePort("/root", context, { reads: ["items.v1"], writes: [], participants: [], defaults: { items: [], settings: { a: 1 } } });
  const viewed = await port.view(), read = await port.read();
  assert.equal(viewed.items, shared);
  assert.notEqual(read.items, shared);
  assert.deepEqual(viewed.settings, { a: 1 }, "defaults fill what the store lacks");
});
