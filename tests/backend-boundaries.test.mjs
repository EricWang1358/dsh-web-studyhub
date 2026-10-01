import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { StudyRuntime } from '../lib/runtime.js';
import { importExample } from '../ui/json-prompts.js';

test('retained task capabilities cannot enqueue work after their domain, owner or runtime is revoked', async t => {
  for (const revoke of ['domain', 'owner', 'runtime']) await t.test(revoke, async t => {
    const root = await mkdtemp(join(tmpdir(), 'study-revoked-task-'));
    const runtime = new StudyRuntime(root), owner = Symbol('request owner');
    t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
    let work, executions = 0;
    runtime.register({ id: 'extension', operations: { capture: (_args, context) => { work = context.work; return {}; } } });
    await runtime.call('extension.capture', {}, { workOwner: owner });
    if (revoke === 'domain') runtime.disposeContext('extension');
    else if (revoke === 'owner') runtime.cancelOwner(owner);
    else runtime.dispose();
    assert.throws(() => work.start({}, async () => { executions++; }), /unavailable|unloaded/);
    await Promise.resolve();
    assert.equal(executions, 0);
    assert.equal(runtime.work.jobs.size, 0);
  });
});

test('different runtimes for one root cannot observe or cancel one another’s publication work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-work-isolation-'));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reviewing = new Promise(resolve => { entered = resolve; });
  const first = createStudyRuntime(root, { complete: async () => { entered(); await gate; throw new Error('review unavailable'); } });
  const second = createStudyRuntime(root);
  t.after(async () => { release(); first.dispose(); second.dispose(); await rm(root, { recursive: true, force: true }); });
  const draft = await first.call('draft.import', { text: importExample('flashcard') });
  const job = await first.call('draft.publish.start', { id: draft.id, draftVersion: draft.draftVersion });
  await reviewing;
  assert.equal((await second.call('snapshot')).jobs.some(item => item.id === job.jobId), false);
  await assert.rejects(second.call('job.cancel', { jobId: job.jobId }), /not found|unavailable/i);
  release();
  const finished = await first.call('job.wait', { jobId: job.jobId, timeoutSeconds: 1 });
  assert.equal(finished.status, 'complete');
});

test('built-in dependency descriptions describe a directed acyclic graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-directed-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  const descriptions = runtime.describe(), graph = new Map(descriptions.map(domain => [domain.api, domain.dependencies]));
  const visited = new Set(), active = new Set();
  const visit = api => {
    assert.equal(active.has(api), false, `dependency cycle through ${api}`);
    if (visited.has(api)) return;
    active.add(api);
    for (const dependency of graph.get(api) || []) visit(dependency);
    active.delete(api); visited.add(api);
  };
  for (const api of graph.keys()) visit(api);
  assert.equal(descriptions.some(domain => domain.id === 'transition'), false);
});

test('an installed context does not grant an undeclared caller access to its operations or transaction participant', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-port-denial-'));
  const runtime = new StudyRuntime(root);
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  runtime.register({ id: 'owner', collections: ['ownedRecords'], operations: { read: { execute: async (_args, context) => (await context.state.read()).ownedRecords } } });
  runtime.registerParticipant('owner.v1', { name: 'owner.records', fields: ['ownedRecords'], validate: state => state.ownedRecords });
  runtime.register({ id: 'caller', operations: {
    read: { execute: (_args, context) => context.invoke('owner.v1', 'read') },
    update: { execute: (_args, context) => context.coordinate({}, (_state, checked) => checked, ['owner.records']) },
  } });
  await assert.rejects(runtime.call('caller.read'), /not declared/);
  await assert.rejects(runtime.call('caller.update'), /not declared/);
});

test('extension work is queued, deduplicated, cancellable and isolated to its runtime and owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-extension-work-'));
  const first = new StudyRuntime(root), second = new StudyRuntime(root);
  let release, releaseSibling;
  const gate = new Promise(resolve => { release = resolve; });
  const siblingGate = new Promise(resolve => { releaseSibling = resolve; });
  t.after(async () => { release(); releaseSibling(); first.dispose(); second.dispose(); await rm(root, { recursive: true, force: true }); });
  const order = [];
  const definition = id => ({ id, operations: {
    start: { execute: (args, context) => context.work.start({ queue: 'same-queue', key: args.key, label: args.key }, async ({ signal, progress }) => {
      order.push(args.key); progress({ stage: 'working' }); await (args.key === 'sibling' ? siblingGate : gate); signal.throwIfAborted(); return { completed: args.key };
    }) },
    list: { execute: (_args, context) => context.work.list() },
    cancel: { execute: (args, context) => context.work.cancel(args.id) },
    wait: { execute: (args, context) => context.work.wait(args.id) },
  } });
  first.register(definition('producer')); first.register(definition('sibling')); second.register(definition('producer'));
  const one = await first.call('producer.start', { key: 'first' });
  const replay = await first.call('producer.start', { key: 'first' });
  const two = await first.call('producer.start', { key: 'second' });
  assert.equal(one.id, replay.id);
  assert.deepEqual(order, ['first']);
  assert.deepEqual(await second.call('producer.list'), []);
  await assert.rejects(first.call('sibling.cancel', { id: one.id }), /not found|owned|unavailable/i);
  assert.equal((await first.call('producer.cancel', { id: two.id })).status, 'cancelled');
  release();
  assert.equal((await first.call('producer.wait', { id: one.id })).status, 'complete');
  assert.equal((await first.call('producer.wait', { id: two.id })).status, 'cancelled');
  assert.deepEqual(order, ['first'], 'explicit cancellation alone stops queued work while its context remains installed');
  const sibling = await first.call('sibling.start', { key: 'sibling' });
  first.disposeContext('producer');
  releaseSibling();
  const completed = await first.call('sibling.wait', { id: sibling.id });
  assert.equal(completed.status, 'complete');
  assert.deepEqual(order, ['first', 'sibling']);
});

test('live tasks execute FIFO and publish their progress before completion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-task-fifo-'));
  const runtime = new StudyRuntime(root), order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => { release(); runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  runtime.register({ id: 'producer', operations: {
    start: (args, context) => context.work.start({ queue: 'fifo' }, async ({ progress }) => {
      order.push(`start:${args.key}`);
      progress({ stage: 'Writing', done: 1, total: 2, phase: 'save' });
      if (args.key === 'first') await gate;
      order.push(`end:${args.key}`);
      return args.key;
    }),
    get: (args, context) => context.work.get(args.id),
    wait: (args, context) => context.work.wait(args.id),
  } });
  const first = await runtime.call('producer.start', { key: 'first' });
  const second = await runtime.call('producer.start', { key: 'second' });
  assert.equal(second.status, 'queued');
  const progress = await runtime.call('producer.get', { id: first.id });
  assert.deepEqual([progress.stage, progress.done, progress.total, progress.phase], ['Writing', 1, 2, 'save']);
  assert.deepEqual(order, ['start:first']);
  release();
  assert.equal((await runtime.call('producer.wait', { id: first.id })).status, 'complete');
  assert.equal((await runtime.call('producer.wait', { id: second.id })).status, 'complete');
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
});


test('task scopes isolate domains sharing one host owner and retain bounded finished history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-task-scope-'));
  const runtime = new StudyRuntime(root), workOwner = Symbol('shared host');
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const id of ['first', 'second']) runtime.register({ id, operations: {
    start: { execute: (_args, context) => context.work.start({}, async () => 'done') },
    list: { execute: (_args, context) => context.work.list() },
    wait: { execute: (args, context) => context.work.wait(args.id) },
    cancel: { execute: (args, context) => context.work.cancel(args.id) },
  } });
  const task = await runtime.call('first.start', {}, { workOwner });
  assert.deepEqual(await runtime.call('second.list', {}, { workOwner }), []);
  await assert.rejects(runtime.call('second.cancel', { id: task.id }, { workOwner }), /not found/i);
  await runtime.call('first.wait', { id: task.id }, { workOwner });
  for (let count = 0; count < 110; count++) {
    const next = await runtime.call('first.start', {}, { workOwner });
    await runtime.call('first.wait', { id: next.id }, { workOwner });
  }
  assert.ok((await runtime.call('first.list', {}, { workOwner })).length <= 100);
});
