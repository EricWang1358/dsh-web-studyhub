/* S6-1: the task service third-party extensions get (`context.work`, lib/runtime/tasks.js, kind `extension`) is a published API the unified runtime does not replace: its
   owner/domain isolation, its queues, its wait observers and what an unload does are held here, so the compatibility layer cannot be removed or "migrated" without a red test.
   No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskService } from '../lib/runtime/tasks.js';
import { jobContract } from '../lib/job-contract.js';
import { gate } from './helpers/model-family-baseline.mjs';

const registry = () => ({ jobs: new Map(), generationControllers: new Map(), settled: new Map() });
const owner = name => Symbol(name);

test('an extension task is a row of the shared job table, read as kind extension with the actions its kind can honestly offer', async () => {
  const shared = registry(), service = createTaskService('/lib', shared), work = service.scoped(owner('a'), 'ext.v1');
  const held = gate();
  const started = work.start({ label: 'Index my notes' }, async () => { await held.promise; return { done: true }; });
  assert.deepEqual([started.type, started.provider, started.label, started.status], ['extension', 'ext.v1', 'Index my notes', 'running']);
  assert.ok(shared.jobs.has(started.id) && shared.generationControllers.has(started.id), 'the console and job.cancel find it in the table');
  const contract = jobContract(shared.jobs.get(started.id));
  assert.equal(contract.kind, 'extension');
  assert.deepEqual([contract.actions.cancel.available, contract.actions.retry.available, contract.actions.pause.available, contract.actions.set.available], [true, false, false, false]);
  held.release();
  assert.deepEqual((await work.wait(started.id)).result, { done: true });
  assert.equal(work.get(started.id).status, 'complete');
});

test('another owner or another domain never sees, reads or stops it, and says the same thing for a task that does not exist', async () => {
  const service = createTaskService('/lib', registry()), mine = owner('mine'), theirs = owner('theirs');
  const work = service.scoped(mine, 'ext.v1'), stranger = service.scoped(theirs, 'ext.v1'), sibling = service.scoped(mine, 'other.v1');
  const held = gate();
  const { id } = work.start({ label: 'private' }, async () => { await held.promise; });
  for (const door of [stranger, sibling]) {
    assert.deepEqual(door.list(), []);
    for (const action of ['get', 'cancel']) assert.throws(() => door[action](id), /Task not found for this owner/);
    await assert.rejects(door.wait(id), /Task not found for this owner/);
  }
  assert.throws(() => work.get('no-such-task'), /Task not found for this owner/);
  held.release();
  await work.wait(id);
});

test('tasks of one queue run one after another, a different queue runs beside them, and a keyed task that is still active is the same task', async () => {
  const work = createTaskService('/lib', registry()).scoped(owner('q'), 'ext.v1'), order = [];
  const first = gate();
  const a = work.start({ queue: 'index' }, async () => { order.push('a:start'); await first.promise; order.push('a:end'); });
  const b = work.start({ queue: 'index' }, async () => { order.push('b'); });
  const c = work.start({ queue: 'other' }, async () => { order.push('c'); });
  assert.deepEqual([a.status, b.status, c.status], ['running', 'queued', 'running']);
  const again = work.start({ key: 'one-of-a-kind', queue: 'keyed' }, async () => { await first.promise; });
  assert.equal(work.start({ key: 'one-of-a-kind', queue: 'keyed' }, async () => {}).id, again.id, 'the same key while active answers with the running task');
  await work.wait(c.id);
  assert.deepEqual(order, ['a:start', 'c'], 'b waits for a');
  first.release();
  await work.wait(b.id);
  assert.deepEqual(order, ['a:start', 'c', 'a:end', 'b']);
});

test('wait with a timeout answers with the task as it stands, without ending or disturbing it; without one it answers when the task ends', async () => {
  const work = createTaskService('/lib', registry()).scoped(owner('w'), 'ext.v1');
  const held = gate();
  const { id } = work.start({}, async progress => { progress.progress({ stage: 'half way', done: 1, total: 2 }); await held.promise; });
  const early = await work.wait(id, { timeoutMs: 20 });
  assert.deepEqual([early.status, early.stage, early.done, early.total], ['running', 'half way', 1, 2]);
  assert.equal(work.get(id).status, 'running', 'the observer giving up changes nothing');
  held.release();
  assert.equal((await work.wait(id)).status, 'complete');
});

test('cancel: a queued task is cancelled at once and never runs; a running one is cancelling until its work lets go; a failure and a cancel are told apart', async () => {
  const work = createTaskService('/lib', registry()).scoped(owner('c'), 'ext.v1'), ran = [];
  const first = gate();
  const running = work.start({ queue: 'x' }, async ({ signal }) => { ran.push('running'); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); await first.promise; });
  const queued = work.start({ queue: 'x' }, async () => { ran.push('queued'); });
  await new Promise(resolve => setTimeout(resolve, 10)); // the first task has had its turn
  assert.equal(work.cancel(queued.id).status, 'cancelled');
  assert.equal(work.cancel(running.id).status, 'cancelling');
  first.release();
  assert.equal((await work.wait(running.id)).status, 'cancelled');
  await work.wait(queued.id);
  assert.deepEqual(ran, ['running'], 'the cancelled queued task never started');
  const failing = work.start({}, async () => { throw new Error('index is locked'); });
  const ended = await work.wait(failing.id);
  assert.deepEqual([ended.status, ended.stage], ['failed', 'index is locked']);
});

test('an unload stops what the owner (or the domain) started and nothing of anybody else, and the tasks settle as cancelled', async () => {
  const service = createTaskService('/lib', registry()), mine = owner('mine'), theirs = owner('theirs');
  const work = service.scoped(mine, 'ext.v1'), other = service.scoped(theirs, 'ext.v1'), sibling = service.scoped(mine, 'other.v1');
  const waits = signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  const a = work.start({}, async ({ signal }) => { await waits(signal); });
  const b = other.start({}, async ({ signal }) => { await waits(signal); });
  const c = sibling.start({}, async ({ signal }) => { await waits(signal); });
  service.cancelDomain('other.v1');
  assert.deepEqual([work.get(a.id).status, other.get(b.id).status, sibling.get(c.id).status], ['running', 'running', 'cancelling'], 'a domain unload touches only that domain');
  service.cancelOwner(mine);
  assert.deepEqual([work.get(a.id).status, other.get(b.id).status], ['cancelling', 'running'], 'an owner unload touches only that owner');
  await work.wait(a.id);
  assert.equal(work.get(a.id).status, 'cancelled');
  service.dispose();
  await other.wait(b.id);
  assert.equal(other.get(b.id).status, 'cancelled');
});
