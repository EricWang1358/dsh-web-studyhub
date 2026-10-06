import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as workbench from '../lib/index.js';
import { createHostHandler, serviceFor, servicesForHost } from '../lib/host.js';
import { until } from './helpers/wait.mjs';

// S1-2 preflight: characterize the existing StudyHub composition, not a v2
// executor. Session/model services below are doubles; Cordis and StudyHub are real.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 's12-'));
  const root = new Context();
  const sessions = new Map();
  root.provide('sessions', { get: id => sessions.get(id) });
  root.provide('llm', {});
  const installed = root.plugin(workbench);
  await installed;
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  const host = root[Symbol.for('studyhub.workbench.host.v1')];
  assert.ok(host?.fiber?.ctx, 'production workbench fiber must be installed');
  const agent = id => {
    const session = { header: { cwd: directory }, requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }) };
    sessions.set(id, session);
    return { id, session };
  };
  return { directory, root, sessions, installed, host, agent };
}

test('S1-2 baseline: actual workbench fiber owns shared library work across session facades', async t => {
  const { directory, root, host, agent } = await fixture(t);
  const first = agent('first'), second = agent('second');
  const owner = host.fiber.ctx;
  assert.equal(servicesForHost(owner), host.services);
  const makeComplete = () => async () => { throw new Error('No model calls in ownership audit'); };
  const a = await serviceFor(root, {}, directory, first.session, makeComplete, first.id, undefined, owner);
  const b = await serviceFor(root, {}, directory, second.session, makeComplete, second.id, undefined, owner);
  assert.equal(a.runtime, b.runtime);
  assert.equal(a.runtime, root.studyRuntime.runtimeForLibrary(a.store.root));
  assert.equal(a.modelOptions.workOwner, host.services.workOwner);
  assert.equal(b.modelOptions.workOwner, a.modelOptions.workOwner);
  assert.equal(a.modelOptions.audioGate, b.modelOptions.audioGate);
  assert.equal(typeof a.modelOptions.workOwner, 'symbol');
  const toolServices = await root.studyRuntime.requestServices({ agent: first });
  assert.equal(toolServices.workOwner, a.modelOptions.workOwner);
  assert.equal(toolServices.audioGate, a.modelOptions.audioGate);
  assert.equal(toolServices.sessionId, first.id);
  assert.equal(toolServices.executor, undefined, 'v1 does not provide a verified DSH executor binding');
});

test('S1-2 baseline: cold panel reads saved workspace without activating a host Agent', async t => {
  const { directory, root, host } = await fixture(t);
  let activations = 0;
  root.provide('agents', { get: () => undefined, create: () => { activations++; throw new Error('Unexpected activation'); } });
  root.provide('sessionPersistence', { stat: async id => id === 'cold' ? { header: { cwd: directory }, revision: 'saved' } : undefined });
  const handle = createHostHandler(root, {}, undefined, { owner: host.fiber.ctx });
  const response = await handle('call', { sessionId: 'cold', action: 'source.list' });
  assert.equal(response.ok, true);
  assert.equal(root.agents.get('cold'), undefined);
  assert.equal(root.sessions.get('cold'), undefined);
  assert.equal(activations, 0);
  const missing = await handle('call', { sessionId: 'unknown', action: 'source.list' });
  assert.equal(missing.ok, false);
  assert.equal(activations, 0);
});

test('S1-2 baseline: workbench unload signals held extension work before it physically settles', async t => {
  const { directory, root, installed, host, agent } = await fixture(t);
  const session = agent('held');
  const facade = await serviceFor(root, {}, directory, session.session, undefined, session.id, undefined, host.fiber.ctx);
  const runtime = facade.runtime;
  let release, executionSignal, port;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  runtime.register({ id: 'owner-probe', operations: {
    start: (_args, context) => {
      port = context.work;
      return port.start({}, async ({ signal }) => { executionSignal = signal; await held; return 'late'; });
    },
  } });
  const task = await runtime.call('owner-probe.start', {}, { workOwner: host.services.workOwner });
  await until(() => executionSignal, 'held extension executor to start');
  const waiting = port.wait(task.id);
  await installed.dispose();
  assert.equal(executionSignal.aborted, true);
  assert.equal(port.get(task.id).status, 'cancelling');
  assert.equal(runtime.work.settled.has(task.id), true, 'physical work is still held after fiber disposal');
  assert.throws(() => port.start({}, async () => 'wrong'), /unavailable|unloaded|disposed/i);
  release();
  assert.equal((await waiting).status, 'cancelled');
  assert.equal(runtime.work.settled.has(task.id), false);
});
