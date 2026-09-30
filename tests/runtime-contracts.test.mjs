import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyRuntime } from '../lib/runtime.js';
import { Store } from '../lib/store.js';

test('external context contributes owned state and operations without access to another context', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new StudyRuntime(root);
  const dispose = runtime.register({ id: 'extension', version: 1, collections: ['extensionRecords'], operations: {
    add: { input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      async execute(args, context) {
        assert.equal(context.store, undefined);
        assert.equal(context.service, undefined);
        return context.state.update(state => { state.extensionRecords.push({ id: args.text, text: args.text }); return { added: 1 }; });
      } },
    list: { execute: async (_args, context) => (await context.state.read()).extensionRecords },
  } });
  assert.deepEqual(await runtime.invoke('extension.v1', 'add', { text: 'hello' }), { added: 1 });
  assert.deepEqual(await runtime.invoke('extension.v1', 'list'), [{ id: 'hello', text: 'hello' }]);
  await assert.rejects(runtime.invoke('extension.v1', 'add', { text: 1 }), /text/);
  assert.throws(() => runtime.register({ id: 'extension', version: 2, operations: {} }), /conflict/i);
  dispose();
  await assert.rejects(runtime.invoke('extension.v1', 'list'), /unavailable/i);
  runtime.register({ id: 'extension', version: 1, collections: ['extensionRecords'], operations: { list: {
    execute: async (_args, context) => (await context.state.read()).extensionRecords,
  } } });
  assert.equal((await runtime.invoke('extension.v1', 'list')).length, 1);
});

test('context dependency calls are declared and capability descriptions contain schemas', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new StudyRuntime(root);
  runtime.register({ id: 'bank', version: 1, operations: { read: { execute: () => ({ value: 3 }) } } });
  runtime.register({ id: 'client', version: 1, dependencies: ['bank.v1'], operations: {
    read: { execute: (_args, context) => context.invoke('bank.v1', 'read') },
    forbidden: { execute: (_args, context) => context.invoke('secret.v1', 'read') },
  } });
  assert.deepEqual(await runtime.invoke('client.v1', 'read'), { value: 3 });
  await assert.rejects(runtime.invoke('client.v1', 'forbidden'), /not declared/);
  assert.ok(runtime.describe().some(domain => domain.api === 'client.v1' && domain.operations.some(op => op.name === 'read' && op.input)));
});

for (const failure of ['descriptor', 'scope']) test(`failed context ${failure} registration rolls back acquired collections and routes`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-runtime-registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new Store(root), runtime = new StudyRuntime(root, { storage });
  const before = [...storage.collections];
  const definition = { id: 'extension', collections: ['extensionRecords'], aliases: { 'old.extension': 'list' }, operations: {
    list: { execute: async (_args, context) => (await context.state.read()).extensionRecords },
  } };
  assert.throws(() => runtime.register({ ...definition,
    ...(failure === 'descriptor' ? { collections: ['extensionRecords', { name: 'brokenRecords', mode: 'invalid' }] }
      : { fields: ['../invalid'] }),
  }), failure === 'descriptor' ? /Invalid collection mode/ : /Invalid scoped state field/);
  assert.deepEqual([...storage.collections], before, 'a failed registration must leave persistence definitions unchanged');
  assert.deepEqual(runtime.describe(), []);
  assert.equal(runtime.hasAction('extension.list'), false);
  assert.equal(runtime.hasAction('old.extension'), false);
  await assert.rejects(runtime.call('old.extension'), /unavailable/);
  const dispose = runtime.register({ ...definition, collections: [{ name: 'extensionRecords', mode: 'whole' }] });
  assert.deepEqual(await runtime.call('old.extension'), []);
  assert.equal(storage.collections.get('extensionRecords').mode, 'whole');
  dispose();
  assert.deepEqual([...storage.collections], before);
});

test('cancellation while waiting for the library lock prevents a fresh coordinated write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-runtime-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new StudyRuntime(root);
  runtime.register({ id: 'extension', version: 1, collections: ['extensionRecords'], operations: {
    append: { execute: (args, context) => context.coordinate(args, state => {
      state.extensionRecords.push({ id: 'fresh' }); return { added: 1 };
    }) },
  } });
  let acquired, release;
  const locked = new Promise(resolve => { acquired = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const holding = new Store(root).update(async () => { acquired(); await gate; });
  await locked;
  const controller = new AbortController();
  const writing = runtime.invoke('extension.v1', 'append', {}, { signal: controller.signal });
  const rejected = assert.rejects(writing, /cancelled/);
  controller.abort(new Error('cancelled'));
  release(); await holding; await rejected;
  assert.equal((await new Store(root).read()).extensionRecords, undefined);
});

test('stale participant disposers leave a later registration intact and runtime disposal clears participants', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-runtime-participant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new StudyRuntime(root);
  const definition = { id: 'extension', version: 1, collections: ['extensionRecords'], operations: {
    read: { execute: (args, context) => context.coordinate(args, (_state, checked) => checked.evidence,
      ['evidence']) },
  } };
  const oldContext = runtime.register(definition);
  const oldParticipant = runtime.registerParticipant('extension.v1', { name: 'evidence', fields: ['extensionRecords'], validate: () => ({ value: 'old' }) });
  oldContext();
  runtime.register(definition);
  runtime.registerParticipant('extension.v1', { name: 'evidence', fields: ['extensionRecords'], validate: () => ({ value: 'new' }) });
  oldParticipant(); oldParticipant();
  assert.deepEqual(await runtime.invoke('extension.v1', 'read'), { value: 'new' });
  runtime.dispose();
  runtime.register(definition);
  runtime.registerParticipant('extension.v1', { name: 'evidence', fields: ['extensionRecords'], validate: () => ({ value: 'reloaded' }) });
  assert.deepEqual(await runtime.invoke('extension.v1', 'read'), { value: 'reloaded' });
});
