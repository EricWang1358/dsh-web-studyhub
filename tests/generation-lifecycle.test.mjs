import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyRuntime } from '../lib/runtime.js';
import { createBuiltinEnvironment } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';
import { jobs, queues, settled } from '../lib/legacy-kernel.js';
import { importExample } from '../ui/json-prompts.js';
import { Context } from '@deepseek-ai/cordis';
import * as workbench from '../lib/index.js';
import * as generation from '../lib/plugins/generation.js';

test('shared workbench transport follows the remaining owner configuration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-host-owners-'));
  const ctx = new Context(), routes = [];
  ctx.provide('sessions', { get: () => ({ header: { cwd: directory } }) });
  ctx.provide('connection', { fetch: { register: route => { routes.push(route); return () => {}; } } });
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const first = ctx.plugin(workbench, { libraryRoot: join(directory, 'first') });
  await first;
  const secondRoot = join(directory, 'second');
  const second = ctx.plugin({ ...workbench, name: 'second-workbench-copy' }, { libraryRoot: secondRoot });
  await second;
  assert.equal(routes.length, 1);
  await first.dispose();
  const response = await routes[0].fetch(new Request('http://localhost/api/study-workspace/call', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      type: 'client-request', rpcId: 'binding', method: 'study-workspace/call',
      payload: { sessionId: 'test', action: 'binding.get' },
    }),
  }));
  const result = (await response.json()).result;
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.root, secondRoot);
  await second.dispose();
});

test('unloading generation cancels queued publication while leaving the independent bank usable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-generation-lifecycle-'));
  const runtime = new StudyRuntime(root);
  const environment = createBuiltinEnvironment(root, runtime);
  environment.install('bank'); environment.install('materials');
  const disposeGeneration = environment.install('generation');
  t.after(async () => { runtime.dispose(); queues.delete(root); await rm(root, { recursive: true, force: true }); });
  const draft = await runtime.call('draft.import', { text: importExample('flashcard') });
  let release;
  queues.set(root, new Promise(resolve => { release = resolve; }));
  const job = await runtime.call('draft.publish.start', { id: draft.id, draftVersion: draft.draftVersion });
  const done = settled.get(job.jobId);
  disposeGeneration();
  release(); await done;
  assert.equal(jobs.get(job.jobId).status, 'cancelled');
  assert.equal((await runtime.call('bank.list')).decks.length, 0);
  assert.equal((await new Store(root).read()).drafts.length, 1);
});

test('native transport publication is cancelled when its workbench unloads while the generation leaf survives', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'study-host-lifecycle-'));
  const root = join(directory, 'library');
  const ctx = new Context();
  const routes = [];
  const session = { header: { cwd: directory } };
  ctx.provide('sessions', { get: () => session });
  ctx.provide('connection', { fetch: { register: route => { routes.push(route); return () => {}; } } });
  t.after(async () => { await ctx.fiber.dispose(); queues.delete(root); await rm(directory, { recursive: true, force: true }); });
  const installed = ctx.plugin(workbench, { libraryRoot: root });
  await installed;
  const leaf = ctx.plugin(generation);
  await leaf;
  const call = async (action, args) => {
    const response = await routes[0].fetch(new Request('http://localhost/api/study-workspace/call', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        type: 'client-request', rpcId: action, method: 'study-workspace/call', payload: { sessionId: 'test', action, args },
      }),
    }));
    const result = (await response.json()).result;
    assert.equal(result.ok, true, result.error?.message);
    return result.value;
  };
  const draft = await call('draft.import', { text: importExample('flashcard') });
  let release;
  queues.set(root, new Promise(resolve => { release = resolve; }));
  const job = await call('draft.publish.start', { id: draft.id, draftVersion: draft.draftVersion });
  const done = settled.get(job.jobId);
  const leafInput = JSON.parse(importExample('flashcard'));
  leafInput.title = 'Independent leaf publication';
  leafInput.cards[0].prompt = 'Which dimensions can evolve independently?';
  leafInput.cards[0].objective = 'Explain independent leaf behavior';
  const leafRuntime = ctx.studyRuntime.forLibrary(root);
  const leafDraft = await leafRuntime.call('draft.import', { text: JSON.stringify(leafInput) });
  const leafJob = await leafRuntime.call('draft.publish.start', { id: leafDraft.id, draftVersion: leafDraft.draftVersion });
  const leafDone = settled.get(leafJob.jobId);
  await installed.dispose();
  release(); await done; await leafDone;
  assert.equal(jobs.get(job.jobId).status, 'cancelled');
  assert.equal(jobs.get(leafJob.jobId).status, 'complete', 'a different owner’s queued work must survive');
  assert.ok(ctx.studyRuntime.contextIds().includes('generation'));
  assert.equal((await ctx.studyRuntime.forLibrary(root).call('bank.list')).decks[0].id, leafDraft.id);
  assert.equal((await new Store(root).read()).drafts.length, 1);
});
