import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostHandler } from '../lib/host.js';

/* WP28: the host handler gives each request's service the DSH tool registry as its retrieval port. */

test('the host panel can list and pick a retrieval tool that DSH exposes, and sees nothing when DSH exposes none', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wp28-host-'));
  const home = await mkdtemp(join(tmpdir(), 'wp28-home-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const disposers = [];
  const calls = [];
  const tool = { name: 'mcp__rag__query_documents', description: 'Semantic search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const ctx = { sessions: { get: () => ({ header: { cwd: root } }) }, get: () => undefined, effect: setup => disposers.push(setup()),
    tools: { schemas: () => [tool], execute: async input => { calls.push(input); return { isError: false, value: { content: [{ type: 'text', text: '[]' }] }, content: [] }; } } };
  t.after(async () => {
    for (const dispose of disposers.reverse()) dispose?.();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const handle = createHostHandler(ctx, { libraryRoot: root }, undefined, { owner: ctx });
  const call = (action, args = {}) => handle('call', { sessionId: 's1', action, args });
  const status = await call('retrieval.status');
  assert.equal(status.ok, true, status.error?.message);
  assert.equal(status.value.effective, 'builtin');
  assert.deepEqual(status.value.providers.map(provider => provider.id), ['mcp:mcp__rag__query_documents']);
  const picked = await call('retrieval.set', { provider: 'mcp:mcp__rag__query_documents' });
  assert.equal(picked.value.effective, 'mcp:mcp__rag__query_documents');
  const tested = await call('retrieval.test');
  assert.equal(tested.ok, true);
  assert.equal(tested.value.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'mcp__rag__query_documents');
  const ghost = await call('retrieval.set', { provider: 'mcp:mcp__ghost__search' });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error.code, 'retrieval-missing', 'a stable code the page can translate');
});
