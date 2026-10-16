import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINERU_INSTALL, createMineruInstaller, effectiveMineru, mineruEnv, mineruInstallStatePath, mineruLayout, percentOf, writeMineruConfig } from '../lib/mineru-install.js';
import { installHarness } from './helpers/mineru-install-harness.mjs';

/* The one-click local MinerU install, through the real engine with a fake index, a fake uv and the fake mineru. No network, nothing real is installed. */

const exists = file => stat(file).then(() => true, () => false);
const GB = 1024;

test('plan: the default folder is on the non-system drive with the most room, and a plan creates nothing', async t => {
  const h = await installHarness(t, { drives: [{ root: 'C:\\', freeMb: 300 * GB, totalMb: 500 * GB, system: true }, { root: 'D:\\', freeMb: 118 * GB, totalMb: 500 * GB, system: false }] });
  const installer = createMineruInstaller({ ...h.seams, platform: 'win32', freeMegabytes: undefined });
  const plan = await installer.plan({});
  assert.equal(plan.defaultFolder, 'D:\\StudyHub\\MinerU');
  assert.equal(plan.folder, 'D:\\StudyHub\\MinerU');
  assert.equal(plan.defaultReason, 'largest-data-drive');
  assert.equal(plan.disk.freeMb, 118 * GB, 'the free space of the listed drive');
  assert.deepEqual(plan.drives.map(drive => [drive.root, drive.recommended, drive.folder]), [['C:\\', false, 'C:\\StudyHub\\MinerU'], ['D:\\', true, 'D:\\StudyHub\\MinerU']]);
  assert.equal(plan.tier, 'basic');
  assert.deepEqual(plan.tiers.map(tier => [tier.id, tier.modelsMb]), [['basic', 800], ['standard', 2000]]);
  assert.deepEqual([plan.source.id, plan.source.chosenBy, plan.source.reason], ['mainland', 'auto', 'faster']);
  assert.deepEqual(plan.estimate, { downloadMb: 1300, minutes: [10, 30] });
  assert.ok(plan.commands.some(item => item.stage === 'package' && item.command.includes('"mineru>=4.0,<5"')));
  assert.ok(plan.commands.some(item => item.stage === 'models' && item.command.includes('--source modelscope')));
  const only = await createMineruInstaller({ ...h.seams, platform: 'win32', drives: async () => [{ root: 'C:\\', freeMb: 50 * GB, system: true }] }).plan({});
  assert.deepEqual([only.folder, only.defaultReason], ['C:\\StudyHub\\MinerU', 'only-system-drive']);
});

test('plan: no space (with the numbers), a path too long, a non-ASCII path, a foreign folder, a relative path', async t => {
  const h = await installHarness(t, { free: 900 });
  const installer = createMineruInstaller(h.seams);
  const noSpace = await installer.plan({ location: h.location });
  assert.deepEqual(noSpace.problems.map(item => item.code), ['no-space']);
  assert.match(noSpace.problems[0].message, /剩余 900 MB，至少需要 3\.9 GB/);
  h.seams.free = 100_000;
  h.seams.maxPathLength = undefined;
  const long = await installer.plan({ location: join(h.dir, 'a'.repeat(90)) });
  assert.deepEqual(long.problems.map(item => item.code), ['path-too-long']);
  h.seams.maxPathLength = 260;
  const chinese = await installer.plan({ location: join(h.dir, '我的工具', 'MinerU') });
  assert.deepEqual(chinese.problems, []);
  assert.deepEqual(chinese.warnings.map(item => item.code), ['non-ascii']);
  const foreign = join(h.dir, 'Stuff'); await mkdir(foreign); await writeFile(join(foreign, 'notes.txt'), 'keep');
  const adjusted = await installer.plan({ location: foreign });
  assert.equal(adjusted.adjusted, true); assert.equal(adjusted.folder, join(foreign, 'StudyHub-MinerU'));
  await mkdir(join(foreign, 'StudyHub-MinerU')); await writeFile(join(foreign, 'StudyHub-MinerU', 'x.txt'), 'theirs');
  assert.deepEqual((await installer.plan({ location: foreign })).problems.map(item => item.code), ['folder-in-use']);
  assert.deepEqual((await installer.plan({ location: 'relative\\folder' })).problems.map(item => item.code), ['bad-location']);
  await assert.rejects(installer.plan({ tier: 'advanced' }), error => error.code === 'bad-tier');
  await assert.rejects(installer.plan({ source: 'moon' }), error => error.code === 'bad-source');
  assert.deepEqual([(await installer.plan({ source: 'global' })).source.chosenBy, (await installer.plan({ source: 'global' })).source.id], ['learner', 'global']);
  assert.equal(await exists(h.location), false, 'nothing was created');
});

test('the environment keeps every path inside the install folder, and the model source follows the phase', () => {
  const folder = 'D:\\StudyHub\\MinerU';
  const uv = mineruEnv(folder, { source: 'mainland', phase: 'uv', platform: 'win32' });
  assert.equal(uv.UV_PYTHON_INSTALL_REGISTRY, '0');
  assert.equal(uv.UV_MANAGED_PYTHON, '1');
  assert.equal(uv.UV_NO_CONFIG, '1');
  assert.equal(uv.UV_DEFAULT_INDEX, 'https://pypi.tuna.tsinghua.edu.cn/simple');
  assert.equal(uv.UV_PYTHON_INSTALL_MIRROR, 'https://registry.npmmirror.com/-/binary/python-build-standalone/');
  for (const key of ['UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_PYTHON_BIN_DIR', 'TEMP', 'TMP']) assert.ok(uv[key].startsWith(`${folder}\\`), key);
  const global = mineruEnv(folder, { source: 'global', phase: 'uv', platform: 'win32', pythonOverride: true });
  assert.equal(global.UV_DEFAULT_INDEX, 'https://pypi.org/simple');
  assert.equal(global.UV_PYTHON_INSTALL_MIRROR, undefined);
  assert.equal(global.UV_MANAGED_PYTHON, undefined, 'a system Python drops the managed-Python switch');
  assert.equal(mineruEnv(folder, { source: 'mainland', phase: 'models', platform: 'win32' }).MINERU_MODEL_SOURCE, 'modelscope');
  assert.equal(mineruEnv(folder, { source: 'global', phase: 'models', platform: 'win32' }).MINERU_MODEL_SOURCE, 'huggingface');
  const run = mineruEnv(folder, { source: 'global', phase: 'run', platform: 'win32' });
  assert.equal(run.MINERU_MODEL_SOURCE, 'local');
  assert.equal(run.HF_HUB_DISABLE_XET, '1');
  for (const key of ['MINERU_HOME', 'HF_HOME', 'MODELSCOPE_CACHE', 'TEMP']) assert.ok(run[key].startsWith(`${folder}\\`), key);
  assert.equal(percentOf('Downloading  42%|####  | 5M/12M\r 57%|#####'), 0.57);
  assert.equal(percentOf('no bar here'), null);
});

test('config.yaml points the models into the install and is written only when absent', async t => {
  const h = await installHarness(t);
  const layout = mineruLayout(h.location);
  assert.equal(await writeMineruConfig(h.location), true);
  assert.match(await readFile(layout.config, 'utf8'), new RegExp(`base_dir: '${layout.models.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  await writeFile(layout.config, 'model:\n  base_dir: my-own\n');
  assert.equal(await writeMineruConfig(h.location), false);
  assert.equal(await readFile(layout.config, 'utf8'), 'model:\n  base_dir: my-own\n');
});

test('install: six stages in order, all inside the folder, the models from the chosen source, the service local, and no ~/.mineru', async t => {
  const h = await installHarness(t);
  const installer = createMineruInstaller(h.seams);
  await assert.rejects(installer.start({ location: h.location }), error => error.code === 'need-confirm');
  const started = await installer.start({ confirm: true, location: h.location });
  assert.equal(started.status, 'running'); assert.equal(started.of, 6);
  await installer.idle();
  const done = await installer.status();
  assert.equal(done.status, 'complete', JSON.stringify(done.error));
  assert.deepEqual(done.done, MINERU_INSTALL.stages);
  assert.deepEqual([done.step, done.installedFolder, done.tier, done.mineruVersion, done.installed], [6, h.location, 'basic', '4.0.12', true]);
  const layout = mineruLayout(h.location);
  assert.ok(await exists(layout.uv), 'uv taken out of the wheel');
  assert.equal(await exists(layout.uvPart), false, 'the wheel was deleted');
  assert.equal(await exists(layout.cacheUv), false, 'the uv cache is cleared after the check');
  const sentinel = JSON.parse(await readFile(layout.sentinel, 'utf8'));
  assert.equal(sentinel.createdBy, 'studyhub-mineru-installer');
  assert.ok(sentinel.createdParents.includes(join(h.dir, 'Tools')), 'the parents it made are recorded');
  const uv = await h.uvLog();
  assert.deepEqual(uv.map(entry => entry.args[0]), ['--version', 'venv', 'pip']);
  assert.deepEqual(uv[1].args.slice(0, 4), ['venv', layout.venv, '--python', '3.12']);
  assert.deepEqual(uv[2].args, ['pip', 'install', '--python', layout.venvPython, 'mineru>=4.0,<5']);
  assert.equal(uv[2].env.UV_DEFAULT_INDEX, h.index.packageIndex);
  assert.ok(uv[2].env.UV_CACHE_DIR.startsWith(h.location));
  const calls = await h.mineruLog();
  const download = calls.find(entry => entry.argv[0] === 'models' && entry.argv[1] === 'download');
  assert.deepEqual(download.argv, ['models', 'download', '--tier', 'basic', '--source', 'modelscope']);
  assert.equal(download.env.MINERU_MODEL_SOURCE, 'modelscope');
  assert.equal(download.env.MINERU_HOME, layout.home);
  const starts = calls.filter(entry => entry.argv.join(' ') === 'server start');
  assert.equal(starts.length, 2, 'started, configured, stopped, started again');
  assert.ok(starts.every(entry => entry.env.MINERU_MODEL_SOURCE === 'local'));
  assert.ok(calls.some(entry => entry.argv.join(' ') === 'config set parse_server.local.managed_tier basic'));
  assert.ok(calls.some(entry => entry.argv.join(' ') === 'config set parse_server.local.mode managed'));
  assert.ok(!calls.some(entry => entry.argv.join(' ') === 'server restart'), 'stop + start, not the undocumented restart');
  assert.ok(await exists(join(layout.models, 'MinerU-4_models_onnx')));
  assert.ok(await h.noUserMineru(), 'nothing in ~/.mineru');
  // A restart reads the result from disk; the program StudyHub runs is now this install, with its environment.
  assert.equal((await createMineruInstaller(h.seams).status()).status, 'complete');
  const found = await effectiveMineru({ seams: h.seams });
  assert.deepEqual([found.origin, found.folder, found.home, found.tier], ['installed', h.location, layout.home, 'basic']);
  assert.equal(found.cli.env.MINERU_MODEL_SOURCE, 'local');
  assert.equal(found.cli.env.FAKE_MINERU_STATE, h.mineruEnv.FAKE_MINERU_STATE, 'the stand-in program keeps its own variables');
});

test('effectiveMineru: StudyHub\'s install first, then MINERU_BIN, then the PATH', async t => {
  const h = await installHarness(t);
  const bin = join(h.dir, 'bin', process.platform === 'win32' ? 'mineru.exe' : 'mineru');
  await mkdir(join(h.dir, 'bin')); await writeFile(bin, 'x');
  assert.deepEqual(await effectiveMineru({ env: { PATH: '' } }), { cli: null, origin: null });
  assert.equal((await effectiveMineru({ env: { PATH: join(h.dir, 'bin') } })).origin, 'search');
  assert.equal((await effectiveMineru({ env: { MINERU_BIN: bin, PATH: '' } })).origin, 'env');
  const installer = createMineruInstaller(h.seams);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await effectiveMineru({ env: { MINERU_BIN: bin, PATH: '' } })).origin, 'installed');
  // An install whose sentinel is gone is not StudyHub's any more.
  await rm(mineruLayout(h.location).sentinel);
  assert.equal((await effectiveMineru({ env: { MINERU_BIN: bin, PATH: '' } })).origin, 'env');
});

test('cancel keeps the sentinel and what was downloaded; 继续安装 skips the finished stages and completes', async t => {
  const h = await installHarness(t, { uv: { delayPipMs: 60_000 } });
  const installer = createMineruInstaller(h.seams);
  await installer.start({ confirm: true, location: h.location });
  const until = async condition => { for (let i = 0; i < 4000; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('timed out'); };
  await until(async () => (await installer.status()).stage === 'package' && (await installer.status()).log.some(line => /Downloading onnxruntime/.test(line)));
  await installer.cancel(); await installer.idle();
  const cancelled = await installer.status();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error.code, 'cancelled');
  assert.deepEqual(cancelled.done, ['tools', 'python']);
  assert.ok(await exists(mineruLayout(h.location).sentinel));
  assert.ok(await exists(mineruLayout(h.location).uv));
  await h.setUv({});
  const before = (await h.uvLog()).length;
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  const done = await installer.status();
  assert.equal(done.status, 'complete', JSON.stringify(done.error));
  const again = (await h.uvLog()).slice(before).map(entry => entry.args[0]);
  assert.deepEqual(again, ['--version', 'pip'], 'uv is not fetched again, the venv is not made again');
  assert.ok(done.log.some(line => /tools: already done/.test(line)) && done.log.some(line => /python: already done/.test(line)));
  assert.equal(h.index.requests.filter(request => request.url.includes('.whl')).length, 1, 'the wheel was downloaded once');
});

test('failures: each cause gets its code; a second network failure on the same source is counted', async t => {
  const h = await installHarness(t, { uv: { failPip: true } });
  const installer = createMineruInstaller(h.seams);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  let failed = await installer.status();
  assert.deepEqual([failed.status, failed.stage, failed.error.code, failed.attempts], ['failed', 'package', 'network', 1]);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  failed = await installer.status();
  assert.deepEqual([failed.error.code, failed.attempts], ['network', 2]);
  // The other source starts the count again.
  await installer.start({ confirm: true, location: h.location, source: 'global' }); await installer.idle();
  failed = await installer.status();
  assert.deepEqual([failed.error.code, failed.attempts, failed.source.id], ['network', 1, 'global']);
  await h.setUv({ failPip: true, pipError: 'error: failed to write: 磁盘空间不足 (os error 112)' });
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).error.code, 'no-space');
  await h.setUv({ failPip: true, pipError: 'error: failed to create directory: 拒绝访问。 (os error 5)' });
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).error.code, 'not-writable');
  await h.setUv({});
  await h.setMineru({ vcRuntime: true });
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  failed = await installer.status();
  assert.deepEqual([failed.stage, failed.error.code], ['enable', 'vc-runtime']);
  await h.setMineru({ vcRuntime: false, portInUse: true });
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).error.code, 'port-in-use');
  await h.setMineru({ portInUse: false, downloadFails: true, modelsReady: false });
  await rm(mineruLayout(h.location).models, { recursive: true, force: true });
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  failed = await installer.status();
  assert.deepEqual([failed.stage, failed.error.code], ['models', 'network']);
  await h.setMineru({ downloadFails: false, downloadError: undefined });
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).status, 'complete');
});

test('a uv wheel with a wrong checksum fails as checksum and leaves no part file', async t => {
  const h = await installHarness(t);
  h.index.set({ wrongSha: true });
  const installer = createMineruInstaller(h.seams);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  const failed = await installer.status();
  assert.deepEqual([failed.stage, failed.error.code, failed.attempts], ['tools', 'checksum', 1]);
  assert.equal(await exists(mineruLayout(h.location).uvPart), false);
});

test('uninstall: only what StudyHub made, then the empty folders it made; never while a conversion uses MinerU', async t => {
  let converting = true;
  const h = await installHarness(t, { extra: { conversionRunning: () => converting } });
  const installer = createMineruInstaller(h.seams);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).status, 'complete');
  await assert.rejects(installer.uninstall({ confirm: true }), error => error.code === 'conversion-running');
  converting = false;
  await assert.rejects(installer.uninstall({}), error => error.code === 'need-confirm');
  await writeFile(join(h.dir, 'Tools', 'neighbour.txt'), 'keep');
  const result = await installer.uninstall({ confirm: true });
  assert.equal(result.status, 'idle'); assert.equal(result.removed, 1); assert.deepEqual(result.removedFolders, [h.location]);
  assert.equal(await exists(h.location), false);
  assert.equal(await exists(join(h.dir, 'Tools', 'StudyHub')), false, 'the empty parent it made is gone');
  assert.equal(await readFile(join(h.dir, 'Tools', 'neighbour.txt'), 'utf8'), 'keep', 'a parent with other files stays');
  assert.ok((await h.mineruLog()).some(entry => entry.argv.join(' ') === 'server stop'), 'the service was stopped first');
  // A stranger's file inside the folder keeps the folder (and the file).
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  await writeFile(join(h.location, 'mine.txt'), 'theirs');
  await installer.uninstall({ confirm: true });
  assert.deepEqual(await readdir(h.location), ['mine.txt']);
});

test('a run that was live when the app stopped reads as interrupted; a later format is refused, not overwritten', async t => {
  const h = await installHarness(t);
  await mkdir(join(process.env.DSH_HOME, 'study'), { recursive: true });
  await writeFile(mineruInstallStatePath(), JSON.stringify({ status: 'running', stage: 'models', folder: h.location, done: ['tools', 'python', 'package'], log: ['x'] }));
  const view = await createMineruInstaller(h.seams).status();
  assert.deepEqual([view.status, view.error.code, view.step, view.done.length], ['interrupted', 'interrupted', 4, 3]);
  await writeFile(mineruInstallStatePath(), JSON.stringify({ version: 2, status: 'complete' }));
  await assert.rejects(createMineruInstaller(h.seams).start({ confirm: true, location: h.location }), error => error.code === 'unsupported-store-version');
  assert.equal(JSON.parse(await readFile(mineruInstallStatePath(), 'utf8')).version, 2);
});

test('moving the install copies the verified models and removes the old folder only after the new one passes', async t => {
  const h = await installHarness(t);
  const installer = createMineruInstaller(h.seams), second = join(h.dir, 'Other', 'MinerU');
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  await h.setMineru({ downloadFails: true });
  await installer.start({ confirm: true, location: second, removePrevious: true }); await installer.idle();
  const moved = await installer.status();
  assert.equal(moved.status, 'complete', JSON.stringify(moved.error));
  assert.equal(moved.installedFolder, second);
  assert.ok(await exists(join(mineruLayout(second).models, 'MinerU-4_models_onnx')), 'copied, not downloaded (the download would have failed)');
  assert.equal(await exists(h.location), false);
});

test('a system Python chosen in 更多 is passed to uv venv and the managed-Python switch is dropped', async t => {
  const h = await installHarness(t);
  const pyState = join(h.dir, 'system-py.json');
  await writeFile(pyState, JSON.stringify({ version: '3.11.9', executable: join('C:', 'Py311', 'python.exe') }));
  h.seams.pythons = [{ file: process.execPath, prefix: [fileURLToPath(new URL('./helpers/fake-python.mjs', import.meta.url))], env: { FAKE_PY_STATE: pyState } }];
  const installer = createMineruInstaller(h.seams);
  const plan = await installer.plan({ location: h.location });
  assert.deepEqual(plan.pythons, [{ version: '3.11.9', path: join('C:', 'Py311', 'python.exe') }]);
  assert.deepEqual((await installer.plan({ location: h.location, python: 'C:\\nope\\python.exe' })).problems.map(item => item.code), ['bad-python']);
  await h.setUv({ failPip: true });
  await installer.start({ confirm: true, location: h.location, python: plan.pythons[0].path }); await installer.idle();
  const venv = (await h.uvLog()).find(entry => entry.args[0] === 'venv');
  assert.deepEqual(venv.args.slice(2, 4), ['--python', plan.pythons[0].path]);
  assert.equal(venv.env.UV_MANAGED_PYTHON, undefined);
});

test('a repair or a change of tier needs only the room of the steps not yet done, so a nearly full disk does not refuse it', async t => {
  const h = await installHarness(t, { mineru: { portInUse: true } });
  const installer = createMineruInstaller(h.seams);
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.deepEqual([(await installer.status()).stage, (await installer.status()).error.code], ['enable', 'port-in-use']);
  h.seams.free = 3000;
  const repair = await installer.plan({ location: h.location });
  assert.equal(repair.existing, true);
  assert.deepEqual(repair.problems, [], 'tools, Python, MinerU and the models are already on the disk');
  assert.equal(repair.disk.neededMb, MINERU_INSTALL.marginMb);
  assert.deepEqual((await installer.plan({ location: join(h.dir, 'Elsewhere', 'MinerU') })).problems.map(item => item.code), ['no-space'], 'a new folder still needs the whole install');
  await h.setMineru({ portInUse: false });
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).status, 'complete');
  const tierChange = await installer.plan({ location: h.location, tier: 'standard' });
  assert.equal(tierChange.disk.neededMb, 2000 + MINERU_INSTALL.marginMb, 'only the standard models and the margin');
  assert.deepEqual(tierChange.problems, []);
  h.seams.free = 1000;
  assert.deepEqual((await installer.plan({ location: h.location, tier: 'standard' })).problems.map(item => item.code), ['no-space']);
});

test('a first install that stopped and starts again elsewhere (换位置) removes its partial folder once the new one passes', async t => {
  const h = await installHarness(t, { uv: { failPip: true } });
  const installer = createMineruInstaller(h.seams), second = join(h.dir, 'Other', 'MinerU');
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  assert.equal((await installer.status()).status, 'failed');
  assert.ok(await exists(mineruLayout(h.location).uv), 'the first folder holds a partial install');
  await h.setUv({});
  await installer.start({ confirm: true, location: second }); await installer.idle();
  const done = await installer.status();
  assert.equal(done.status, 'complete', JSON.stringify(done.error));
  assert.equal(done.installedFolder, second);
  assert.equal(await exists(h.location), false, 'the partial first folder is gone');
  assert.equal(JSON.parse(await readFile(mineruInstallStatePath(), 'utf8')).previous, undefined, 'and forgotten');
});

test('a partial folder left behind by a relocation that failed too is still removed by an uninstall', async t => {
  const h = await installHarness(t, { uv: { failPip: true } });
  const installer = createMineruInstaller(h.seams), second = join(h.dir, 'Other', 'MinerU');
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  await installer.start({ confirm: true, location: second }); await installer.idle();
  assert.equal((await installer.status()).status, 'failed');
  const result = await installer.uninstall({ confirm: true });
  assert.deepEqual(result.removedFolders.sort(), [second, h.location].sort());
  assert.equal(await exists(h.location), false);
  assert.equal(await exists(second), false);
});

test('moving the install stops the old folder\'s service (with its own MINERU_HOME) before the new one starts', async t => {
  const h = await installHarness(t);
  const installer = createMineruInstaller(h.seams), second = join(h.dir, 'Other', 'MinerU');
  await installer.start({ confirm: true, location: h.location }); await installer.idle();
  const before = (await h.mineruLog()).length;
  await installer.start({ confirm: true, location: second, removePrevious: true }); await installer.idle();
  assert.equal((await installer.status()).status, 'complete');
  const calls = (await h.mineruLog()).slice(before).map(entry => ({ argv: entry.argv.join(' '), home: entry.env?.MINERU_HOME }));
  const stopOld = calls.findIndex(call => call.argv === 'server stop' && call.home === mineruLayout(h.location).home);
  const startNew = calls.findIndex(call => call.argv === 'server start' && call.home === mineruLayout(second).home);
  assert.ok(stopOld >= 0, 'the old service was stopped');
  assert.ok(stopOld < startNew, 'before the new one started');
});
