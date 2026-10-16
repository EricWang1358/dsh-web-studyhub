import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { MINERU_INSTALL, mineruInstallStatePath, mineruLayout } from '../lib/mineru-install.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { installHarness } from './helpers/mineru-install-harness.mjs';
import { makePdf } from './helpers/pdf.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';

/* The one-click local MinerU through the real service (mineru.install.* and mineru.local.*), with a local index, a fake uv and the fake mineru:
   nothing is downloaded and nothing real is installed. The same suite runs with the install as a Job (mineru-install-service.runtime.test.mjs). */

const runtime = SWITCH_MODE === 'runtime';
const exists = file => stat(file).then(() => true, () => false);

async function serviceHarness(t, options = {}) {
  const h = await installHarness(t, options);
  // No mineru of this computer can be found: the search path is an empty folder of the test.
  const before = { PATH: process.env.PATH, Path: process.env.Path };
  const bin = join(h.dir, 'bin');
  await mkdir(bin, { recursive: true });
  process.env.PATH = bin; if (process.env.Path !== undefined) process.env.Path = bin;
  const service = new StudyService(join(h.dir, 'library'), { mineru: { install: h.seams, limits: { windowPages: 50, livenessMs: 0 } },
    ...switchOptions(SWITCH_MODE, { paths: ['mineruInstall'] }) });
  t.after(async () => {
    await service.call('mineru.install.cancel').catch(() => {});
    await until(async () => (await service.call('mineru.install.status')).status !== 'running', 'the install to end', { timeoutMs: 120_000 }).catch(() => {});
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const call = (name, args) => service.call(name, args);
  const ended = status => until(async () => { const view = await call('mineru.install.status'); return view.status === status && view; }, `the install to be ${status}`, { timeoutMs: 120_000 });
  const installRows = async () => (await call('snapshot')).jobs.filter(job => job.type === (runtime ? 'mineru-install' : 'local-install'));
  return { ...h, service, call, ended, installRows, start: (args = {}) => call('mineru.install.start', { confirm: true, location: h.location, ...args }) };
}

test('the install actions write no library field, and the assistant-facing ones are known; a fresh machine reads not installed and the plan creates nothing', async t => {
  for (const action of ['mineru.install.plan', 'mineru.install.start', 'mineru.install.status', 'mineru.install.cancel', 'mineru.install.uninstall', 'mineru.local.status', 'mineru.local.start', 'mineru.local.stop'])
    assert.deepEqual(writesFor('audio', action), [], action);
  const h = await serviceHarness(t);
  const local = await h.call('mineru.local.status');
  assert.deepEqual([local.state, local.origin, local.install.status, local.lastError, local.external], ['not-installed', null, 'idle', null, null]);
  const plan = await h.call('mineru.install.plan', { location: h.location });
  assert.equal(plan.ok, true);
  assert.equal(plan.folder, h.location);
  assert.equal(plan.tier, 'basic');
  assert.equal(plan.commands.length, 6);
  assert.equal(await exists(h.location), false, 'a plan creates nothing');
  assert.equal(await exists(mineruInstallStatePath()), false);
  await assert.rejects(h.call('mineru.install.start', { location: h.location }), { code: 'need-confirm' });
});

test('one click installs: while it runs the status says installing without asking any mineru, the console lists it, and it ends ready with StudyHub\'s own install', async t => {
  const h = await serviceHarness(t, { uv: { delayPipMs: 1500 } });
  const started = await h.start();
  assert.equal(started.status, 'running');
  await until(async () => (await h.call('mineru.install.status')).stage === 'package', 'the package stage');
  const during = await h.call('mineru.local.status', { fresh: true });
  assert.equal(during.state, 'installing');
  assert.equal(during.install.status, 'running');
  const asked = (await h.mineruLog()).length;
  await h.call('mineru.local.status', { fresh: true });
  assert.equal((await h.mineruLog()).length, asked, 'nothing is asked of a mineru while it is being installed');
  const [row] = await h.installRows();
  assert.ok(row, 'the install is a row of the task console');
  if (!runtime) assert.deepEqual([row.tool, row.status, row.total], ['mineru', 'running', MINERU_INSTALL.stages.length]);
  const done = await h.ended('complete');
  assert.deepEqual([done.installed, done.installedFolder, done.tier, done.step, done.of], [true, h.location, 'basic', 6, 6]);
  const ready = await h.call('mineru.local.status', { fresh: true });
  assert.deepEqual([ready.state, ready.origin, ready.folder, ready.tier], ['ready', 'installed', h.location, 'basic']);
  if (!runtime) await until(async () => (await h.installRows())[0]?.status === 'complete', 'the console row to end');
  assert.equal(await h.noUserMineru(), true, 'nothing was written to ~/.mineru');
});

test('a PDF converts with the installed MinerU; while it converts, neither stop nor uninstall pulls the service from under it', async t => {
  const h = await serviceHarness(t);
  await h.start(); await h.ended('complete');
  const signal = join(h.dir, 'release');
  await h.setMineru({ total: 3, finishSignal: signal });
  const pdf = join(h.dir, 'Book.pdf'); await writeFile(pdf, await makePdf({ pages: 3 }));
  const { jobId } = await h.call('mineru.import', { path: pdf });
  await assert.rejects(h.call('mineru.local.stop'), { code: 'conversion-running' });
  await assert.rejects(h.call('mineru.install.uninstall', { confirm: true }), { code: 'conversion-running' });
  assert.equal((await h.mineruState()).running, true, 'the service still runs');
  await writeFile(signal, '');
  await until(async () => (await h.call('snapshot')).jobs.find(job => job.id === jobId)?.status === 'complete', 'the conversion');
  const stopped = await h.call('mineru.local.stop');
  assert.equal(stopped.state, 'server-stopped');
  assert.equal((await h.call('mineru.local.status', { fresh: true })).state, 'server-stopped');
});

test('a service that does not start says why on the status (the card\'s one fix), and a restart that works clears it', async t => {
  const h = await serviceHarness(t);
  await h.start(); await h.ended('complete');
  await h.call('mineru.local.stop');
  await h.setMineru({ portInUse: true });
  await assert.rejects(h.call('mineru.local.start'), { code: 'server-start-failed' });
  const failed = await h.call('mineru.local.status', { fresh: true });
  assert.equal(failed.state, 'server-stopped');
  assert.equal(failed.lastError.code, 'port-in-use');
  await h.setMineru({ portInUse: false, vcRuntime: true });
  await assert.rejects(h.call('mineru.local.start', { restart: true }));
  assert.equal((await h.call('mineru.local.status', { fresh: true })).lastError.code, 'vc-runtime');
  await h.setMineru({ vcRuntime: false });
  assert.equal((await h.call('mineru.local.start', { restart: true })).state, 'ready');
  assert.equal((await h.call('mineru.local.status', { fresh: true })).lastError, null);
});

test('each failure of a step ends the install with its code: the network, the models, the VC++ runtime, a port in use', async t => {
  const cases = [
    [{ uv: { failPip: true } }, 'network', 'package'],
    [{ mineru: { downloadFails: true, downloadError: 'model.onnx: checksum mismatch, the download was cut' } }, 'models-failed', 'models'],
    [{ mineru: { vcRuntime: true } }, 'vc-runtime', 'enable'],
    [{ mineru: { portInUse: true } }, 'port-in-use', 'enable'],
  ];
  for (const [options, code, stage] of cases) {
    const h = await serviceHarness(t, options);
    await h.start();
    const failed = await h.ended('failed');
    assert.deepEqual([failed.error.code, failed.stage], [code, stage], JSON.stringify(options));
    assert.equal((await h.call('mineru.local.status', { fresh: true })).install.error.code, code, 'the status carries the failure for the card');
    await h.call('mineru.install.uninstall', { confirm: true });
  }
});

test('a first install that stops at 启用本机服务 is fixed by the card\'s one button: the install starts again, skips the finished steps and ends ready', async t => {
  const h = await serviceHarness(t, { mineru: { portInUse: true } });
  await h.start();
  const failed = await h.ended('failed');
  assert.deepEqual([failed.error.code, failed.stage, failed.installedFolder], ['port-in-use', 'enable', '']);
  const local = await h.call('mineru.local.status', { fresh: true });
  assert.deepEqual([local.state, local.origin, local.external], ['not-installed', null, null], 'nothing else to stop: the fix is to start the install again');
  // A service start alone cannot help: no mineru is installed yet as far as the status knows.
  await assert.rejects(h.call('mineru.local.start', { restart: true }));
  await h.setMineru({ portInUse: false });
  const venvs = (await h.uvLog()).filter(entry => entry.args[0] === 'venv').length;
  // What the card's 修复 sends for an install that stopped: the same folder and tier.
  await h.call('mineru.install.start', { confirm: true, location: failed.folder, tier: failed.tier });
  const done = await h.ended('complete');
  assert.equal(done.installedFolder, h.location);
  assert.equal((await h.uvLog()).filter(entry => entry.args[0] === 'venv').length, venvs, 'the finished steps were skipped');
  assert.equal((await h.call('mineru.local.status', { fresh: true })).state, 'ready');
});

test('another mineru holding the port during a first install is offered, and 停止另一份 MinerU 并重试 stops it before the service starts', async t => {
  const freePort = 'const fs = require("fs"); const file = process.env.FAKE_MINERU_STATE; const state = JSON.parse(fs.readFileSync(file, "utf8")); state.portInUse = false; fs.writeFileSync(file, JSON.stringify(state)); console.log("server stopped");';
  let stops = 0;
  const h = await serviceHarness(t, { mineru: { portInUse: true }, extra: { external: { exe: 'X:\\Other\\mineru.exe' },
    externalCli: () => { stops += 1; return { file: process.execPath, prefix: ['-e', freePort], env: { FAKE_MINERU_STATE: join(h.dir, 'mineru-state.json') } }; } } });
  await h.start();
  const failed = await h.ended('failed');
  assert.equal(failed.error.code, 'port-in-use');
  assert.deepEqual((await h.call('mineru.local.status', { fresh: true })).external, { exe: 'X:\\Other\\mineru.exe', state: 'found' });
  await h.call('mineru.install.start', { confirm: true, location: failed.folder, tier: failed.tier, stopExternal: true });
  assert.equal((await h.ended('complete')).installedFolder, h.location);
  assert.equal(stops, 1, 'the other service was stopped once, before ours started');
});

test('cancel keeps what was downloaded; 继续安装 skips the finished steps; an uninstall removes only what StudyHub made', async t => {
  const h = await serviceHarness(t, { uv: { delayPipMs: 4000 } });
  await h.start();
  await until(async () => (await h.call('mineru.install.status')).stage === 'package', 'the package stage');
  if (runtime) await h.call('mineru.install.cancel');
  else {
    // The console's 停止 reaches the run: the legacy row has the run's controller.
    const [row] = await h.installRows();
    await h.call('job.cancel', { jobId: row.id });
  }
  const cancelled = await h.ended('cancelled');
  assert.deepEqual(cancelled.done, ['tools', 'python']);
  const layout = mineruLayout(h.location);
  assert.equal(await exists(layout.sentinel), true, 'the sentinel stays');
  assert.equal(await exists(layout.uv), true, 'the installer stays');
  await h.setUv({});
  const venvs = (await h.uvLog()).filter(entry => entry.args[0] === 'venv').length;
  await h.start();
  await h.ended('complete');
  assert.equal((await h.uvLog()).filter(entry => entry.args[0] === 'venv').length, venvs, 'Python is not prepared again');
  await writeFile(join(h.location, 'mine.txt'), 'the learner\'s own file');
  const removed = await h.call('mineru.install.uninstall', { confirm: true });
  assert.equal(removed.removed, 1);
  assert.equal(await exists(join(h.location, 'mine.txt')), true, 'a file StudyHub did not make stays');
  for (const child of MINERU_INSTALL.children) assert.equal(await exists(join(h.location, child)), false, child);
  assert.equal((await h.call('mineru.local.status', { fresh: true })).state, 'not-installed');
});
