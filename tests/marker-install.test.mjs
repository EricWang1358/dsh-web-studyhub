import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKER_INSTALL, MarkerInstallError, createMarkerInstaller, defaultMarkerFolder, venvLayout } from '../lib/marker-install.js';
import { readMarkerSettings, saveMarkerSettings } from '../lib/marker-settings.js';
import { patientCli, until, writeJsonFile } from './helpers/wait.mjs';

/* One-click Marker install, with no network: a fake python makes the folders and a fake pip writes a fake marker_single. */
const FAKE_PYTHON = fileURLToPath(new URL('./helpers/fake-python.mjs', import.meta.url));
const FAKE_MARKER = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));

async function harness(t, { py = {}, free = 100_000, noPython = false, pythons } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'marker-install-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const statePath = join(dir, 'py-state.json'), log = join(dir, 'py-log.jsonl');
  await writeFile(statePath, JSON.stringify(py)); await writeFile(log, '');
  const env = { FAKE_PY_STATE: statePath, FAKE_PY_LOG: log };
  // (starting a Node process takes seconds on a machine busy with other work: the installer's own per-command limits are stretched, not removed)
  const python = patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env });
  const options = { pythons: noPython ? [{ file: join(dir, 'no-such-python') }] : pythons ?? [python], freeMegabytes: async () => options.free,
    venvPython: folder => patientCli({ file: process.execPath, prefix: [FAKE_PYTHON], env: { ...env, FAKE_PY_VENV: venvLayout(folder).venv } }),
    markerCli: () => patientCli({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }), free };
  const installer = createMarkerInstaller(options);
  t.after(async () => { await installer.cancel(); await installer.idle(); if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { dir, installer, options, env, python, setPy: patch => writeJsonFile(statePath, patch),
    pyLog: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }),
    until: condition => until(condition, 'the installer', { timeoutMs: 240_000 }) };
}
const exists = async file => stat(file).then(() => true, () => false);

test('plan: a usable Python, free space and a writable default folder under the DSH home', async t => {
  const h = await harness(t, { py: { version: '3.11.4' } });
  const plan = await h.installer.plan({});
  assert.equal(plan.ok, true); assert.deepEqual(plan.problems, []);
  assert.equal(plan.python.version, '3.11.4');
  assert.equal(plan.folder, defaultMarkerFolder());
  assert.equal(plan.folder, join(process.env.DSH_HOME, 'studyhub', 'marker'));
  assert.ok(plan.disk.freeMb >= plan.disk.neededMb);
  assert.ok(plan.estimate.downloadMb > 0 && plan.estimate.minutes.length === 2);
  assert.deepEqual(plan.mirrors.map(m => [m.id, m.reach]), [['tsinghua', 'mainland'], ['official', 'overseas']]);
  assert.equal(plan.channels, undefined, 'download channels are only offered when Python is missing');
  assert.ok(plan.commands.some(item => item.stage === 'create-venv' && /-m venv/.test(item.command)));
  assert.ok(plan.commands.some(item => item.stage === 'install' && /pip install/.test(item.command) && /marker-pdf/.test(item.command)));
  assert.ok(plan.commands.some(item => item.stage === 'install' && item.command.endsWith(' "marker-pdf>=1.10,<2"')), 'the command shown is the one run, quoted for a shell');
  assert.equal(await exists(plan.folder), false, 'a plan creates nothing');
});

test('plan: missing Python is not a failure but returns mainland and official download channels', async t => {
  const h = await harness(t, { noPython: true });
  const plan = await h.installer.plan({});
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.problems.map(p => p.code), ['python-missing']);
  assert.equal(plan.python, null);
  assert.ok(plan.channels.some(c => c.reach === 'mainland' && /^https:/.test(c.url)));
  assert.ok(plan.channels.some(c => c.id === 'official' && /python\.org/.test(c.url) && c.reach === 'overseas'));
  assert.equal(plan.minPython, '3.10');
});

test('plan: a Python older than marker-pdf needs is reported, and a newer one among the candidates is used', async t => {
  const h = await harness(t, { py: { version: '3.8.10' } });
  const old = await h.installer.plan({});
  assert.deepEqual(old.problems.map(p => p.code), ['python-too-old']);
  assert.ok(old.channels.length > 0);
  const newer = { ...h.python, env: { ...h.env, FAKE_PY_STATE: join(h.dir, 'py-new.json') } };
  await writeFile(newer.env.FAKE_PY_STATE, JSON.stringify({ version: '3.12.1' }));
  const both = createMarkerInstaller({ ...h.options, pythons: [h.python, newer] });
  const plan = await both.plan({});
  assert.equal(plan.ok, true); assert.equal(plan.python.version, '3.12.1');
});

test('plan: a Python without venv support is a coded problem', async t => {
  const h = await harness(t, { py: { noVenvModule: true } });
  assert.deepEqual((await h.installer.plan({})).problems.map(p => p.code), ['no-venv']);
});

test('plan: too little free space, an unusable location and a foreign folder', async t => {
  const h = await harness(t, { free: 100 });
  assert.deepEqual((await h.installer.plan({})).problems.map(p => p.code), ['no-space']);
  h.options.free = 100_000;
  assert.deepEqual((await h.installer.plan({ location: 'relative/folder' })).problems.map(p => p.code), ['bad-location']);
  const file = join(h.dir, 'a-file.txt'); await writeFile(file, 'x');
  assert.deepEqual((await h.installer.plan({ location: file })).problems.map(p => p.code), ['bad-location']);
  // A folder with someone else's files in it is never installed into: the installer works in a StudyHub-Marker folder inside it.
  const foreign = join(h.dir, 'Tools'); await mkdir(foreign); await writeFile(join(foreign, 'mine.txt'), 'keep');
  const plan = await h.installer.plan({ location: foreign });
  assert.equal(plan.ok, true); assert.equal(plan.adjusted, true);
  assert.equal(plan.folder, join(foreign, MARKER_INSTALL.folderName));
  const empty = join(h.dir, 'Empty'); await mkdir(empty);
  assert.equal((await h.installer.plan({ location: empty })).folder, empty);
  assert.equal((await h.installer.plan({ location: join(h.dir, 'new', 'deeper') })).ok, true, 'a folder that does not exist yet is created');
  await assert.rejects(h.installer.plan({ mirror: 'nope' }), /没有这个下载源/);
});

test('install: create-venv, pip install, verify, write the program path; the state survives a restart', async t => {
  const h = await harness(t);
  await assert.rejects(h.installer.start({}), error => error instanceof MarkerInstallError && error.code === 'need-confirm');
  const started = await h.installer.start({ confirm: true, mirror: 'tsinghua' });
  assert.equal(started.status, 'running'); assert.equal(started.mirror, 'tsinghua');
  await h.installer.idle();
  const done = await h.installer.status();
  assert.equal(done.status, 'complete', JSON.stringify(done.error));
  const layout = venvLayout(defaultMarkerFolder());
  assert.equal(done.command, layout.marker);
  assert.equal(done.installed, true); assert.equal(done.needsModels, true);
  assert.equal((await readMarkerSettings()).command, layout.marker, 'the configured program is the environment marker_single');
  assert.equal(await exists(layout.marker), true);
  assert.ok(await exists(layout.sentinel));
  const calls = (await h.pyLog()).map(args => args.join(' '));
  assert.ok(calls.some(line => line.startsWith('-m venv ')), 'the environment is created first');
  const pip = calls.find(line => line.includes('pip install'));
  assert.match(pip, /--index-url https:\/\/pypi\.tuna\.tsinghua\.edu\.cn\/simple/);
  // marker-pdf 2.x needs Docker for its OCR server: the install asks pip for the 1.x line (one argument, no shell).
  assert.match(pip, / marker-pdf>=1\.10,<2$/);
  assert.ok(calls.indexOf(calls.find(line => line.startsWith('-m venv '))) < calls.indexOf(pip));
  assert.ok(done.log.some(line => /Successfully installed/.test(line)));
  assert.ok(done.log.some(line => line.startsWith('== verify')));
  // A new installer (a restart) reads the result from disk.
  const again = createMarkerInstaller(h.options);
  const restored = await again.status();
  assert.equal(restored.status, 'complete'); assert.equal(restored.command, layout.marker); assert.ok(restored.log.length > 3);
  // The official index is used when no mirror is asked for.
  await h.installer.uninstall({ confirm: true });
  await h.installer.start({ confirm: true }); await h.installer.idle();
  assert.doesNotMatch((await h.pyLog()).map(args => args.join(' ')).filter(line => line.includes('pip install')).at(-1), /--index-url/);
});

test('install: a custom folder is used and the first conversion note is part of the result', async t => {
  const h = await harness(t);
  const custom = join(h.dir, 'My Tools', 'marker');
  await h.installer.start({ confirm: true, location: custom }); await h.installer.idle();
  const done = await h.installer.status();
  assert.equal(done.status, 'complete'); assert.equal(done.folder, custom);
  assert.equal((await readMarkerSettings()).command, venvLayout(custom).marker);
});

test('install: missing Python refuses to start and starts nothing', async t => {
  const h = await harness(t, { noPython: true });
  await assert.rejects(h.installer.start({ confirm: true }), error => error.code === 'python-missing');
  assert.equal((await h.installer.status()).status, 'idle');
  assert.equal(await exists(defaultMarkerFolder()), false);
});

test('install: only one at a time', async t => {
  const h = await harness(t, { py: { delayPip: true } });
  await h.installer.start({ confirm: true });
  await assert.rejects(h.installer.start({ confirm: true }), error => error.code === 'busy');
  await assert.rejects(h.installer.uninstall({ confirm: true }), error => error.code === 'busy');
  await h.installer.cancel(); await h.installer.idle();
});

test('cancel: stops the running pip, keeps the log, writes no path, and the install can be retried', async t => {
  const h = await harness(t, { py: { delayPip: true } });
  await h.installer.start({ confirm: true });
  await h.until(async () => (await h.installer.status()).log.some(line => /Collecting marker-pdf/.test(line)));
  const cancelled = await h.installer.cancel(); assert.ok(['running', 'cancelled'].includes(cancelled.status));
  await h.installer.idle();
  const after = await h.installer.status();
  assert.equal(after.status, 'cancelled'); assert.equal(after.error.code, 'cancelled');
  assert.ok(after.log.some(line => /Collecting marker-pdf/.test(line)));
  assert.equal((await readMarkerSettings()).command, '');
  assert.equal(after.installed, false);
  await h.setPy({});
  await h.installer.start({ confirm: true }); await h.installer.idle();
  assert.equal((await h.installer.status()).status, 'complete');
});

test('failure: the reason in plain words, the raw log kept, the path untouched, retry works', async t => {
  const h = await harness(t, { py: { failPip: true } });
  await h.installer.start({ confirm: true }); await h.installer.idle();
  const failed = await h.installer.status();
  assert.equal(failed.status, 'failed'); assert.equal(failed.stage, 'install');
  assert.equal(failed.error.code, 'network');
  assert.match(failed.error.message, /网络/);
  assert.ok(failed.log.some(line => /Could not find a version/.test(line)), 'the raw pip output is kept');
  assert.ok(failed.log.length <= MARKER_INSTALL.logLines);
  assert.equal((await readMarkerSettings()).command, '');
  const restored = await createMarkerInstaller(h.options).status();
  assert.equal(restored.status, 'failed'); assert.ok(restored.log.length);
  await h.setPy({});
  const retry = await h.installer.start({ confirm: true, mirror: 'tsinghua' }); assert.equal(retry.status, 'running');
  await h.installer.idle();
  assert.equal((await h.installer.status()).status, 'complete');
});

test('failure: disk full, permission and venv problems get their own reasons', async t => {
  const h = await harness(t, { py: { failPip: true, pipError: 'OSError: [Errno 28] No space left on device' } });
  await h.installer.start({ confirm: true }); await h.installer.idle();
  assert.equal((await h.installer.status()).error.code, 'no-space');
  await h.setPy({ failPip: true, pipError: 'PermissionError: [WinError 5] Access is denied' });
  await h.installer.start({ confirm: true }); await h.installer.idle();
  assert.equal((await h.installer.status()).error.code, 'not-writable');
  await h.setPy({ failVenv: true });
  await h.installer.start({ confirm: true }); await h.installer.idle();
  const failed = await h.installer.status();
  assert.equal(failed.error.code, 'venv-failed'); assert.equal(failed.stage, 'create-venv');
});

test('failure: a program that does not pass detection is not configured', async t => {
  const h = await harness(t);
  h.options.markerCli = () => ({ file: process.execPath, prefix: ['-e', 'console.log("--help only")'], env: {} });
  await h.installer.start({ confirm: true }); await h.installer.idle();
  const failed = await h.installer.status();
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'verify-failed');
  assert.equal((await readMarkerSettings()).command, '');
});

test('a run that was live when the app stopped is shown as interrupted, with its log', async t => {
  const h = await harness(t);
  const { markerInstallStatePath } = await import('../lib/marker-install.js');
  await mkdir(join(process.env.DSH_HOME, 'study'), { recursive: true });
  await writeFile(markerInstallStatePath(), JSON.stringify({ status: 'running', stage: 'install', folder: defaultMarkerFolder(), log: ['Collecting x'] }));
  const view = await h.installer.status();
  assert.equal(view.status, 'interrupted'); assert.equal(view.error.code, 'interrupted'); assert.deepEqual(view.log, ['Collecting x']);
});

test('uninstall removes only the environment the installer created and clears the path', async t => {
  const h = await harness(t);
  const parent = join(h.dir, 'Tools'), folder = join(parent, 'marker');
  await mkdir(parent, { recursive: true }); await writeFile(join(parent, 'neighbour.txt'), 'keep');
  await h.installer.start({ confirm: true, location: folder }); await h.installer.idle();
  assert.equal((await h.installer.status()).status, 'complete');
  await assert.rejects(h.installer.uninstall({}), error => error.code === 'need-confirm');
  const result = await h.installer.uninstall({ confirm: true });
  assert.equal(result.status, 'idle'); assert.equal(result.installed, false);
  assert.equal(await exists(venvLayout(folder).venv), false);
  assert.equal(await exists(folder), false, 'an emptied folder is removed too');
  assert.equal(await readFile(join(parent, 'neighbour.txt'), 'utf8'), 'keep');
  assert.equal((await readMarkerSettings()).command, '');
});

test('uninstall leaves a hand-configured Marker alone and refuses a folder without the sentinel', async t => {
  const h = await harness(t);
  const own = join(h.dir, 'my-own-marker'); await mkdir(own);
  await saveMarkerSettings({ command: join(own, 'marker_single') });
  await assert.rejects(h.installer.uninstall({ confirm: true }), error => error.code === 'not-ours');
  assert.deepEqual(await readdir(own), []);
  assert.equal((await readMarkerSettings()).command, join(own, 'marker_single'));
  // A folder recorded in the state but stripped of its sentinel is not ours any more.
  await h.installer.start({ confirm: true, location: join(h.dir, 'installed') }); await h.installer.idle();
  await rm(venvLayout(join(h.dir, 'installed')).sentinel);
  await assert.rejects(h.installer.uninstall({ confirm: true }), error => error.code === 'not-ours');
  assert.equal(await exists(venvLayout(join(h.dir, 'installed')).marker), true, 'nothing was deleted');
});

test('move: reinstalling elsewhere removes the previous environment only after the new one works', async t => {
  const h = await harness(t);
  const first = join(h.dir, 'one'), second = join(h.dir, 'two');
  await h.installer.start({ confirm: true, location: first }); await h.installer.idle();
  await h.setPy({ failPip: true });
  await h.installer.start({ confirm: true, location: second, removePrevious: true }); await h.installer.idle();
  assert.equal((await h.installer.status()).status, 'failed');
  assert.equal(await exists(venvLayout(first).marker), true, 'the working environment stays when the new one fails');
  assert.equal((await readMarkerSettings()).command, venvLayout(first).marker);
  await h.setPy({});
  await h.installer.start({ confirm: true, location: second, removePrevious: true }); await h.installer.idle();
  const done = await h.installer.status();
  assert.equal(done.status, 'complete'); assert.equal(done.installedFolder, second);
  assert.equal(await exists(venvLayout(first).venv), false);
  assert.equal((await readMarkerSettings()).command, venvLayout(second).marker);
});

test('an uninstall right after the result is shown waits for the result to be saved, never refuses', async t => {
  const h = await harness(t);
  await h.installer.start({ confirm: true });
  await h.until(async () => (await h.installer.status()).status === 'complete');
  const result = await h.installer.uninstall({ confirm: true });
  assert.equal(result.status, 'idle');
  assert.equal((await createMarkerInstaller(h.options).status()).status, 'idle', 'the late result did not overwrite the uninstall');
});
