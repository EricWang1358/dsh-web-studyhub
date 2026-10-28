// Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT): the local live engine; the one-click install follows lib/mineru-install.js.
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { InstallError, classifyFailure, createToolInstaller, flavourOf, freeMegabytes, readSentinel, readState, resolveInstallFolder, writable } from './tool-install.js';
import { defaultDataFolder, driveOfPath, fixedDrives } from './install-drives.js';
import { digestOf, downloadResumable } from './uv-bootstrap.js';
import { extractPackage } from './npm-tarball.js';
import { LIVE_LOCAL_MESSAGES as TEXT, LIVE_LOCAL_STAGE_NAMES } from './live-local-install-text.js';
import { packageIntact, partLeft, readJson, recordPackage, renameWithRetry } from './live-local-files.js';

/* One-click local engine for 课堂实录 (lib/live-local.js): everything in one StudyHub-owned folder (default: the non-system drive with the most free
   space), no npm, no admin rights, nothing added to StudyHub's own package. Three stages, each skipping work it finds done, so 继续安装 and 修复 are the
   same start again:
     engine  two pinned npm tarballs (sherpa-onnx-node and this platform's prebuilt sherpa-onnx-<os>-<cpu>), sha512-checked against the integrity the
             npm registry publishes for that exact version, from npmmirror (mainland) or registry.npmjs.org; unpacked into <F>\engine\node_modules,
             and each unpacked file's size and sha256 recorded (<F>\engine\.verified.json): a package whose files changed later (a quarantined
             addon) is not done, so the install reads "needs repair" and 修复 unpacks that package again
     model   SenseVoice int8 + tokens and the silero VAD from ModelScope at a pinned revision, each sha256-checked against ModelScope's own file
             metadata; resumable <name>.part files, renamed only once they verify (a mismatch deletes the file); an earlier copy of the community
             package (~/.dsh/live-models/sense-voice) is reused when it verifies
     check   a worker thread loads the engine and the model and decodes a quarter second of silence
   The engine (lib/tool-install.js) owns the folder, the sentinel, the state file, cancel and uninstall. */

const MB = 1_048_576;
const ENGINE_VERSION = '1.13.8';
const REGISTRIES = Object.freeze(['https://registry.npmmirror.com/', 'https://registry.npmjs.org/']);
const tarball = (name, integrity, bytes, unpacked) =>
  Object.freeze({ name, path: `${name}/-/${name}-${ENGINE_VERSION}.tgz`, integrity, bytes, unpacked });
const MODELSCOPE = 'https://www.modelscope.cn/models/pengzhendong';
const SENSE_VOICE = `${MODELSCOPE}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/73eca47697f980daa3d16112404174b6b950b514`;
const SILERO = `${MODELSCOPE}/silero-vad/resolve/e638eca036c3722da77f53a5f032500f1d033a34`;

/** What is installed, pinned: an exact engine version with its registry integrity per platform, and the model files with their sha256 and size. */
export const LIVE_LOCAL = Object.freeze({
  stages: Object.freeze(['engine', 'model', 'check']),
  mutatingStages: Object.freeze(['engine', 'model']),
  engineVersion: ENGINE_VERSION,
  registries: REGISTRIES,
  engine: tarball('sherpa-onnx-node', 'sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag==', 11954, 61221),
  /** The prebuilt engines of sherpa-onnx-node (its optionalDependencies). Windows on x64 is tested; the others are the same release, untested here. */
  platforms: Object.freeze({
    'win32-x64': tarball('sherpa-onnx-win-x64', 'sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g==', 8894875, 23453246),
    'darwin-arm64': tarball('sherpa-onnx-darwin-arm64', 'sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw==', 10047754, 34089738),
    'darwin-x64': tarball('sherpa-onnx-darwin-x64', 'sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g==', 11191481, 37678686),
    'linux-x64': tarball('sherpa-onnx-linux-x64', 'sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g==', 11089653, 33381117),
    'linux-arm64': tarball('sherpa-onnx-linux-arm64', 'sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw==', 13910679, 40306856),
  }),
  tested: Object.freeze(['win32-x64']),
  /** ModelScope's repo-file metadata (Sha256, Size) at the pinned revisions; the LFS object path of each file is its sha256 too. */
  model: Object.freeze([
    Object.freeze({ name: 'model.int8.onnx', url: `${SENSE_VOICE}/model.int8.onnx`, bytes: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' }),
    Object.freeze({ name: 'tokens.txt', url: `${SENSE_VOICE}/tokens.txt`, bytes: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' }),
    Object.freeze({ name: 'silero_vad.onnx', url: `${SILERO}/silero_vad.onnx`, bytes: 2327524, sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f' }),
  ]),
  marginMb: 100,
  folderName: 'StudyHub-LiveLocal',
  sentinel: '.studyhub-live-local.json',
  createdBy: 'studyhub-live-local-installer',
  children: Object.freeze(['engine', 'models', 'tmp']),
  checkTimeoutMs: 180_000,
  logLines: 200,
  lineLength: 300,
});

const dshHome = () => process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
export const liveLocalInstallStatePath = () => path.join(dshHome(), 'study', 'live-local-install.json');
export const liveLocalDataFolder = () => path.join(dshHome(), 'studyhub', 'live-local');
/** Where the community package (StudyHub for ZCode 0.4.8) downloaded the model: reused when its files verify. */
export const legacyModelFolders = () => [path.join(dshHome(), 'live-models', 'sense-voice'), path.join(dshHome(), 'studyhub', 'live-models', 'sense-voice')];

export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
/** The pins in force: the real ones, or a test's stand-ins (seams.pins: { engine, platforms, model }). */
const pinsOf = seams => ({ ...LIVE_LOCAL, ...(seams?.pins || {}) });

/** The files of an install under its folder. */
export function liveLocalLayout(folder, { platform = process.platform, arch = process.arch, seams } = {}) {
  const f = flavourOf(platform), pins = pinsOf(seams), modules = f.join(folder, 'engine', 'node_modules'), models = f.join(folder, 'models', 'sense-voice');
  const native = pins.platforms[platformKey(platform, arch)];
  return { folder, modules, enginePath: f.join(modules, pins.engine.name), nativePath: native ? f.join(modules, native.name) : '', modelDir: models,
    stamp: f.join(models, '.verified.json'), engineStamp: f.join(folder, 'engine', '.verified.json'), tmp: f.join(folder, 'tmp') };
}

const sizeText = mb => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(0, Math.round(mb))} MB`);
const problem = (code, message) => ({ code, message });
const sum = (list, key) => list.reduce((total, item) => total + (item?.[key] || 0), 0);

/** What an install downloads and leaves on disk here, in bytes: { download, disk, files: [{ name, bytes, where }] }. */
export function installSizes({ folder, platform = process.platform, arch = process.arch, seams } = {}) {
  const pins = pinsOf(seams), native = pins.platforms[platformKey(platform, arch)], engine = [pins.engine, native].filter(Boolean);
  const layout = folder ? liveLocalLayout(folder, { platform, arch, seams }) : null;
  const files = [...engine.map(item => ({ name: item.name, bytes: item.bytes, where: layout ? flavourOf(platform).join(layout.modules, item.name) : '' })),
    ...pins.model.map(item => ({ name: item.name, bytes: item.bytes, where: layout ? flavourOf(platform).join(layout.modelDir, item.name) : '' }))];
  return { download: sum(engine, 'bytes') + sum(pins.model, 'bytes'), disk: sum(engine, 'unpacked') + sum(pins.model, 'bytes'), files };
}

/** What a one-click install would do here, from read-only checks: the platform, the drives and the default folder, free space, the folder rules. */
export async function planLiveLocalInstall(args = {}, { platform = process.platform, seams = {}, live } = {}) {
  const arch = seams.arch || process.arch, key = platformKey(platform, arch), pins = pinsOf(seams);
  const problems = [], supported = !!pins.platforms[key];
  if (!supported) problems.push(problem('unsupported', TEXT.unsupported));
  const sizes = installSizes({ platform, arch, seams }), margin = seams.marginMb ?? LIVE_LOCAL.marginMb;
  const drives = seams.drives ? await seams.drives() : await fixedDrives({ platform });
  const fresh = Math.ceil((await bytesLeft(null, { platform, arch, seams })) / MB) + margin;
  const fallback = defaultDataFolder({ leaf: ['StudyHub', 'LiveLocal'], neededMb: fresh, drives, dataFolder: liveLocalDataFolder() });
  const where = await resolveInstallFolder(args.location, { spec: LIVE_LOCAL_SPEC, platform, defaultFolder: fallback.folder });
  const folder = where.folder || fallback.folder;
  // A folder StudyHub already installs into needs only the room of what is not done yet (继续安装, 修复, 重试 after a failure late in the install).
  const ours = !where.problem && !!(await readSentinel(folder, LIVE_LOCAL_SPEC, platform));
  const neededMb = ours ? Math.ceil((await bytesLeft(folder, { platform, arch, seams })) / MB) + margin : fresh;
  if (where.problem === 'bad-location') problems.push(problem('bad-location', TEXT.badLocation));
  if (where.problem === 'folder-in-use') problems.push(problem('folder-in-use', TEXT.folderInUse));
  const drive = driveOfPath(folder), listed = drives.find(item => item.root.slice(0, 2).toUpperCase() === drive);
  let freeMb = null;
  if (!where.problem) {
    const free = seams.freeMegabytes ? await seams.freeMegabytes(folder) : listed ? listed.freeMb : await freeMegabytes(folder, platform);
    freeMb = typeof free === 'number' ? free : null;
    const access = await writable(folder, platform);
    if (access === 'not-writable') problems.push(problem('not-writable', TEXT.notWritable));
    else if (access === 'bad-location') problems.push(problem('bad-location', TEXT.badLocation));
    if (freeMb !== null && freeMb < neededMb) problems.push(problem('no-space', TEXT.noSpace(drive || folder, sizeText(freeMb), sizeText(neededMb))));
  }
  if (live?.()?.state?.status === 'running') problems.push(problem('busy', TEXT.busy));
  return {
    ok: problems.length === 0, problems, warnings: [], folder, adjusted: !!where.adjusted, defaultFolder: fallback.folder, defaultReason: fallback.reason,
    platform, arch, supported, tested: LIVE_LOCAL.tested.includes(key), engineVersion: LIVE_LOCAL.engineVersion,
    drives: drives.map(item => ({ ...item, recommended: !!fallback.drive && item.root === fallback.drive.root, folder: flavourOf('win32').join(item.root, 'StudyHub', 'LiveLocal') })),
    disk: { freeMb, neededMb, drive }, estimate: { downloadMb: Math.round(sizes.download / MB), diskMb: Math.round(sizes.disk / MB) },
    files: installSizes({ folder, platform, arch, seams }).files,
  };
}

/**
 * The bytes the unfinished work still writes into `folder` (null: a new folder, everything): for an engine package that is not intact, its tarball
 * (less what its .part holds) and what it unpacks to; for a model file that is not in place, its size less its .part (the .part is renamed, so the model
 * counts once). Read-only.
 */
export async function bytesLeft(folder, { platform = process.platform, arch = process.arch, seams = {} } = {}) {
  const pins = pinsOf(seams), native = pins.platforms[platformKey(platform, arch)];
  const engine = [pins.engine, native].filter(Boolean);
  if (!folder) return sum(engine, 'bytes') + sum(engine, 'unpacked') + sum(pins.model, 'bytes');
  const layout = liveLocalLayout(folder, { platform, arch, seams }), engineStamp = await readJson(layout.engineStamp), modelStamp = await readJson(layout.stamp);
  let left = 0;
  for (const item of engine) {
    if (await packageIntact(engineStamp, layout.modules, item.name, pins.engineVersion, { hashes: false })) continue;
    left += await partLeft(path.join(layout.tmp, `${item.name}-${pins.engineVersion}.tgz.part`), item.bytes) + item.unpacked;
  }
  for (const pin of pins.model) {
    const target = path.join(layout.modelDir, pin.name);
    if (modelStamp[pin.name] === pin.sha256 && (await sizeOf(target)) === pin.bytes) continue;
    left += await partLeft(`${target}.part`, pin.bytes);
  }
  return left;
}

/* ---------- the stages ---------- */

const versionAt = async folder => { try { return JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')).version || ''; } catch { return ''; } };
const sizeOf = file => stat(file).then(info => info.size, () => -1);

/** Download one pinned file from the first source that serves it whole and matching; a network failure or a mismatch moves on to the next. */
async function fetchVerified(ctx, urls, part, check, onBytes) {
  const fetch = ctx.seams.fetch || globalThis.fetch;
  // Fail closed: a pin without a checksum is never downloaded and trusted.
  if (!check.sha256 && !check.integrity) throw new InstallError('checksum', TEXT.checksum);
  let last;
  for (const url of urls) {
    ctx.signal.throwIfAborted();
    ctx.push(`GET ${url}`);
    try {
      const got = await ctx.observe(ctx.state.stage, signal => downloadResumable(url, part, { ...check, signal, fetch, onProgress: ({ done }) => onBytes(done) }),
        { sideEffect: true, boundary: 'external-request' });
      ctx.push(`${path.basename(part)}: ${got.bytes} bytes${got.resumedFrom ? ` (continued from ${got.resumedFrom})` : ''}, ${check.sha256 ? 'sha256' : 'sha512'} ok`);
      return got;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      last = error;
      ctx.push(`${url}: ${error?.message || error}`);
      if (!(error instanceof InstallError)) throw error;
      // A full disk is not fixed by another source.
      if (error.code === 'no-space') throw new InstallError('no-space', TEXT.noSpaceShort);
    }
  }
  throw last instanceof InstallError ? new InstallError(last.code, last.code === 'checksum' ? TEXT.checksum : TEXT.network) : last;
}

/** Both engine packages are what was installed: their versions, and every recorded file's size (and the native files' sha256). */
const engineIntact = async (layout, pins) => {
  if (!layout.nativePath) return false;
  const stamp = await readJson(layout.engineStamp);
  for (const dir of [layout.enginePath, layout.nativePath]) {
    if ((await versionAt(dir)) !== pins.engineVersion || !(await packageIntact(stamp, layout.modules, path.basename(dir), pins.engineVersion))) return false;
  }
  return true;
};
const engineDone = async ctx => engineIntact(liveLocalLayout(ctx.folder, ctx), pinsOf(ctx.seams));
/** The model files are in place: recorded as verified, at their pinned size (the 230 MB file is hashed when it is installed, not on every read). */
const modelInPlace = async (layout, pins) => {
  const stamp = await readJson(layout.stamp);
  for (const file of pins.model) if (stamp[file.name] !== file.sha256 || (await sizeOf(path.join(layout.modelDir, file.name))) !== file.bytes) return false;
  return true;
};
/** A full disk while unpacking or copying is the disk's fault, said so. */
const spaceAware = async work => {
  try { return await work(); }
  catch (error) { if (['ENOSPC', 'EDQUOT'].includes(error?.code)) throw new InstallError('no-space', TEXT.noSpaceShort); throw error; }
};

const modelDone = async ctx => modelInPlace(liveLocalLayout(ctx.folder, ctx), pinsOf(ctx.seams));

/** Is `file` exactly the pinned one (size first, then the sha256)? */
const verified = async (file, pin) => (await sizeOf(file)) === pin.bytes && (await digestOf(file)) === pin.sha256;

const STAGES = Object.freeze([
  { id: 'engine', mutating: true, isDone: engineDone,
    async run(ctx) {
      const layout = liveLocalLayout(ctx.folder, ctx), pins = pinsOf(ctx.seams), native = pins.platforms[platformKey(ctx.platform, ctx.arch)];
      if (!native) throw new InstallError('unsupported', TEXT.unsupported);
      const all = [pins.engine, native], total = sum(all, 'bytes');
      let before = 0;
      await mkdir(layout.tmp, { recursive: true });
      for (const item of all) {
        const target = path.join(layout.modules, item.name);
        // Only a package whose recorded files are all still there (and its native files unchanged) is skipped: 修复 restores a quarantined addon.
        if ((await versionAt(target)) === pins.engineVersion && await packageIntact(await readJson(layout.engineStamp), layout.modules, item.name, pins.engineVersion)) {
          before += item.bytes; ctx.progress(before / total); continue;
        }
        const part = path.join(layout.tmp, `${item.name}-${pins.engineVersion}.tgz.part`), staging = `${target}.staging`;
        await fetchVerified(ctx, pins.registries.map(base => `${base}${item.path}`), part, { integrity: item.integrity, maxBytes: item.bytes },
          done => ctx.progress((before + done) / total));
        await spaceAware(async () => {
          await rm(staging, { recursive: true, force: true });
          await extractPackage(part, staging);
          await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          await renameWithRetry(staging, target, ctx.seams.rename ? { rename: ctx.seams.rename } : {});
          await recordPackage(layout.engineStamp, layout.modules, item.name, pins.engineVersion);
        });
        await rm(part, { force: true });
        ctx.push(`unpacked ${item.name}@${pins.engineVersion}`);
        before += item.bytes;
      }
      if (!(await engineDone(ctx))) throw new InstallError('engine-failed', TEXT.engineFailed);
    } },
  { id: 'model', mutating: true, isDone: modelDone,
    async run(ctx) {
      const layout = liveLocalLayout(ctx.folder, ctx), pins = pinsOf(ctx.seams), total = sum(pins.model, 'bytes');
      await mkdir(layout.modelDir, { recursive: true });
      const stamp = await readJson(layout.stamp), legacy = ctx.seams.legacyModelFolders ?? legacyModelFolders();
      let before = 0;
      for (const pin of pins.model) {
        const target = path.join(layout.modelDir, pin.name), part = `${target}.part`;
        if ((stamp[pin.name] === pin.sha256 && (await sizeOf(target)) === pin.bytes) || await verified(target, pin)) {
          stamp[pin.name] = pin.sha256; before += pin.bytes; ctx.progress(before / total); continue;
        }
        await rm(target, { force: true });
        // A copy the community package downloaded earlier: used when it is exactly the pinned file, so 230 MB are not downloaded twice.
        let copied = false;
        for (const folder of legacy) {
          const old = path.join(folder, pin.name);
          if ((await sizeOf(old)) !== pin.bytes) continue;
          await spaceAware(() => copyFile(old, part));
          if (await verified(part, pin)) { copied = true; ctx.push(`reused ${old} (sha256 ok)`); break; }
          await rm(part, { force: true });
        }
        if (!copied) await fetchVerified(ctx, [pin.url], part, { sha256: pin.sha256, maxBytes: pin.bytes }, done => ctx.progress((before + done) / total));
        await renameWithRetry(part, target, ctx.seams.rename ? { rename: ctx.seams.rename } : {});
        stamp[pin.name] = pin.sha256;
        await writeFile(layout.stamp, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
        before += pin.bytes;
      }
      await writeFile(layout.stamp, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
      if (!(await modelDone(ctx))) throw new InstallError('model-failed', TEXT.modelFailed);
    } },
  { id: 'check', mutating: false,
    async run(ctx) {
      const layout = liveLocalLayout(ctx.folder, ctx), paths = { enginePath: layout.enginePath, modelDir: layout.modelDir };
      try {
        const result = await ctx.observe('check', signal => (ctx.seams.checkEngine ? ctx.seams.checkEngine({ ...paths, signal }) : checkEngine({ ...paths, signal })),
          { sideEffect: false });
        ctx.push(`engine loaded${result?.version ? ` (sherpa-onnx ${result.version})` : ''}`);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        ctx.push(String(error?.message || error));
        const code = classifyFailure(error?.message) === 'vc-runtime' ? 'vc-runtime' : 'check-failed';
        throw new InstallError(code, code === 'vc-runtime' ? TEXT.vcRuntime : TEXT.checkFailed);
      }
      await rm(layout.tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    } },
]);

/** Load the engine and the model in a worker thread (lib/live-local-worker.mjs with `check`) and decode a little silence. Resolves { version }. */
export function checkEngine({ enginePath, modelDir, signal, timeoutMs = LIVE_LOCAL.checkTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./live-local-worker.mjs', import.meta.url), { workerData: { enginePath, modelDir, check: true }, stdout: true, stderr: true });
    worker.stdout?.resume(); worker.stderr?.resume();
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); void worker.terminate().catch(() => {}); fn(value); };
    const stop = () => finish(reject, signal.reason ?? new Error('cancelled'));
    const timer = setTimeout(() => finish(reject, new Error('本地识别引擎加载超时')), timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    worker.on('message', message => {
      if (message?.type === 'ready') finish(resolve, { version: message.version || '' });
      else if (message?.type === 'error') finish(reject, new Error(message.message));
    });
    worker.on('error', error => finish(reject, error));
    worker.on('exit', code => finish(reject, new Error(`本地识别引擎已退出（代码 ${code}）`)));
  });
}

/* ---------- the spec ---------- */

const FALLBACK = Object.freeze({ engine: 'engine-failed', model: 'model-failed', check: 'check-failed' });
export const LIVE_LOCAL_FAILURE_TEXT = Object.freeze({
  network: TEXT.network, checksum: TEXT.checksum, 'no-space': TEXT.noSpaceShort, 'not-writable': TEXT.notWritable, unsupported: TEXT.unsupported,
  'vc-runtime': TEXT.vcRuntime, 'engine-failed': TEXT.engineFailed, 'model-failed': TEXT.modelFailed, 'check-failed': TEXT.checkFailed,
});
const explain = (stage, text) => {
  const code = classifyFailure(text);
  const chosen = code && LIVE_LOCAL_FAILURE_TEXT[code] ? code : FALLBACK[stage] || 'engine-failed';
  return { code: chosen, message: LIVE_LOCAL_FAILURE_TEXT[chosen] };
};
const stageIndex = id => LIVE_LOCAL.stages.indexOf(id);

/** The install as the engine runs it. `seams` (tests, previews): platform, arch, fetch, pins, drives(), freeMegabytes(folder), legacyModelFolders,
 *  checkEngine({ enginePath, modelDir, signal }), liveRunning(), row(run). */
export const LIVE_LOCAL_SPEC = Object.freeze({
  id: 'live-local', versionKey: 'liveLocalInstall', label: 'Local live engine install state', stateFile: liveLocalInstallStatePath,
  sentinel: LIVE_LOCAL.sentinel, createdBy: LIVE_LOCAL.createdBy, folderName: LIVE_LOCAL.folderName, children: LIVE_LOCAL.children, trackParents: true,
  logLines: LIVE_LOCAL.logLines, lineLength: LIVE_LOCAL.lineLength, reportRemoved: true, cleanAbandoned: true,
  messages: TEXT,
  explain,
  unknownFailure: stage => { const code = FALLBACK[stage] || 'engine-failed'; return { code, message: LIVE_LOCAL_FAILURE_TEXT[code] }; },
  plan: (args, { platform, seams, live }) => planLiveLocalInstall(args, { platform, seams, live }),
  prepare: checked => ({ platformKey: platformKey(checked.platform, checked.arch) }),
  stateOf: prepared => ({ platformKey: prepared.platformKey, engineVersion: LIVE_LOCAL.engineVersion, done: [] }),
  // Installed means usable: both engine packages still as installed (a quarantined or altered addon is not) and the model files in place.
  installedProgram: async (folder, { platform, seams }) => {
    const layout = liveLocalLayout(folder, { platform, arch: seams?.arch, seams }), pins = pinsOf(seams);
    return await engineIntact(layout, pins) && await modelInPlace(layout, pins);
  },
  view: (state, { status, error, installed }) => {
    const done = Array.isArray(state.done) ? state.done.filter(id => LIVE_LOCAL.stages.includes(id)) : [];
    const at = stageIndex(state.stage);
    return { status, stage: state.stage || '', stageName: LIVE_LOCAL_STAGE_NAMES[state.stage] || '', stages: [...LIVE_LOCAL.stages], done,
      step: status === 'complete' ? LIVE_LOCAL.stages.length : at >= 0 ? at + 1 : 0, of: LIVE_LOCAL.stages.length,
      folder: state.folder || '', installedFolder: installed ? state.installedFolder : '', installed, ready: installed,
      // Installed once, but its files are not what was installed any more (deleted or changed afterwards): 修复 in that folder restores them.
      needsRepair: !installed && status === 'complete' && !!state.installedFolder,
      engineVersion: state.engineVersion || '', startedAt: state.startedAt || '', finishedAt: state.finishedAt || '', lastLine: state.lastLine || '',
      log: Array.isArray(state.log) ? state.log : [], error,
      ...(Number.isFinite(state.stageFraction) && status === 'running' ? { stageFraction: state.stageFraction } : {}) };
  },
  async ready(ctx) { ctx.arch = ctx.seams.arch || process.arch; await mkdir(liveLocalLayout(ctx.folder, ctx).tmp, { recursive: true }).catch(() => {}); },
  stages: STAGES,
  async beforeUninstall({ seams }) { if (seams.liveRunning?.()) throw new InstallError('live-running', TEXT.liveRunning); },
  error: (code, message, options) => new InstallError(code, message, options),
});

/** The installer for this DSH home. */
export const createLiveLocalInstaller = (seams = {}) => createToolInstaller(LIVE_LOCAL_SPEC, seams);

/** The engine 课堂实录 runs: StudyHub's own finished install (its sentinel, its engine and its model are there). Resolves { enginePath, modelDir, folder } or null. */
export async function effectiveLiveLocal({ seams = {}, platform = process.platform } = {}) {
  const state = await readState(liveLocalInstallStatePath(), 'liveLocalInstall');
  const folder = typeof state?.installedFolder === 'string' ? state.installedFolder : '';
  if (!folder || !(await readSentinel(folder, LIVE_LOCAL_SPEC, platform))) return null;
  if (!(await LIVE_LOCAL_SPEC.installedProgram(folder, { platform, seams }))) return null;
  const layout = liveLocalLayout(folder, { platform, arch: seams.arch, seams });
  return { enginePath: layout.enginePath, modelDir: layout.modelDir, folder };
}
