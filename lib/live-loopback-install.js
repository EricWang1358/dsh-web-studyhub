import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runLocalCommand } from './local-command.js';
import { InstallError, classifyFailure, createToolInstaller, exists, flavourOf, freeMegabytes, readSentinel, readState, resolveInstallFolder, writable } from './tool-install.js';
import { defaultDataFolder, driveOfPath, fixedDrives } from './install-drives.js';
import { digestOf } from './uv-bootstrap.js';
import { retryDenied } from './atomic-json.js';
import { readJson, renameWithRetry } from './live-local-files.js';
import { LIVE_LOOPBACK_MESSAGES as TEXT, LIVE_LOOPBACK_STAGE_NAMES } from './live-loopback-install-text.js';
import { LIVE_LOOPBACK_CS_SOURCE, LIVE_LOOPBACK_HELPER_VERSION, LIVE_LOOPBACK_SOURCE_SHA256 } from './live-loopback-source.js';

/* On-demand hot-installer for 课堂实录's system-audio loopback helper (lib/live-loopback.js):
   - Nothing ships pre-installed or running in the background;
   - On learner click, compiles the pinned user-mode WASAPI loopback helper locally via Windows' built-in .NET Framework csc.exe into <F>\bin\studyhub-loopback.exe,
     records its exact byte size and sha256 (<F>\bin\.verified.json), and runs a read-only --probe check (< 100 ms, zero open audio stream);
   - Every launch re-verifies the binary's size and sha256 so an altered or quarantined file is never executed ("needs repair");
   - One-click uninstall removes <F>\bin, <F>\tmp, sentinel and empty created folders cleanly. */

export const LIVE_LOOPBACK = Object.freeze({
  stages: Object.freeze(['compile', 'check']),
  mutatingStages: Object.freeze(['compile']),
  helperVersion: LIVE_LOOPBACK_HELPER_VERSION,
  sourceSha256: LIVE_LOOPBACK_SOURCE_SHA256,
  exeName: 'studyhub-loopback.exe',
  tested: Object.freeze(['win32-x64']),
  neededMb: 5,
  estimatedExeBytes: 20_480,
  folderName: 'StudyHub-LiveLoopback',
  sentinel: '.studyhub-live-loopback.json',
  createdBy: 'studyhub-live-loopback-installer',
  children: Object.freeze(['bin', 'tmp']),
  compileTimeoutMs: 30_000,
  probeTimeoutMs: 10_000,
  logLines: 120,
  lineLength: 300,
});

const dshHome = () => process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
export const liveLoopbackInstallStatePath = () => path.join(dshHome(), 'study', 'live-loopback-install.json');
export const liveLoopbackDataFolder = () => path.join(dshHome(), 'studyhub', 'live-loopback');
export const loopbackPlatformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

export function liveLoopbackLayout(folder, { platform = process.platform } = {}) {
  const f = flavourOf(platform), binDir = f.join(folder, 'bin');
  return {
    folder,
    binDir,
    exePath: f.join(binDir, LIVE_LOOPBACK.exeName),
    stamp: f.join(binDir, '.verified.json'),
    tmp: f.join(folder, 'tmp'),
  };
}

/** Locate Windows' built-in .NET Framework 4.x csc.exe (64-bit preferred, 32-bit fallback), or a test's seam. */
export async function findWindowsCsc({ platform = process.platform, env = process.env, seams = {} } = {}) {
  if (seams.cscPath !== undefined) return seams.cscPath;
  if ((seams.osPlatform || platform) !== 'win32') return null;
  const winDir = env.SystemRoot?.trim() || env.WINDIR?.trim() || 'C:\\Windows';
  const candidates = [
    path.win32.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.win32.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

const sizeText = mb => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(0, Math.round(mb))} MB`);
const problem = (code, message) => ({ code, message });
const sizeOf = (file, statFile = stat) => retryDenied(() => statFile(file), { tries: 5 }).then(info => info.size, () => -1);

/** Is the installed helper binary intact and matching the exact sha256 recorded when StudyHub compiled this version? */
export async function loopbackIntact(layout, { read, stat: statFile, digest = digestOf } = {}) {
  const stamp = await readJson(layout.stamp, read ? { read } : {});
  if (stamp.helperVersion !== LIVE_LOOPBACK.helperVersion || stamp.sourceSha256 !== LIVE_LOOPBACK.sourceSha256) return false;
  if (!Number.isInteger(stamp.exeBytes) || stamp.exeBytes <= 0 || typeof stamp.exeSha256 !== 'string' || stamp.exeSha256.length !== 64) return false;
  if ((await sizeOf(layout.exePath, statFile)) !== stamp.exeBytes) return false;
  return (await retryDenied(() => digest(layout.exePath), { tries: 5 }).catch(() => '')) === stamp.exeSha256;
}

export async function planLiveLoopbackInstall(args = {}, { platform = process.platform, seams = {}, live } = {}) {
  const osPlatform = seams.osPlatform || platform;
  const arch = seams.arch || process.arch, key = loopbackPlatformKey(osPlatform, arch);
  const problems = [], supported = osPlatform === 'win32';
  if (!supported) problems.push(problem('unsupported', TEXT.unsupported));
  else if (!(await findWindowsCsc({ platform: osPlatform, seams }))) problems.push(problem('no-compiler', TEXT.noCompiler));
  const neededMb = seams.neededMb ?? LIVE_LOOPBACK.neededMb;
  const drives = seams.drives ? await seams.drives() : await fixedDrives({ platform });
  const fallback = defaultDataFolder({ leaf: ['StudyHub', 'LiveLoopback'], neededMb, drives, dataFolder: liveLoopbackDataFolder() });
  const where = await resolveInstallFolder(args.location, { spec: LIVE_LOOPBACK_SPEC, platform, defaultFolder: fallback.folder });
  const folder = where.folder || fallback.folder;
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
  const layout = liveLoopbackLayout(folder, { platform });
  return {
    ok: problems.length === 0, problems, warnings: [], folder, adjusted: !!where.adjusted, defaultFolder: fallback.folder, defaultReason: fallback.reason,
    platform: osPlatform, arch, supported, tested: LIVE_LOOPBACK.tested.includes(key), helperVersion: LIVE_LOOPBACK.helperVersion,
    drives: drives.map(item => ({ ...item, recommended: !!fallback.drive && item.root === fallback.drive.root, folder: flavourOf('win32').join(item.root, 'StudyHub', 'LiveLoopback') })),
    disk: { freeMb, neededMb, drive }, estimate: { downloadMb: 0, diskMb: 1 },
    files: [{ name: LIVE_LOOPBACK.exeName, bytes: LIVE_LOOPBACK.estimatedExeBytes, where: layout.exePath }],
  };
}

/** Run `--probe` on the compiled helper to confirm COM + MMDeviceEnumerator respond cleanly without opening an audio stream. */
export async function probeLoopbackHelper({ exePath, signal, timeoutMs = LIVE_LOOPBACK.probeTimeoutMs }) {
  const res = await runLocalCommand({ file: exePath }, ['--probe'], { signal, timeoutMs });
  if (res.code !== 0) throw new Error((res.stdout || res.stderr || `exit ${res.code}`).trim());
  const line = res.stdout.trim().split(/\r?\n/).map(item => item.trim()).find(item => item.startsWith('{')) || '';
  let parsed;
  try { parsed = line ? JSON.parse(line) : null; }
  catch { throw new Error((res.stderr || res.stdout || 'invalid probe output').trim()); }
  if (!parsed?.ok) throw new Error(parsed?.error || (res.stderr || res.stdout || `hr ${parsed?.hr ?? 'unknown'}`).trim());
  return parsed;
}

const spaceAware = async work => {
  try { return await work(); }
  catch (error) { if (['ENOSPC', 'EDQUOT'].includes(error?.code)) throw new InstallError('no-space', TEXT.noSpaceShort); throw error; }
};

const compileDone = ctx => loopbackIntact(liveLoopbackLayout(ctx.folder, ctx));

const STAGES = Object.freeze([
  { id: 'compile', mutating: true, isDone: compileDone,
    async run(ctx) {
      const osPlatform = ctx.seams.osPlatform || ctx.platform;
      if (osPlatform !== 'win32') throw new InstallError('unsupported', TEXT.unsupported);
      const layout = liveLoopbackLayout(ctx.folder, ctx);
      if (await loopbackIntact(layout)) { ctx.progress(1); return; }
      const csc = await findWindowsCsc({ platform: osPlatform, seams: ctx.seams });
      if (!csc && !ctx.seams.compile) throw new InstallError('no-compiler', TEXT.noCompiler);
      await mkdir(layout.tmp, { recursive: true });
      await mkdir(layout.binDir, { recursive: true });
      const csFile = path.join(layout.tmp, 'studyhub-loopback.cs');
      const partExe = path.join(layout.tmp, `${LIVE_LOOPBACK.exeName}.part`);
      await spaceAware(async () => {
        await rm(partExe, { force: true });
        await writeFile(csFile, `\uFEFF${LIVE_LOOPBACK_CS_SOURCE}`, 'utf8');
      });
      ctx.progress(0.25);
      const compiled = await ctx.observe('compile', async signal => {
        if (ctx.seams.compile) return ctx.seams.compile({ csc, csFile, outExe: partExe, signal });
        return runLocalCommand({ file: csc }, ['/nologo', '/optimize+', '/target:exe', `/out:${partExe}`, csFile],
          { signal, timeoutMs: LIVE_LOOPBACK.compileTimeoutMs, onLine: line => ctx.push(line) });
      }, { sideEffect: true });
      if (compiled?.code !== 0 || (await sizeOf(partExe)) <= 0) {
        if (compiled?.stdout) ctx.push(compiled.stdout);
        if (compiled?.stderr) ctx.push(compiled.stderr);
        const explained = explain('compile', `${compiled?.stderr || ''}\n${compiled?.stdout || ''}`);
        throw new InstallError(explained.code, explained.message);
      }
      ctx.progress(0.8);
      await spaceAware(async () => {
        const exeBytes = await sizeOf(partExe), exeSha256 = await digestOf(partExe);
        await rm(layout.exePath, { force: true, maxRetries: 5, retryDelay: 100 });
        await renameWithRetry(partExe, layout.exePath, ctx.seams.rename ? { rename: ctx.seams.rename } : {});
        await writeFile(layout.stamp, `${JSON.stringify({
          helperVersion: LIVE_LOOPBACK.helperVersion,
          sourceSha256: LIVE_LOOPBACK.sourceSha256,
          exeBytes,
          exeSha256,
        }, null, 2)}\n`, 'utf8');
      });
      ctx.push(`compiled ${LIVE_LOOPBACK.exeName} (sha256 ok)`);
      ctx.progress(1);
      if (!(await compileDone(ctx))) throw new InstallError('compile-failed', TEXT.compileFailed);
    } },
  { id: 'check', mutating: false,
    async run(ctx) {
      const layout = liveLoopbackLayout(ctx.folder, ctx);
      try {
        const result = await ctx.observe('check', signal => (ctx.seams.probeHelper
          ? ctx.seams.probeHelper({ exePath: layout.exePath, signal })
          : probeLoopbackHelper({ exePath: layout.exePath, signal })), { sideEffect: false });
        ctx.push(`wasapi probe ok${result?.device ? ` (${result.device})` : result?.noDevice ? ' (no active output device)' : ''}`);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        ctx.push(String(error?.message || error));
        throw new InstallError('check-failed', TEXT.checkFailed);
      }
      await rm(layout.tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    } },
]);

const FALLBACK = Object.freeze({ compile: 'compile-failed', check: 'check-failed' });
export const LIVE_LOOPBACK_FAILURE_TEXT = Object.freeze({
  'no-space': TEXT.noSpaceShort, 'not-writable': TEXT.notWritable, 'path-too-long': TEXT.pathTooLong,
  unsupported: TEXT.unsupported, 'no-compiler': TEXT.noCompiler, 'compile-failed': TEXT.compileFailed, 'check-failed': TEXT.checkFailed,
});
const explain = (stage, text) => {
  const code = classifyFailure(text);
  const chosen = code && LIVE_LOOPBACK_FAILURE_TEXT[code] ? code : FALLBACK[stage] || 'compile-failed';
  return { code: chosen, message: LIVE_LOOPBACK_FAILURE_TEXT[chosen] };
};
const stageIndex = id => LIVE_LOOPBACK.stages.indexOf(id);

export const LIVE_LOOPBACK_SPEC = Object.freeze({
  id: 'live-loopback', versionKey: 'liveLoopbackInstall', label: 'Local system-audio helper install state', stateFile: liveLoopbackInstallStatePath,
  sentinel: LIVE_LOOPBACK.sentinel, createdBy: LIVE_LOOPBACK.createdBy, folderName: LIVE_LOOPBACK.folderName, children: LIVE_LOOPBACK.children, trackParents: true,
  logLines: LIVE_LOOPBACK.logLines, lineLength: LIVE_LOOPBACK.lineLength, reportRemoved: true, cleanAbandoned: true,
  messages: TEXT,
  explain,
  unknownFailure: stage => { const code = FALLBACK[stage] || 'compile-failed'; return { code, message: LIVE_LOOPBACK_FAILURE_TEXT[code] }; },
  plan: (args, { platform, seams, live }) => planLiveLoopbackInstall(args, { platform, seams, live }),
  prepare: checked => ({ platformKey: loopbackPlatformKey(checked.platform, checked.arch) }),
  stateOf: prepared => ({ platformKey: prepared.platformKey, helperVersion: LIVE_LOOPBACK.helperVersion, done: [] }),
  installedProgram: (folder, { platform }) => loopbackIntact(liveLoopbackLayout(folder, { platform })),
  view: (state, { status, error, installed }) => {
    const done = Array.isArray(state.done) ? state.done.filter(id => LIVE_LOOPBACK.stages.includes(id)) : [];
    const at = stageIndex(state.stage);
    return {
      status, stage: state.stage || '', stageName: LIVE_LOOPBACK_STAGE_NAMES[state.stage] || '', stages: [...LIVE_LOOPBACK.stages], done,
      step: status === 'complete' ? LIVE_LOOPBACK.stages.length : at >= 0 ? at + 1 : 0, of: LIVE_LOOPBACK.stages.length,
      folder: state.folder || '', installedFolder: installed ? state.installedFolder : '', installed, ready: installed,
      needsRepair: !installed && status === 'complete' && !!state.installedFolder,
      helperVersion: state.helperVersion || '', startedAt: state.startedAt || '', finishedAt: state.finishedAt || '', lastLine: state.lastLine || '',
      log: Array.isArray(state.log) ? state.log : [], error,
      ...(Number.isFinite(state.stageFraction) && status === 'running' ? { stageFraction: state.stageFraction } : {}),
    };
  },
  async ready(ctx) { ctx.arch = ctx.seams.arch || process.arch; await mkdir(liveLoopbackLayout(ctx.folder, ctx).tmp, { recursive: true }).catch(() => {}); },
  stages: STAGES,
  async beforeUninstall({ seams }) { if (seams.liveRunning?.()) throw new InstallError('live-running', TEXT.liveRunning); },
  error: (code, message, options) => new InstallError(code, message, options),
});

export const createLiveLoopbackInstaller = (seams = {}) => createToolInstaller(LIVE_LOOPBACK_SPEC, seams);

/** Return the verified system-audio helper { exePath, folder } when installed and intact, else null. */
export async function effectiveLiveLoopback({ seams = {}, platform = process.platform } = {}) {
  const state = await readState(liveLoopbackInstallStatePath(), 'liveLoopbackInstall');
  const folder = typeof state?.installedFolder === 'string' ? state.installedFolder : '';
  if (!folder || !(await readSentinel(folder, LIVE_LOOPBACK_SPEC, platform))) return null;
  if (!(await LIVE_LOOPBACK_SPEC.installedProgram(folder, { platform, seams }))) return null;
  const layout = liveLoopbackLayout(folder, { platform });
  return { exePath: layout.exePath, folder };
}
