import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIVE_LOCAL, WHISPER_ENGINE, WHISPER_TURBO_FILES, checkEngine, createLiveLocalInstaller, effectiveLiveLocal, installSizes, liveLocalInstallStatePath, liveLocalLayout } from '../lib/live-local-install.js';
import { extractPackage } from '../lib/npm-tarball.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { LIVE_LOCAL_JOB_TEXT, LIVE_LOCAL_MESSAGES, LIVE_LOCAL_STAGE_NAMES, LIVE_PROVIDER_TEXT } from '../lib/live-local-install-text.js';
import { fakeFetch, fakePins, liveLocalHome } from './helpers/live-local-fakes.mjs';
import { makeTgz, sha256Hex } from './helpers/make-tgz.mjs';

/* The one-click local engine of 课堂实录 with tiny pinned files and a fetch from memory: the state machine (plan, start, stages, cancel, retry,
   uninstall), the sha512/sha256 pins, resumable .part files and no corrupt leftovers. Nothing is downloaded, nothing native is loaded. */

const exists = file => stat(file).then(() => true, () => false);
const drives = async () => [{ root: 'C:\\', freeMb: 50_000, totalMb: 100_000, system: true }];

async function harness(t, { checkEngine = async () => ({ version: 'fake' }), ...extra } = {}) {
  const where = await liveLocalHome(t), fake = fakePins(), net = fakeFetch(fake.files);
  const seams = { platform: process.platform, arch: 'x64', pins: fake.pins, fetch: net.fetch, drives, freeMegabytes: async () => 50_000, checkEngine, legacyModelFolders: [], ...extra };
  // The pins are Windows x64 ones; on another system the test still plays a Windows x64 install (only file names differ).
  seams.pins = { ...fake.pins, platforms: { [`${process.platform}-x64`]: fake.pins.platforms['win32-x64'] } };
  const installer = createLiveLocalInstaller(seams);
  const ended = async () => { await installer.idle(); return installer.status(); };
  return { ...where, fake, net, seams, installer, ended, start: (args = {}) => installer.start({ confirm: true, location: where.location, ...args }) };
}

test('the pins are exact: one engine version with sha512 integrity per platform, the model files with sha256 and size, and honest totals', () => {
  assert.match(LIVE_LOCAL.engineVersion, /^\d+\.\d+\.\d+$/);
  for (const item of [LIVE_LOCAL.engine, ...Object.values(LIVE_LOCAL.platforms)]) {
    assert.match(item.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, item.name);
    assert.ok(item.path.endsWith(`-${LIVE_LOCAL.engineVersion}.tgz`), item.path);
  }
  assert.ok(LIVE_LOCAL.platforms['win32-x64'], 'Windows x64 is the must');
  assert.deepEqual(LIVE_LOCAL.model.map(pin => pin.name), ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']);
  for (const pin of LIVE_LOCAL.model) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.match(pin.url, /^https:\/\/www\.modelscope\.cn\/models\/pengzhendong\/[^/]+\/resolve\/[0-9a-f]{40}\//, 'a pinned revision, not master');
  }
  const sizes = installSizes({ platform: 'win32', arch: 'x64' });
  assert.equal(Math.round(sizes.download / 1_048_576), 239, 'about 240 MB on Windows: what the card says');
  assert.equal(Math.round(LIVE_LOCAL.model[0].bytes / 1_048_576), 228);
  assert.equal(Math.round(LIVE_LOCAL.model[2].bytes / 1_048_576), 2);
});

test('the plan creates nothing; an unsupported computer is said so up front', async t => {
  const h = await harness(t);
  const plan = await h.installer.plan({ location: h.location });
  assert.equal(plan.ok, true);
  assert.equal(plan.folder, h.location);
  assert.ok(plan.files.some(file => file.name === 'model.int8.onnx' && file.where.startsWith(h.location)), 'where each file goes');
  assert.equal(await exists(h.location), false);
  assert.equal(await exists(liveLocalInstallStatePath()), false);
  const other = createLiveLocalInstaller({ ...h.seams, arch: 'mips' });
  const refused = await other.plan({ location: h.location });
  assert.equal(refused.supported, false);
  assert.equal(refused.problems[0].code, 'unsupported');
  await assert.rejects(other.start({ confirm: true, location: h.location }), { code: 'unsupported' });
  await assert.rejects(h.installer.start({ location: h.location }), { code: 'need-confirm' });
});

test('quality model pins and isolated installs preserve the existing speed model through failure, retry and removal', async t => {
  const h = await harness(t);
  assert.equal(WHISPER_TURBO_FILES.length, 3);
  assert.equal(WHISPER_ENGINE.engineVersion, '2.0.1', 'Chinese Whisper tokens require the fixed native engine');
  for (const pin of [WHISPER_ENGINE.engine, ...Object.values(WHISPER_ENGINE.platforms)]) {
    assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.ok(pin.path.endsWith('-2.0.1.tgz'));
  }
  for (const file of WHISPER_TURBO_FILES) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.match(file.url, /resolve\/[0-9a-f]{40}\//);
  }
  const sizes = installSizes({ platform: 'win32', arch: 'x64', seams: { modelId: 'whisper-turbo' } });
  assert.ok(sizes.download > 1_000_000_000);
  assert.ok(sizes.files.some(file => file.name === 'turbo-decoder.int8.onnx'));
  await h.start(); await h.ended();
  const speed = await effectiveLiveLocal({ seams: h.seams });
  let checkedModel = '', rejectCheck = true;
  const qualityFiles = WHISPER_TURBO_FILES.map(file => {
    const body = Buffer.alloc(300, 5);
    h.fake.files.set(file.url, body);
    h.fake.files.set(`https://huggingface.co/csukuangfj/sherpa-onnx-whisper-turbo/resolve/2ca6ff69fc878651b770880507669577ac41c2ff/${file.name}`, body);
    return { ...file, bytes: body.length, sha256: sha256Hex(body) };
  });
  h.net.rules.set(qualityFiles[0].url, { stall: true });
  const qualitySeams = { ...h.seams, modelId: 'whisper-turbo', downloadIdleMs: 30,
    pins: { ...h.seams.pins, model: [...qualityFiles, h.seams.pins.model[2]] }, checkEngine: async ({ modelId }) => {
      checkedModel = modelId;
      if (rejectCheck) throw new Error('test failed check');
    } };
  const quality = createLiveLocalInstaller(qualitySeams), location = join(h.dir, 'Quality');
  for (const child of LIVE_LOCAL.children) {
    const unsafe = join(h.location, child, 'quality-model');
    assert.equal((await quality.plan({ location: unsafe })).ok, false, `cannot place another install inside ${child}`);
    await assert.rejects(quality.start({ confirm: true, location: unsafe }), { code: 'folder-in-use' });
  }
  await quality.start({ confirm: true, location }); await quality.idle();
  assert.equal((await quality.status()).status, 'failed');
  assert.equal(await effectiveLiveLocal({ seams: qualitySeams }), null);
  assert.deepEqual(await effectiveLiveLocal({ seams: h.seams }), speed);
  rejectCheck = false;
  await quality.start({ confirm: true, location }); await quality.idle();
  assert.equal((await quality.status()).ready, true);
  assert.equal(checkedModel, 'whisper-turbo');
  assert.ok(h.net.requests.some(request => request.url.startsWith('https://huggingface.co/') && request.range === 'bytes=100-'), 'a stalled source falls back and continues the verified file');
  assert.notEqual(liveLocalInstallStatePath(), liveLocalInstallStatePath('whisper-turbo'));
  assert.match((await effectiveLiveLocal({ seams: qualitySeams })).modelDir, /whisper-turbo$/);
  assert.equal((await h.installer.plan({ location: join(location, 'models', 'speed') })).ok, false, 'the containment guard works in both directions');
  await quality.uninstall({ confirm: true });
  assert.deepEqual(await effectiveLiveLocal({ seams: h.seams }), speed);
});

test('one click installs the engine and the model, verified, into the chosen folder; .part files and temp files are gone; the engine is found', async t => {
  const h = await harness(t);
  const started = await h.start();
  assert.equal(started.status, 'running');
  const view = await h.ended();
  assert.equal(view.status, 'complete', JSON.stringify(view.error));
  assert.equal(view.installed, true);
  assert.deepEqual(view.done, ['engine', 'model', 'check']);
  const layout = liveLocalLayout(h.location, { arch: 'x64', seams: h.seams });
  assert.equal(JSON.parse(await readFile(join(layout.enginePath, 'package.json'), 'utf8')).version, h.fake.pins.engineVersion);
  for (const pin of h.fake.pins.model) assert.deepEqual(await readFile(join(layout.modelDir, pin.name)), h.fake.model[pin.name]);
  assert.deepEqual((await readdir(layout.modelDir)).filter(name => name.endsWith('.part')), []);
  assert.equal(await exists(layout.tmp), false);
  assert.ok(h.net.requests.every(request => request.url.startsWith('https://mirror.test/') || request.url.startsWith('https://models.test/')), 'the mirror served the engine');
  assert.deepEqual(await effectiveLiveLocal({ seams: h.seams }), { enginePath: layout.enginePath, modelDir: layout.modelDir, folder: h.location });
  // Again: every stage finds its work done and nothing is downloaded.
  const before = h.net.requests.length;
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
  assert.equal(h.net.requests.length, before);
});

test('a model file that does not match its sha256 is deleted, the install fails with checksum, and a retry downloads it again', async t => {
  const h = await harness(t);
  const pin = h.fake.pins.model[0], layout = liveLocalLayout(h.location, { arch: 'x64', seams: h.seams });
  h.net.rules.set(pin.url, { corrupt: true });
  await h.start();
  const failed = await h.ended();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'checksum');
  assert.equal(failed.error.message, LIVE_LOCAL_MESSAGES.checksum);
  assert.equal(failed.installed, false);
  assert.equal(await exists(join(layout.modelDir, pin.name)), false, 'never renamed into place');
  assert.equal(await exists(join(layout.modelDir, `${pin.name}.part`)), false, 'no corrupt leftover');
  assert.equal(await effectiveLiveLocal({ seams: h.seams }), null);
  h.net.rules.delete(pin.url);
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
});

test('an engine tarball that fails its integrity on the mirror is fetched from the official registry instead; both failing is a checksum failure', async t => {
  const h = await harness(t);
  const native = h.seams.pins.platforms[`${process.platform}-x64`];
  h.net.rules.set(`https://mirror.test/${native.path}`, { corrupt: true });
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
  assert.ok(h.net.requests.some(request => request.url === `https://registry.test/${native.path}`));

  const again = await harness(t);
  const pkg = again.seams.pins.engine;
  for (const base of again.seams.pins.registries) again.net.rules.set(`${base}${pkg.path}`, { corrupt: true });
  await again.start();
  const view = await again.ended();
  assert.equal(view.status, 'failed');
  assert.equal(view.error.code, 'checksum');
});

test('a download cut off keeps its .part and the next start continues it with a Range request', async t => {
  const h = await harness(t);
  const pin = h.fake.pins.model[0], layout = liveLocalLayout(h.location, { arch: 'x64', seams: h.seams });
  h.net.rules.set(pin.url, { cutAfter: 100_000 });
  await h.start();
  const failed = await h.ended();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'network');
  const part = join(layout.modelDir, `${pin.name}.part`);
  assert.equal((await stat(part)).size, 100_000);
  assert.equal(await exists(join(layout.modelDir, pin.name)), false);
  h.net.rules.delete(pin.url);
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
  assert.ok(h.net.requests.some(request => request.url === pin.url && request.range === 'bytes=100000-'));
  assert.deepEqual(await readFile(join(layout.modelDir, pin.name)), h.fake.model[pin.name]);
});

test('cancel pauses the install mid-download: status cancelled, nothing half-written in place, and 继续安装 finishes it', async t => {
  const h = await harness(t);
  const pin = h.fake.pins.model[0], layout = liveLocalLayout(h.location, { arch: 'x64', seams: h.seams });
  h.net.rules.set(pin.url, { stall: true });
  await h.start();
  const deadline = Date.now() + 5000;
  while (!h.net.requests.some(request => request.url === pin.url) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  await h.installer.cancel();
  const paused = await h.ended();
  assert.equal(paused.status, 'cancelled');
  assert.equal(paused.error.message, LIVE_LOCAL_MESSAGES.cancelled);
  assert.equal(await exists(join(layout.modelDir, pin.name)), false);
  h.net.rules.delete(pin.url);
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
});

test('an engine that cannot load fails the check: not installed, and the reason is the check\'s (VC++ runtime when that is what is missing)', async t => {
  const h = await harness(t, { checkEngine: async () => { throw new Error('本地识别模型没能加载：Failed to load model'); } });
  await h.start();
  const view = await h.ended();
  assert.equal(view.status, 'failed');
  assert.equal(view.error.code, 'check-failed');
  assert.equal(view.installed, false);
  const vc = await harness(t, { checkEngine: async () => { throw new Error('DLL load failed: vcruntime140.dll'); } });
  await vc.start();
  assert.equal((await vc.ended()).error.code, 'vc-runtime');

  // End-to-end worker stderr capture: an abrupt native exit in the worker thread preserves stderr (e.g. vcruntime140_1.dll) instead of losing it.
  const crashScript = join(vc.dir, 'fake-native-crash.cjs');
  await writeFile(crashScript, 'process.stderr.write("ImportError: DLL load failed while importing addon: vcruntime140_1.dll\\n"); process.exit(127);\n');
  await assert.rejects(
    checkEngine({ enginePath: crashScript, modelDir: vc.dir, timeoutMs: 5000 }),
    err => /代码 127/.test(err.message) && /vcruntime140_1\.dll/.test(err.message),
  );
  const workerCrash = await harness(t, { checkEngine: () => checkEngine({ enginePath: crashScript, modelDir: vc.dir, timeoutMs: 5000 }) });
  await workerCrash.start();
  const crashedView = await workerCrash.ended();
  assert.equal(crashedView.error.code, 'vc-runtime');
  assert.ok(crashedView.log.some(line => line.includes('vcruntime140_1.dll')), 'worker stderr is preserved in install log');
});

test('a model the community package downloaded earlier is reused when it verifies; a wrong copy is not', async t => {
  const where = await liveLocalHome(t);
  const old = join(where.dir, 'old-models');
  await mkdir(old, { recursive: true });
  const fake = fakePins();
  await writeFile(join(old, 'model.int8.onnx'), fake.model['model.int8.onnx']);
  await writeFile(join(old, 'silero_vad.onnx'), Buffer.alloc(fake.model['silero_vad.onnx'].length, 0));
  const net = fakeFetch(fake.files);
  const installer = createLiveLocalInstaller({ arch: 'x64', pins: { ...fake.pins, platforms: { [`${process.platform}-x64`]: fake.pins.platforms['win32-x64'] } }, fetch: net.fetch,
    drives, freeMegabytes: async () => 50_000, checkEngine: async () => ({}), legacyModelFolders: [old] });
  await installer.start({ confirm: true, location: where.location });
  await installer.idle();
  assert.equal((await installer.status()).status, 'complete');
  const fetched = net.requests.map(request => request.url);
  assert.equal(fetched.includes(fake.pins.model[0].url), false, 'the verified copy was reused');
  assert.equal(fetched.includes(fake.pins.model[2].url), true, 'the copy that did not verify was downloaded');
});

test('uninstall removes only StudyHub\'s own folder, refuses while a local class runs, and the engine is then not found', async t => {
  let running = true;
  const h = await harness(t, { liveRunning: () => running });
  await h.start();
  assert.equal((await h.ended()).status, 'complete');
  await assert.rejects(h.installer.uninstall({ confirm: true }), { code: 'live-running' });
  running = false;
  await assert.rejects(h.installer.uninstall({}), { code: 'need-confirm' });
  const removed = await h.installer.uninstall({ confirm: true });
  assert.equal(removed.removed, 1);
  assert.equal(await exists(h.location), false);
  assert.equal(await effectiveLiveLocal({ seams: h.seams }), null);
});

test('a package archive cannot write outside its folder or hold links', async t => {
  const where = await liveLocalHome(t);
  const bad = join(where.dir, 'bad.tgz'), link = join(where.dir, 'link.tgz');
  await writeFile(bad, makeTgz({ 'package/../../evil.js': 'x' }));
  await writeFile(link, makeTgz([{ name: 'package/link', type: '2' }]));
  await assert.rejects(extractPackage(bad, join(where.dir, 'out')), { code: 'checksum' });
  await assert.rejects(extractPackage(link, join(where.dir, 'out2')), { code: 'checksum' });
  assert.equal(await exists(join(where.dir, 'evil.js')), false);
});

test('every sentence of the engine and its install has an English form', () => {
  const han = /[㐀-鿿]/;
  const all = [...Object.values(LIVE_LOCAL_MESSAGES).filter(value => typeof value === 'string'), LIVE_LOCAL_MESSAGES.noSpace('D:', '90 MB', '600 MB'),
    ...Object.values(LIVE_LOCAL_STAGE_NAMES), LIVE_LOCAL_JOB_TEXT.title, LIVE_LOCAL_JOB_TEXT.done, LIVE_LOCAL_JOB_TEXT.cancelled, LIVE_LOCAL_JOB_TEXT.failed,
    LIVE_LOCAL_JOB_TEXT.stage(2, LIVE_LOCAL_STAGE_NAMES.model), ...Object.values(LIVE_PROVIDER_TEXT),
    '本地识别引擎启动超时', '本地识别引擎中断（1011）', '本地识别引擎已退出（代码 1）'];
  for (const text of all) assert.doesNotMatch(localizeAppMessage(text, 'en'), han, text);
});
