import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHostHandler, unverifiedModelStatus } from '../lib/host.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';

const PLUGIN = { edition: 'plugin', chat: true, agentTasks: false, landing: false };
const PREVIEW = { edition: 'preview', chat: false, agentTasks: false, landing: false };
const savedHome = process.env.DSH_HOME;
test.after(() => { if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome; });

async function session(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'study-host-contract-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { header: { cwd }, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) };
}

test('binding.get tells the UI what the DSH plugin host can do (plan C3)', async t => {
  const live = await session(t);
  const handler = createHostHandler({ sessions: { get: () => live } }, {}, () => async () => '{}');
  const bound = (await handler('call', { sessionId: 's', action: 'binding.get' })).value;
  assert.deepEqual(bound.host, PLUGIN);
});

test('another shell declares its own capabilities through the same handler', async t => {
  const live = await session(t);
  const standalone = { edition: 'standalone', chat: true, agentTasks: true, landing: true };
  const handler = createHostHandler({ sessions: { get: () => live } }, {}, () => async () => '{}', { capabilities: standalone });
  assert.deepEqual((await handler('call', { sessionId: 's', action: 'binding.get' })).value.host, standalone);
});

test('a host without a model registry reports the route unverified', () => {
  assert.deepEqual(unverifiedModelStatus(null), { ready: false, reason: 'no-route', label: '', provider: '', model: '' });
  assert.deepEqual(unverifiedModelStatus({ provider: 'preview', model: 'fake-model' }),
    { ready: true, reason: 'unknown', label: 'preview · fake-model', provider: 'preview', model: 'fake-model' });
});

async function preview(t, options) {
  const base = join(fileURLToPath(new URL('../', import.meta.url)), 'output', 'test-wp2');
  await mkdir(base, { recursive: true });
  const libraryRoot = await mkdtemp(join(base, 'lib-')), home = await mkdtemp(join(base, 'home-'));
  t.after(() => Promise.all([libraryRoot, home].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 3 }))));
  const server = await createPreviewServer({ libraryRoot, home, port: 0, ...options });
  t.after(() => server.close());
  return async (action, args = {}) => {
    const response = await fetch(server.url + '/api/call', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Study-Token': server.token }, body: JSON.stringify({ action, args }) });
    const body = await response.json();
    assert.equal(body.ok, true, body.error);
    return body.value;
  };
}

test('the preview answers the same contract as a preview edition', async t => {
  const call = await preview(t, { model: createFakeModel() });
  const bound = await call('binding.get');
  assert.deepEqual(bound.host, PREVIEW);
  assert.equal(bound.model, '', 'model stays the custom model id');
  const snapshot = await call('snapshot');
  const { session, ...status } = snapshot.model;
  assert.deepEqual(status, bound.modelStatus);
  assert.deepEqual(session, { provider: 'preview', model: 'fake-model', reasoningEffort: null }, 'the preview session follows its model');
  assert.equal(snapshot.modelReady, true);
  assert.equal(bound.modelStatus.ready, true);
});

test('a preview without a model shows the no-route state the UI must gate on', async t => {
  const call = await preview(t, { model: null });
  const bound = await call('binding.get');
  assert.equal(bound.modelStatus.reason, 'no-route');
  const snapshot = await call('snapshot');
  assert.equal(snapshot.modelReady, false);
  assert.deepEqual(snapshot.model, bound.modelStatus);
});
