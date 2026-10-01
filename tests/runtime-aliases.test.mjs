import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyRuntime } from '../lib/runtime.js';

test('public aliases choose an explicit provider and restore the standalone fallback on unload', async t => {
  for (const richerFirst of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'study-alias-'));
    const runtime = new StudyRuntime(root);
    t.after(async () => { runtime.dispose(); await rm(root, { recursive: true, force: true }); });
    const fallback = () => runtime.register({ id: 'documents', operations: { links: () => ({ available: false }) } });
    const richer = () => runtime.register({ id: 'questions', aliases: { 'documents.links': { operation: 'links', priority: 1 } },
      operations: { links: () => ({ available: true, links: ['question'] }) } });
    let unload;
    if (richerFirst) { unload = richer(); fallback(); } else { fallback(); unload = richer(); }
    assert.deepEqual(await runtime.call('documents.links'), { available: true, links: ['question'] });
    assert.deepEqual(await runtime.invoke('documents.v1', 'links'), { available: false }, 'qualified domain APIs retain their own implementation');
    assert.throws(() => runtime.register({ id: 'conflict', aliases: { 'documents.links': 'links' }, operations: { links: () => ({}) } }), /conflict/i);
    assert.equal(runtime.describe().some(domain => domain.id === 'conflict'), false, 'a conflict is atomic');
    unload();
    assert.deepEqual(await runtime.call('documents.links'), { available: false });
    const secondUnload = richer();
    runtime.disposeContext('documents');
    assert.equal((await runtime.call('documents.links')).available, true);
    secondUnload();
    await assert.rejects(runtime.call('documents.links'), /unavailable/i);
  }
});
