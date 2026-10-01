import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyRuntime } from '../lib/runtime.js';
import { createStatePort } from '../lib/runtime/state-port.js';

test('composed reads keep one committed revision while preserving authorized owner projections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-read-snapshot-'));
  const runtime = new StudyRuntime(root);
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  let interleave = true;
  runtime.register({ id: 'left', collections: ['leftRecords'], operations: { 'state.read': async (_args, context) => {
    const value = await context.state.read();
    if (interleave) {
      interleave = false;
      await runtime.storage.update(state => { state.leftRecords[0].version++; state.rightRecords[0].version++; });
    }
    return { leftRecords: value.leftRecords, leftRevision: value.revision, ownerTag: 'left projection' };
  } } });
  runtime.register({ id: 'right', collections: ['rightRecords'], operations: {
    'state.read': async (_args, context) => { const value = await context.state.read(); return { rightRecords: value.rightRecords, rightRevision: value.revision }; },
  } });
  await runtime.storage.update(state => { state.leftRecords = [{ id: 'l', version: 0 }]; state.rightRecords = [{ id: 'r', version: 0 }]; });
  runtime.register({ id: 'view', dependencies: ['left.v1', 'right.v1'], grants: { 'left.v1': ['state.read'], 'right.v1': ['state.read'] },
    operations: { read: (_args, context) => createStatePort(root, context, { reads: ['left.v1', 'right.v1'], defaults: {} }).read() } });
  const value = await runtime.call('view.read');
  assert.equal(value.leftRecords[0].version, 0);
  assert.equal(value.rightRecords[0].version, 0);
  assert.equal(value.leftRevision, value.rightRevision);
  assert.equal(value.ownerTag, 'left projection');
  assert.equal((await runtime.storage.read()).rightRecords[0].version, 1, 'the concurrent commit still completes');
});

test('committed read sessions enforce dependencies, grants and readonly owner APIs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-read-authority-'));
  const runtime = new StudyRuntime(root);
  t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  runtime.register({ id: 'owner', collections: ['records'], operations: {
    'state.read': async (_args, context) => {
      await context.state.update(state => { state.records = [{ id: 'unexpected' }]; });
      return context.state.read();
    },
  } });
  runtime.register({ id: 'undeclared', operations: { read: (_args, context) => context.readSnapshot(['owner.v1']) } });
  runtime.register({ id: 'ungranted', dependencies: ['owner.v1'], grants: { 'owner.v1': ['other'] },
    operations: { read: (_args, context) => context.readSnapshot(['owner.v1']) } });
  runtime.register({ id: 'allowed', dependencies: ['owner.v1'], grants: { 'owner.v1': ['state.read'] },
    operations: { read: (_args, context) => context.readSnapshot(['owner.v1']) } });
  await runtime.storage.update(state => { state.records = []; });
  await assert.rejects(runtime.call('undeclared.read'), /not declared/);
  await assert.rejects(runtime.call('ungranted.read'), /not granted/);
  await assert.rejects(runtime.call('allowed.read'), /snapshot is read-only/);
  assert.deepEqual((await runtime.storage.read()).records, []);
});
