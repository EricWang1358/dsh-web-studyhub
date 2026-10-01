import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyRuntime } from '../lib/runtime.js';
import { Store } from '../lib/store.js';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-transaction-isolation-'));
  const store = new Store(root), runtime = new StudyRuntime(root, { storage: store });
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  return { runtime, store };
}

test('borrowed transaction drafts reject nested read-only mutations without changing committed state', async t => {
  const { runtime, store } = await fixture(t);
  runtime.register({ id: 'reader', collections: ['readerRecords'], dependencies: ['evidence.v1'],
    transactions: { tamper: ['evidence.records'] }, operations: {
      tamper: (_args, context) => context.transaction(state => { state.evidenceRecords[0].nested.value = 'tampered'; }, ['evidence.records'], ['readerRecords']),
    } });
  runtime.register({ id: 'evidence', collections: ['evidenceRecords'] });
  runtime.registerParticipant('evidence.v1', { name: 'evidence.records', fields: ['evidenceRecords'], validate: state => state });
  await store.update(state => { state.evidenceRecords = [{ id: 'record', nested: { value: 'original' } }]; });
  await assert.rejects(runtime.call('reader.tamper'), /read-only/);
  assert.equal((await store.read()).evidenceRecords[0].nested.value, 'original');
});

test('unloaded and reinstalled contexts cannot publish captured late state callbacks', async t => {
  const { runtime, store } = await fixture(t);
  let captured;
  const dispose = runtime.register({ id: 'extension', collections: ['extensionRecords'], operations: {
    capture: (_args, context) => { captured = () => context.state.update(state => { state.extensionRecords.push({ id: 'late' }); }); return {}; },
  } });
  await runtime.call('extension.capture');
  dispose();
  runtime.register({ id: 'extension', collections: ['extensionRecords'] });
  await assert.rejects(captured(), /Capability unavailable/);
  assert.equal((await store.read()).extensionRecords?.length || 0, 0);
});

test('host cancellation during an async state update prevents its late commit and preserves sibling writes', async t => {
  const { runtime, store } = await fixture(t);
  const entered = gate(), release = gate(), owner = Symbol('host');
  runtime.register({ id: 'extension', collections: ['extensionRecords'], operations: {
    slow: (_args, context) => context.state.update(async state => {
      state.extensionRecords.push({ id: 'late' }); entered.resolve(); await release.promise;
    }),
    save: (_args, context) => context.state.update(state => { state.extensionRecords.push({ id: 'sibling' }); return state.extensionRecords; }),
  } });
  const pending = runtime.call('extension.slow', {}, { workOwner: owner });
  await entered.promise;
  await runtime.cancelOwner(owner); release.resolve();
  await assert.rejects(pending, /Work owner unloaded/);
  const result = await runtime.call('extension.save', {}, { workOwner: Symbol('sibling') });
  result[0].id = 'mutated response';
  assert.deepEqual((await store.read()).extensionRecords, [{ id: 'sibling' }]);
});
