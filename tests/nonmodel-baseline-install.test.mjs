import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER_INSTALL, createMarkerInstaller, markerInstallStatePath, venvLayout } from '../lib/marker-install.js';
import { readMarkerSettings, saveMarkerSettings } from '../lib/marker-settings.js';
import { patientCli, until, writeJsonFile } from './helpers/wait.mjs';

/* S5-0 baseline of the Marker install (docs/plans/unified-job-runtime/s5-0-nonmodel-baseline.md): who may start it, that a refusal happens before any
   process or file exists, and which folders the installer owns. A fake python stands in for python/pip; nothing is downloaded. */

const FAKE_PYTHON = fileURLToPath(new URL('./helpers/fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));
const exists = async file => stat(file).then(() => true, () => false);

async function harness(t, py = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'nonmodel-install-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const statePath = join(dir, 'py-state.json'), log = join(dir, 'py-log.jsonl');
  await writeFile(statePath, JSON.stringify(py)); await writeFile(log, '');
  const env = { FAKE_PY_STATE: statePath, FAKE_PY_LOG: log };
  const options = { pythons: [patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env })], freeMegabytes: async () => 100_000,
    venvPython: folder => patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env: { ...env, FAKE_PY_VENV: venvLayout(folder).venv } }),
    markerCli: () => patientCli({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }) };
  const installer = createMarkerInstaller(options);
  t.after(async () => {
    await installer.cancel(); await installer.idle();
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, installer, options, setPy: patch => writeJsonFile(statePath, patch),
    pyLog: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    ended: status => until(async () => { const view = await installer.status(); return view.status === status && view; }, `the install to be ${status}`, { timeoutMs: 240_000 }) };
}

test('the assistant\'s study_workspace tool refuses install and uninstall before it parses anything, even with confirm: true; no state, folder or process follows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nonmodel-assistant-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const plugin = await import('../lib/index.js');
  const tools = [];
  const ctx = { tools: { register: tool => tools.push(tool) }, commands: { register: () => {} }, llm: {}, systemPrompt: { section: () => {} }, sessions: { get: () => undefined },
    get: name => name === 'connection' ? { fetch: { register: () => () => {} } } : undefined, inject: (_dependencies, fn) => fn(ctx), effect: fn => fn() };
  plugin.apply(ctx, {});
  const workspace = tools.find(tool => tool.name === 'study_workspace');
  const agent = { id: 'a', session: { header: { cwd: dir } } };
  for (const action of ['marker.install.start', 'marker.install.uninstall'])
    for (const payload_json of [JSON.stringify({ confirm: true, location: join(dir, 'anywhere') }), '{not json', undefined])
      await assert.rejects(workspace.execute({ action, ...(payload_json ? { payload_json } : {}) }, { agent }), /is not available to the assistant: it installs or removes software/, `${action} ${payload_json}`);
  assert.equal(await exists(join(dir, 'home')), false, 'no DSH home, state file or install folder was created');
  assert.equal(await exists(join(dir, 'anywhere')), false);
  const domainOperations = JSON.stringify(tools.map(tool => tool.parameters?.operation?.enum || []));
  assert.ok(!/marker\.install|mineru\./.test(domainOperations), 'no typed domain tool offers an install or a MinerU operation');
});

test('start and uninstall need confirm: true, and a refusal runs no process and writes no state', async t => {
  const h = await harness(t);
  for (const args of [{}, { confirm: 'yes' }, { confirm: 1 }]) {
    await assert.rejects(h.installer.start(args), error => error.code === 'need-confirm');
    await assert.rejects(h.installer.uninstall(args), error => error.code === 'need-confirm');
  }
  assert.deepEqual(await h.pyLog(), [], 'python was never started');
  assert.equal(await exists(markerInstallStatePath()), false);
  assert.equal(await exists(venvLayout(join(process.env.DSH_HOME, 'studyhub', 'marker')).folder), false);
  assert.equal((await h.installer.plan({})).ok, true, 'plan is read-only: it probes python, but starts no install');
  assert.ok((await h.pyLog()).every(line => /--version|"-c"/.test(line)), 'only version and venv probes ran');
  assert.equal(await exists(markerInstallStatePath()), false);
});

test('a failed or cancelled install leaves a folder the installer owns (its sentinel); uninstall removes only that, never a neighbour or a hand-set program path', async t => {
  const h = await harness(t, { failPip: true });
  const parent = join(h.dir, 'Tools'), folder = join(parent, 'marker'), own = join(h.dir, 'hand-set', 'marker_single');
  await mkdir(parent, { recursive: true }); await writeFile(join(parent, 'neighbour.txt'), 'keep');
  await saveMarkerSettings({ command: own });
  await h.installer.start({ confirm: true, location: folder }); await h.installer.idle();
  const failed = await h.installer.status();
  assert.equal(failed.status, 'failed'); assert.equal(failed.installed, false);
  assert.equal(await exists(venvLayout(folder).sentinel), true, 'the sentinel was written before the first command ran');
  assert.equal((await readMarkerSettings()).command, own, 'the configure stage never ran');
  const removed = await h.installer.uninstall({ confirm: true });
  assert.equal(removed.removed, 1); assert.equal(removed.status, 'idle');
  assert.equal(await exists(folder), false);
  assert.equal(await readFile(join(parent, 'neighbour.txt'), 'utf8'), 'keep');
  assert.equal((await readMarkerSettings()).command, own, 'a program path that is not inside the removed folder is kept');
  await h.setPy({ delayPip: true });
  await h.installer.start({ confirm: true, location: folder });
  await until(async () => (await h.installer.status()).log.some(line => /Collecting marker-pdf/.test(line)), 'pip to start', { timeoutMs: 240_000 });
  await h.installer.cancel(); await h.installer.idle();
  assert.equal((await h.installer.status()).status, 'cancelled');
  assert.equal(await exists(venvLayout(folder).sentinel), true, 'a cancelled install keeps its owned, partial folder until the learner uninstalls');
  assert.equal((await h.installer.uninstall({ confirm: true })).removed, 1);
  assert.deepEqual(await readdir(parent), ['neighbour.txt']);
});

test('only one install runs per DSH home, whichever installer object asks; a foreign non-empty folder is never installed into', async t => {
  const h = await harness(t, { delayPip: true });
  const foreign = join(h.dir, 'Foreign'); await mkdir(foreign); await writeFile(join(foreign, 'mine.txt'), 'keep');
  await h.installer.start({ confirm: true, location: foreign });
  await until(async () => (await h.installer.status()).log.some(line => /Collecting marker-pdf/.test(line)), 'pip to start', { timeoutMs: 240_000 });
  const other = createMarkerInstaller(h.options);
  await assert.rejects(other.start({ confirm: true }), error => error.code === 'busy');
  await assert.rejects(other.uninstall({ confirm: true }), error => error.code === 'busy');
  assert.equal((await other.status()).folder, join(foreign, MARKER_INSTALL.folderName), 'the run is shared through the state file path');
  await h.installer.cancel(); await h.installer.idle();
  assert.deepEqual((await readdir(foreign)).sort(), [MARKER_INSTALL.folderName, 'mine.txt']);
  assert.equal(await readFile(join(foreign, 'mine.txt'), 'utf8'), 'keep');
});
