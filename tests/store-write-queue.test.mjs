/* Writers of one process never contend for the library's file lock: they take turns in a queue per library folder, and the file lock only arbitrates between processes.
   Its retry budget is one named constant (STORE_LOCK), long and jittered. Fakes only; the "other process" is a lock held by the test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { Store } from '../lib/store.js';
import { STORE_LOCK } from '../lib/store-lock.js';

const library = async t => {
  const root = await mkdtemp(join(tmpdir(), 'store-queue-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
};

test('many concurrent writers of one process all succeed, one at a time, in the order they asked, and no write is lost', async t => {
  const root = await library(t), stores = [new Store(root), new Store(root), new Store(root)];
  let inside = 0, deepest = 0;
  const order = [];
  const writes = Array.from({ length: 60 }, (_, index) => stores[index % 3].update(state => {
    inside += 1; deepest = Math.max(deepest, inside); order.push(index);
    state.sources.push({ id: `s${index}`, title: `Source ${index}`, text: `Text ${index}` });
    return new Promise(resolve => setImmediate(() => { inside -= 1; resolve(index); }));
  }));
  assert.deepEqual(await Promise.all(writes), Array.from({ length: 60 }, (_, index) => index));
  assert.equal(deepest, 1, 'never two writers inside the library at once');
  assert.deepEqual(order, Array.from({ length: 60 }, (_, index) => index), 'in the order they asked');
  const kept = (await new Store(root).read()).sources.map(source => source.id).sort();
  assert.deepEqual(kept, Array.from({ length: 60 }, (_, index) => `s${index}`).sort(), 'the final state holds every update');
});

test('a failed writer gives its turn to the next, and a restore takes its turn like an update', async t => {
  const root = await library(t), store = new Store(root);
  const failing = store.update(() => { throw new Error('boom'); });
  const next = store.update(state => { state.sources.push({ id: 'after', title: 'After', text: 'x' }); });
  await assert.rejects(failing, /boom/);
  await next;
  const backup = await store.read();
  const results = await Promise.all([store.update(state => { state.sources.push({ id: 'one', title: 'One', text: 'x' }); }), store.restore({ ...backup, sources: [] }), store.update(state => { state.sources.push({ id: 'two', title: 'Two', text: 'x' }); })]);
  assert.equal(results.length, 3);
  assert.deepEqual((await store.read()).sources.map(source => source.id), ['two'], 'the restore came between the two updates, in the order they asked');
});

test('another process holding the library is waited for, then refused cleanly once the budget is spent; the library is untouched', async t => {
  const root = await library(t), store = new Store(root, { lockRetry: { retries: 3, factor: 1.5, minTimeout: 20, maxTimeout: 60, randomize: true } });
  await store.update(state => { state.sources.push({ id: 'kept', title: 'Kept', text: 'x' }); });
  const release = await lockfile.lock(root, { realpath: true });
  const started = Date.now();
  await assert.rejects(store.update(state => { state.sources.push({ id: 'refused', title: 'Refused', text: 'x' }); }), { code: 'ELOCKED' });
  assert.ok(Date.now() - started >= 20, 'it did wait before it gave up');
  await release();
  assert.deepEqual((await store.read()).sources.map(source => source.id), ['kept'], 'a refused write changed nothing');
  await store.update(state => { state.sources.push({ id: 'later', title: 'Later', text: 'x' }); });
  assert.deepEqual((await store.read()).sources.map(source => source.id), ['kept', 'later'], 'and the queue is not stuck behind the refusal');
});

test('the cross-process retry budget is one named constant: long, jittered and about thirty seconds', () => {
  const { retries, factor, minTimeout, maxTimeout, randomize } = STORE_LOCK.retry;
  assert.equal(randomize, true, 'contenders do not retry in step');
  let least = 0, most = 0;
  // The wait of a try is a random one to two times minTimeout * factor ** try, capped at maxTimeout (the `retry` package).
  for (let attempt = 0; attempt < retries; attempt++) { least += Math.min(minTimeout * factor ** attempt, maxTimeout); most += Math.min(2 * minTimeout * factor ** attempt, maxTimeout); }
  assert.ok(least >= 20_000 && most <= 40_000, `the budget is ${Math.round(least)}..${Math.round(most)} ms: about thirty seconds`);
  assert.ok(STORE_LOCK.stale >= 30_000, 'a lock is stale only after the longest wait of a live holder');
});

test('a write started from inside another write of the same library is refused at once instead of waiting for itself', async t => {
  const root = await library(t), store = new Store(root);
  await assert.rejects(store.update(async () => { await new Store(root).update(state => { state.sources.push({ id: 'inner', title: 'Inner', text: 'x' }); }); }), { code: 'STORE_REENTRANT' });
  await store.update(state => { state.sources.push({ id: 'after', title: 'After', text: 'x' }); });
  assert.deepEqual((await store.read()).sources.map(source => source.id), ['after']);
});
