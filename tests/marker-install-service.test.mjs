import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { venvLayout } from '../lib/marker-install.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';

/* The marker.install.* actions through the real service, with a fake python and no network. */
const FAKE_PYTHON = fileURLToPath(new URL('./helpers/fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));

async function harness(t, py = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'marker-install-service-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const statePath = join(dir, 'py.json'); await writeFile(statePath, JSON.stringify(py));
  const env = { FAKE_PY_STATE: statePath };
  const install = { pythons: [{ file: process.execPath, prefix: [FAKE_PYTHON], env }], freeMegabytes: async () => 100_000,
    venvPython: folder => ({ file: process.execPath, prefix: [FAKE_PYTHON], env: { ...env, FAKE_PY_VENV: venvLayout(folder).venv } }),
    markerCli: () => ({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }) };
  const service = new StudyService(join(dir, 'library'), { marker: { install } });
  t.after(async () => {
    await service.call('marker.install.cancel'); await new Promise(resolve => setTimeout(resolve, 50)); service.dispose();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, call: (name, args) => service.call(name, args),
    until: async condition => { for (let i = 0; i < 6000; i++) { const value = await condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out'); } };
}

test('install actions are registered, write no library field, and run end to end', async t => {
  for (const action of ['plan', 'start', 'status', 'cancel', 'uninstall']) assert.deepEqual(writesFor('audio', `marker.install.${action}`), [], action);
  const h = await harness(t);
  assert.equal((await h.call('marker.install.status')).status, 'idle');
  const plan = await h.call('marker.install.plan', { mirror: 'tsinghua' });
  assert.equal(plan.ok, true); assert.equal(plan.mirror, 'tsinghua');
  await assert.rejects(h.call('marker.install.start', { mirror: 'tsinghua' }), /confirm/);
  const started = await h.call('marker.install.start', { confirm: true, mirror: 'tsinghua' });
  assert.equal(started.status, 'running');
  const done = await h.until(async () => { const view = await h.call('marker.install.status'); return view.status === 'complete' && view; });
  assert.equal((await h.call('marker.settings.get')).command, done.command);
  assert.equal(done.installed, true);
  const gone = await h.call('marker.install.uninstall', { confirm: true });
  assert.equal(gone.status, 'idle');
  assert.equal((await h.call('marker.settings.get')).command, '');
});

test('cancel and a failed install through the service', async t => {
  const h = await harness(t, { delayPip: true });
  await h.call('marker.install.start', { confirm: true });
  await h.until(async () => (await h.call('marker.install.status')).log.some(line => /Collecting/.test(line)));
  await h.call('marker.install.cancel');
  assert.equal((await h.until(async () => { const view = await h.call('marker.install.status'); return view.status === 'cancelled' && view; })).error.code, 'cancelled');
});
