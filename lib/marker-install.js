import { access, mkdir, readFile, readdir, rename, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLocalCommand } from './local-command.js';
import { detectMarker, locateMarker } from './marker-local.js';
import { markerSettingsPath, readMarkerSettings, saveMarkerSettings } from './marker-settings.js';
import { UnsupportedVersionError, knownVersion } from './stored-version.js';

/* One-click Marker setup: a private Python virtual environment with `marker-pdf` in it, made only when the learner asks.
   Four stages (create-venv, install, verify, configure); the last one writes the environment's `marker_single` into the Marker
   settings, so the existing detection and conversion take over unchanged. Everything that is only an estimate or a channel lives
   in MARKER_INSTALL, so the UI and the tests read one place. The installer never touches a folder it did not create: a folder
   carries a sentinel file, and only a folder with that sentinel is ever removed (its `venv` subfolder and the sentinel). */

export const MARKER_INSTALL = Object.freeze({
  /** marker-pdf declares Python >=3.10. */
  minPython: Object.freeze([3, 10]),
  stages: Object.freeze(['create-venv', 'install', 'verify', 'configure']),
  /** The stages that change the install folder: repeating one is not harmless, so a Job declares them as side effects. */
  mutatingStages: Object.freeze(['create-venv', 'install']),
  /** Estimates for the learner, per platform: what pip downloads, and the free space worth having (the first conversion downloads models on top). */
  downloadMb: Object.freeze({ win32: 1500, darwin: 1200, linux: 3500 }),
  neededMb: Object.freeze({ win32: 4000, darwin: 3500, linux: 8000 }),
  minutes: Object.freeze([5, 20]),
  logLines: 200,
  lineLength: 300,
  folderName: 'StudyHub-Marker',
  sentinel: '.studyhub-marker.json',
  mirrors: Object.freeze([
    Object.freeze({ id: 'tsinghua', reach: 'mainland', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' }),
    Object.freeze({ id: 'official', reach: 'overseas', url: '' }),
  ]),
  /** Where to get Python when there is none: a mainland-reachable mirror first, then the official installer. */
  pythonChannels: Object.freeze([
    Object.freeze({ id: 'npmmirror', reach: 'mainland', url: 'https://registry.npmmirror.com/binary.html?path=python/' }),
    Object.freeze({ id: 'huawei', reach: 'mainland', url: 'https://mirrors.huaweicloud.com/python/' }),
    Object.freeze({ id: 'official', reach: 'overseas', url: 'https://www.python.org/downloads/' }),
  ]),
  recommendedPython: '3.12',
  /** What pip installs. marker-pdf 2.x runs its OCR models through a separate inference server that it starts in Docker by default, so on a computer without Docker
   *  every conversion that needs OCR fails; the 1.x line (1.10.2 pins surya-ocr <0.18 and transformers <5) runs the models in-process with plain torch. */
  /** (lib/marker-local.js MARKER_SUPPORTED_MAJOR is the line the check accepts; installing again into the same folder is the repair of a 2.x install.) */
  requirement: 'marker-pdf>=1.10,<2',
  commandTimeoutMs: Object.freeze({ venv: 3 * 60_000, pip: 90 * 60_000, verify: 60_000, probe: 10_000 }),
});

export class MarkerInstallError extends Error {
  constructor(code, message) { super(message); this.name = 'MarkerInstallError'; this.code = code; }
}

export const INSTALL_MESSAGES = Object.freeze({
  pythonMissing: '没有找到 Python。请先安装 Python 3.10 或更新版本，装好后再点「一键安装 Marker」。',
  pythonTooOld: '找到的 Python 版本太旧（Marker 需要 3.10 或更新版本）。请安装新版 Python 后重试。',
  noVenv: '这个 Python 缺少创建虚拟环境的组件（venv / ensurepip）。Linux 上可安装 python3-venv 和 python3-pip 后重试。',
  noSpace: '安装位置所在磁盘的剩余空间不够。请换一个位置，或清理磁盘后重试。',
  badLocation: '这个安装位置不能用。请选择一个已存在或可以新建的文件夹的完整路径。',
  folderInUse: '这个位置里已经有别的文件，StudyHub 不会往里面安装。请选一个空文件夹，或让它在里面新建「StudyHub-Marker」。',
  notWritable: '这个位置没有写入权限，请换一个位置。',
  badMirror: '没有这个下载源。',
  busy: 'Marker 正在安装，请等它完成或先取消。',
  needConfirm: '安装 Marker 会下载并占用磁盘空间，需要先确认：请传 confirm: true。',
  needConfirmUninstall: '卸载前需要先确认：请传 confirm: true。只会删除 StudyHub 创建的这个环境。',
  notOurs: '这个文件夹不是 StudyHub 创建的 Marker 环境，不会删除其中任何内容。',
  uninstallBusy: 'Marker 正在安装，请先取消再卸载。',
  venvFailed: '没能创建 Python 虚拟环境。',
  pipNetwork: '下载 marker-pdf 失败，多半是网络不通。',
  pipNoSpace: '磁盘空间不足，安装中断。',
  pipPermission: '没有权限写入安装位置。',
  pipPython: '这个 Python 版本装不上 marker-pdf。',
  pipFailed: 'marker-pdf 没有安装成功。',
  verifyMissing: '安装结束了，但没有找到 marker_single 程序。',
  verifyFailed: '装好的 Marker 没能通过检测（版本可能与 StudyHub 不兼容）。',
  configureFailed: '装好了，但没能把程序路径写进设置。',
  interrupted: '上次安装被中断（StudyHub 关闭或重启）。',
  cancelled: '已取消安装。',
});

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);
const hide = line => line.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***@');
const home = () => process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
const flavourOf = platform => (platform === 'win32' ? path.win32 : path.posix);

export const defaultMarkerFolder = () => path.join(home(), 'studyhub', 'marker');
export const markerInstallStatePath = () => path.join(path.dirname(markerSettingsPath()), 'marker-install.json');

/** The files of a Marker environment under an install folder. */
export function venvLayout(folder, platform = process.platform) {
  const flavour = flavourOf(platform), venv = flavour.join(folder, 'venv'), bin = flavour.join(venv, platform === 'win32' ? 'Scripts' : 'bin');
  return { folder, venv, bin, python: flavour.join(bin, platform === 'win32' ? 'python.exe' : 'python'), marker: flavour.join(bin, platform === 'win32' ? 'marker_single.exe' : 'marker_single'),
    sentinel: flavour.join(folder, MARKER_INSTALL.sentinel) };
}

/** The commands the installer runs, as the learner would read them. */
export function installCommands({ folder, mirror, python = 'python', platform = process.platform }) {
  const layout = venvLayout(folder, platform), url = MARKER_INSTALL.mirrors.find(item => item.id === mirror)?.url;
  return [
    { stage: 'create-venv', command: `${python} -m venv "${layout.venv}"` },
    { stage: 'install', command: `"${layout.python}" -m pip install${url ? ` --index-url ${url}` : ''} "${MARKER_INSTALL.requirement}"` },
    { stage: 'verify', command: `"${layout.marker}" --help` },
  ];
}

/* ---------- finding Python ---------- */

const PYTHON_VERSION = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i;
const versionAtLeast = ([major, minor], [needMajor, needMinor]) => major > needMajor || (major === needMajor && minor >= needMinor);

export function pythonCandidates(platform = process.platform) {
  return platform === 'win32'
    ? [{ file: 'py', prefix: ['-3'] }, { file: 'python' }, { file: 'python3' }]
    : [{ file: 'python3' }, { file: 'python3.12' }, { file: 'python3.11' }, { file: 'python3.10' }, { file: 'python' }];
}

async function probe(candidate, signal) {
  const cli = { prefix: [], env: {}, ...candidate };
  try {
    const result = await runLocalCommand(cli, ['--version'], { signal, timeoutMs: MARKER_INSTALL.commandTimeoutMs.probe });
    const match = PYTHON_VERSION.exec(`${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 || !match) return null;
    return { cli, version: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] };
  } catch (error) { if (signal?.aborted) throw error; return null; }
}

/** The first Python that is new enough; when only older ones exist, the newest of those. Resolves { cli, version } or { tooOld } or null. */
export async function findPython({ candidates, platform = process.platform, signal } = {}) {
  let tooOld = null;
  for (const candidate of candidates ?? pythonCandidates(platform)) {
    const found = await probe(candidate, signal);
    if (!found) continue;
    if (versionAtLeast(found.version, MARKER_INSTALL.minPython)) return found;
    if (!tooOld || versionAtLeast(found.version, tooOld.version)) tooOld = found;
  }
  return tooOld ? { tooOld: tooOld.version } : null;
}

/* ---------- the install folder and the sentinel ---------- */

async function exists(file) { try { await stat(file); return true; } catch { return false; } }
async function nearestExisting(target, flavour) {
  let current = target;
  for (;;) {
    try { const info = await stat(current); return { path: current, directory: info.isDirectory() }; }
    catch { const parent = flavour.dirname(current); if (parent === current) return null; current = parent; }
  }
}
async function readSentinel(folder, platform) {
  try {
    const value = JSON.parse(await readFile(venvLayout(folder, platform).sentinel, 'utf8'));
    return value?.createdBy === 'studyhub-marker-installer' ? value : null;
  } catch { return null; }
}
async function emptyFolder(folder) { try { return !(await readdir(folder)).length; } catch { return false; } }

/** The folder an install would really use: the one asked for when it is new, empty or ours, else a StudyHub-Marker folder inside it. */
export async function resolveInstallFolder(location, { platform = process.platform } = {}) {
  const flavour = flavourOf(platform);
  const asked = typeof location === 'string' && location.trim() ? location.trim() : defaultMarkerFolder();
  if (/[\u0000\r\n]/.test(asked) || !flavour.isAbsolute(asked)) return { problem: 'bad-location', folder: asked };
  const folder = flavour.resolve(asked);
  let info = null;
  try { info = await stat(folder); } catch { /* it will be created */ }
  if (!info) return { folder };
  if (!info.isDirectory()) return { problem: 'bad-location', folder };
  if ((await emptyFolder(folder)) || await readSentinel(folder, platform)) return { folder };
  const inner = flavour.join(folder, MARKER_INSTALL.folderName);
  let innerInfo = null;
  try { innerInfo = await stat(inner); } catch { /* new */ }
  if (!innerInfo) return { folder: inner, adjusted: true };
  if (innerInfo.isDirectory() && ((await emptyFolder(inner)) || await readSentinel(inner, platform))) return { folder: inner, adjusted: true };
  return { problem: 'folder-in-use', folder };
}

async function freeMegabytes(folder, platform) {
  const near = await nearestExisting(folder, flavourOf(platform));
  if (!near) return null;
  try { const info = await statfs(near.path); return Math.floor((Number(info.bavail) * Number(info.bsize)) / 1_048_576); } catch { return null; }
}

/* ---------- the plan ---------- */

const problem = (code, message) => ({ code, message });
const mirrorView = item => ({ id: item.id, reach: item.reach, url: item.url || null });

/** What one-click install would do here, from read-only checks: Python, free space, the folder. Never creates or installs anything. */
export async function planMarkerInstall({ location, mirror = 'official', seams = {}, signal } = {}) {
  const platform = seams.platform || process.platform;
  const problems = [];
  const chosen = MARKER_INSTALL.mirrors.find(item => item.id === mirror);
  if (!chosen) throw new MarkerInstallError('bad-mirror', INSTALL_MESSAGES.badMirror);
  const where = await resolveInstallFolder(location, { platform });
  if (where.problem === 'bad-location') problems.push(problem('bad-location', INSTALL_MESSAGES.badLocation));
  if (where.problem === 'folder-in-use') problems.push(problem('folder-in-use', INSTALL_MESSAGES.folderInUse));
  const python = await findPython({ candidates: seams.pythons, platform, signal });
  let found = null;
  if (!python) problems.push(problem('python-missing', INSTALL_MESSAGES.pythonMissing));
  else if (python.tooOld) problems.push(problem('python-too-old', INSTALL_MESSAGES.pythonTooOld));
  else {
    found = { version: python.version.join('.'), command: [python.cli.file, ...(python.cli.prefix || [])].join(' ') };
    try {
      const venv = await runLocalCommand(python.cli, ['-c', 'import venv, ensurepip'], { signal, timeoutMs: MARKER_INSTALL.commandTimeoutMs.probe });
      if (venv.code !== 0) problems.push(problem('no-venv', INSTALL_MESSAGES.noVenv));
    } catch (error) { if (signal?.aborted) throw error; problems.push(problem('no-venv', INSTALL_MESSAGES.noVenv)); }
  }
  const neededMb = MARKER_INSTALL.neededMb[platform] ?? MARKER_INSTALL.neededMb.linux, downloadMb = MARKER_INSTALL.downloadMb[platform] ?? MARKER_INSTALL.downloadMb.linux;
  let freeMb = null;
  if (where.folder && !where.problem) {
    const free = seams.freeMegabytes ? await seams.freeMegabytes(where.folder) : await freeMegabytes(where.folder, platform);
    freeMb = typeof free === 'number' ? free : null;
    const near = await nearestExisting(where.folder, flavourOf(platform));
    if (near && near.directory) {
      try { await access(near.path, constants.W_OK); } catch { problems.push(problem('not-writable', INSTALL_MESSAGES.notWritable)); }
    } else if (near) problems.push(problem('bad-location', INSTALL_MESSAGES.badLocation));
    if (freeMb !== null && freeMb < neededMb) problems.push(problem('no-space', INSTALL_MESSAGES.noSpace));
  }
  const folder = where.folder || defaultMarkerFolder();
  const missing = problems.some(item => item.code === 'python-missing' || item.code === 'python-too-old');
  const existing = !where.problem && !!(await readSentinel(folder, platform));
  return {
    ok: problems.length === 0, problems, folder, adjusted: !!where.adjusted, existing, defaultFolder: defaultMarkerFolder(), platform,
    python: found, minPython: MARKER_INSTALL.minPython.join('.'), recommendedPython: MARKER_INSTALL.recommendedPython,
    disk: { freeMb, neededMb }, estimate: { downloadMb, minutes: [...MARKER_INSTALL.minutes] },
    mirror: chosen.id, mirrors: MARKER_INSTALL.mirrors.map(mirrorView),
    ...(missing ? { channels: MARKER_INSTALL.pythonChannels.map(mirrorView) } : {}),
    commands: installCommands({ folder, mirror: chosen.id, python: found?.command || 'python', platform }),
  };
}

/* ---------- reading why pip failed ---------- */

export function explainFailure(stage, text) {
  const said = String(text ?? '');
  if (stage === 'create-venv') return { code: 'venv-failed', message: INSTALL_MESSAGES.venvFailed };
  if (/No space left|ENOSPC|not enough space|磁盘空间不足/i.test(said)) return { code: 'no-space', message: INSTALL_MESSAGES.pipNoSpace };
  if (/Permission denied|Access is denied|EACCES|WinError 5\b/i.test(said)) return { code: 'not-writable', message: INSTALL_MESSAGES.pipPermission };
  if (/requires a different Python|Requires-Python|No matching distribution found for [^\n]*python/i.test(said)) return { code: 'python-too-old', message: INSTALL_MESSAGES.pipPython };
  if (/Could not find a version|No matching distribution|Connection|timed out|Temporary failure|Name or service not known|getaddrinfo|ProxyError|SSLError|Read timed out|Max retries/i.test(said)) return { code: 'network', message: INSTALL_MESSAGES.pipNetwork };
  return { code: 'pip-failed', message: INSTALL_MESSAGES.pipFailed };
}

/* ---------- durable state ---------- */

async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    // A state file of a later format is not read as v1: it shows as idle, and writeState refuses to write over it.
    if (!knownVersion('markerInstall', value)) return { laterVersion: value.version };
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}
async function writeState(file, state) {
  const current = await readState(file);
  if (current.laterVersion !== undefined) throw new UnsupportedVersionError('Marker install state', current.laterVersion);
  const temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

/** Runs by state file: a restart (a new process, or a new service) finds the file, not the run. */
const live = new Map();

const samePath = (a, b, platform) => (platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const inside = (child, parent, platform) => {
  const flavour = flavourOf(platform), relative = flavour.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !flavour.isAbsolute(relative);
};

/**
 * The Marker command the app runs: the saved path, or, when none is saved, the environment this installer made, while it is still there. An empty path means "find it for me" and the
 * installer's own environment is not on PATH; a saved path that was emptied (检测并保存 with a blank field) must not hide a working install. An explicit path never falls back.
 */
export async function effectiveMarkerSettings(options) { return (await effectiveMarker(options)).settings; }

/** effectiveMarkerSettings and where the program comes from, for a conversion's log: `origin` 'saved' (a path the learner saved), 'installed' (StudyHub's own install)
 *  or 'search' (PATH and ~/.local/bin); `python` the version StudyHub's install recorded. Never a path. */
export async function effectiveMarker({ platform = process.platform } = {}) {
  const saved = await readMarkerSettings();
  if (saved.command) return { settings: saved, origin: 'saved' };
  const state = await readState(markerInstallStatePath()), folder = typeof state?.installedFolder === 'string' ? state.installedFolder : '';
  if (!folder || !(await readSentinel(folder, platform))) return { settings: saved, origin: 'search' };
  const { marker } = venvLayout(folder, platform);
  const python = typeof state.python?.version === 'string' ? state.python.version.slice(0, 20) : '';
  return (await exists(marker)) ? { settings: { ...saved, command: marker }, origin: 'installed', ...(python ? { python } : {}) } : { settings: saved, origin: 'search' };
}

/** The installer for this DSH home. `seams` are for tests and previews: pythons, freeMegabytes, venvPython(folder), markerCli(folder), platform. */
export function createMarkerInstaller(seams = {}) {
  const platform = seams.platform || process.platform;
  const view = async (state, run) => {
    const status = state.status === 'running' && !run ? 'interrupted' : state.status || 'idle';
    const folder = state.folder || '';
    const layout = state.installedFolder ? venvLayout(state.installedFolder, platform) : null;
    const installed = !!layout && !!(await readSentinel(state.installedFolder, platform)) && await exists(layout.marker);
    return { status, stage: state.stage || '', stages: [...MARKER_INSTALL.stages], folder, mirror: state.mirror || '', python: state.python || null, startedAt: state.startedAt || '', finishedAt: state.finishedAt || '',
      lastLine: state.lastLine || '', log: Array.isArray(state.log) ? state.log : [], error: status === 'interrupted' ? { code: 'interrupted', message: INSTALL_MESSAGES.interrupted } : state.error || null,
      command: state.command || '', installed, installedFolder: installed ? state.installedFolder : '', defaultFolder: defaultMarkerFolder(), ...(status === 'complete' ? { needsModels: true } : {}) };
  };

  async function status() {
    const file = markerInstallStatePath(), run = live.get(file);
    const state = run ? run.state : await readState(file);
    return view(state, run);
  }

  async function plan(args = {}) { return planMarkerInstall({ location: args.location, mirror: args.mirror, seams }); }

  /** Refuse while an install is running; a run that just ended may still be writing its result, so wait for that before anything else writes the state. */
  async function quiet(message) {
    const run = live.get(markerInstallStatePath());
    if (!run) return;
    if (run.state.status === 'running') throw new MarkerInstallError('busy', message);
    await run.promise;
  }

  /** Remove one environment this installer created: its venv folder and the sentinel; the folder itself only when that leaves it empty. */
  async function removeCreated(folder) {
    if (!folder || !(await readSentinel(folder, platform))) throw new MarkerInstallError('not-ours', INSTALL_MESSAGES.notOurs);
    const layout = venvLayout(folder, platform);
    await rm(layout.venv, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(layout.sentinel, { force: true });
    await rmdir(folder).catch(() => {});
    const settings = await readMarkerSettings();
    if (settings.command && (samePath(settings.command, layout.marker, platform) || inside(settings.command, folder, platform))) await saveMarkerSettings({ command: '' });
  }

  /** Everything a start checks before any process or file exists: the confirmation, that no install is running, and the plan.
   * Resolves what a run needs (plain data, so it can also travel as a Job's input); a refusal is a MarkerInstallError. */
  async function prepare(args = {}) {
    if (args.confirm !== true) throw new MarkerInstallError('need-confirm', INSTALL_MESSAGES.needConfirm);
    await quiet(INSTALL_MESSAGES.busy);
    const checked = await plan({ location: args.location, mirror: args.mirror });
    const blocking = checked.problems[0];
    if (blocking) throw new MarkerInstallError(blocking.code, blocking.message);
    const before = await readState(markerInstallStatePath()), folder = checked.folder;
    if (before.laterVersion !== undefined) throw new UnsupportedVersionError('Marker install state', before.laterVersion);
    const previous = args.removePrevious === true && before.installedFolder && !samePath(before.installedFolder, folder, platform) ? before.installedFolder : '';
    return { confirm: true, folder, mirror: checked.mirror, python: checked.python, previous, installedFolder: before.installedFolder || '' };
  }

  /** Take the one install slot of this DSH home, whichever installer object (or Job) asks. `controller` is the legacy run's own stop; a Job passes its signal. */
  function claim(prepared, { controller, signal = controller?.signal } = {}) {
    const file = markerInstallStatePath();
    if (live.has(file)) throw new MarkerInstallError('busy', INSTALL_MESSAGES.busy);
    const state = { status: 'running', stage: 'create-venv', folder: prepared.folder, mirror: prepared.mirror, python: prepared.python, startedAt: new Date().toISOString(),
      finishedAt: '', lastLine: '', log: [], error: null, command: '', ...(prepared.installedFolder ? { installedFolder: prepared.installedFolder } : {}) };
    const run = { state, controller, signal, timer: null };
    live.set(file, run);
    return run;
  }

  /** Give the slot back without having run (a Job stopped before its first stage). */
  function release(run) { const file = markerInstallStatePath(); if (live.get(file) === run) live.delete(file); }

  /** Write the state down and start the stages; resolves with the run's first state on disk, `run.promise` ends when the run does.
   * `observe(kind, work, { sideEffect })` runs one piece of work that starts a process: directly, or as an observed Call of a Job. */
  async function begin(prepared, run, observe = (_kind, work) => work(run.signal)) {
    const file = markerInstallStatePath(), { state, signal } = run, { folder, previous } = prepared, layout = venvLayout(folder, platform);
    const persist = async () => { clearTimeout(run.timer); run.timer = null; await writeState(file, state).catch(() => {}); };
    const flush = () => { run.timer ||= setTimeout(() => { run.timer = null; void writeState(file, state).catch(() => {}); }, 1000); };
    const push = line => {
      const text = hide(clip(line, MARKER_INSTALL.lineLength));
      if (!text) return;
      state.lastLine = text; state.log.push(text);
      if (state.log.length > MARKER_INSTALL.logLines) state.log.splice(0, state.log.length - MARKER_INSTALL.logLines);
      flush();
    };
    const stage = async name => { state.stage = name; push(`== ${name} ==`); await persist(); };
    await persist();
    run.promise = (async () => {
      let tail = '';
      // A stage that changes the install folder is declared with its side effect: a Job never repeats it blindly.
      const go = async (name, cli, argv, timeoutMs) => {
        push(`$ ${[cli.file, ...(cli.prefix || []), ...argv].join(' ')}`);
        const result = await observe(name, runSignal => runLocalCommand(cli, argv, { signal: runSignal, timeoutMs, onLine: line => { tail = `${tail}\n${line}`.slice(-4000); push(line); } }),
          { sideEffect: MARKER_INSTALL.mutatingStages.includes(name) });
        if (result.code !== 0) {
          const failure = explainFailure(name, tail || `${result.stderr}\n${result.stdout}`);
          throw new MarkerInstallError(failure.code, failure.message);
        }
      };
      try {
        const python = (await observe('find-python', runSignal => findPython({ candidates: seams.pythons, platform, signal: runSignal }), { sideEffect: false }))?.cli;
        if (!python) throw new MarkerInstallError('python-missing', INSTALL_MESSAGES.pythonMissing);
        await mkdir(folder, { recursive: true });
        await writeFile(layout.sentinel, `${JSON.stringify({ createdBy: 'studyhub-marker-installer', version: 1, createdAt: state.startedAt }, null, 2)}\n`, 'utf8');
        await stage('create-venv');
        await go('create-venv', python, ['-m', 'venv', layout.venv], MARKER_INSTALL.commandTimeoutMs.venv);
        await stage('install');
        const venvPython = seams.venvPython ? seams.venvPython(folder) : { file: layout.python, prefix: [], env: {} };
        const url = MARKER_INSTALL.mirrors.find(item => item.id === state.mirror)?.url;
        await go('install', { ...venvPython, env: { ...venvPython.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUNBUFFERED: '1' } },
          ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--progress-bar', 'off', '--timeout', '60', ...(url ? ['--index-url', url] : []), MARKER_INSTALL.requirement], MARKER_INSTALL.commandTimeoutMs.pip);
        await stage('verify');
        if (!(await exists(layout.marker))) throw new MarkerInstallError('verify-missing', INSTALL_MESSAGES.verifyMissing);
        const cli = seams.markerCli ? seams.markerCli(folder) : locateMarker({ command: layout.marker });
        const detected = await observe('verify', runSignal => detectMarker({ cli, signal: runSignal }), { sideEffect: false });
        push(`marker_single --help: ${detected.state}`);
        if (detected.state !== 'ready') throw new MarkerInstallError('verify-failed', INSTALL_MESSAGES.verifyFailed);
        await stage('configure');
        try { await saveMarkerSettings({ command: layout.marker }); }
        catch (error) { throw new MarkerInstallError('configure-failed', INSTALL_MESSAGES.configureFailed, { cause: error }); }
        state.command = layout.marker; state.installedFolder = folder;
        if (previous) { try { await removeCreated(previous); push(`removed the previous environment: ${previous}`); } catch (error) { push(`kept the previous environment: ${error.message}`); } }
        Object.assign(state, { status: 'complete', stage: 'done', error: null });
      } catch (error) {
        if (signal.aborted) Object.assign(state, { status: 'cancelled', error: { code: 'cancelled', message: INSTALL_MESSAGES.cancelled } });
        else {
          const known = error instanceof MarkerInstallError;
          if (!known) push(clip(error?.message || error, MARKER_INSTALL.lineLength));
          Object.assign(state, { status: 'failed', error: { code: known ? error.code : 'pip-failed', message: known ? error.message : INSTALL_MESSAGES.pipFailed } });
        }
      } finally {
        state.finishedAt = new Date().toISOString();
        await persist();
        live.delete(file);
      }
    })();
  }

  async function start(args = {}) {
    const prepared = await prepare(args), run = claim(prepared, { controller: new AbortController() });
    await begin(prepared, run);
    return view(run.state, run);
  }

  async function cancel() {
    const run = live.get(markerInstallStatePath());
    if (run) run.controller?.abort(new Error('cancelled'));
    return status();
  }

  async function uninstall(args = {}) {
    if (args.confirm !== true) throw new MarkerInstallError('need-confirm', INSTALL_MESSAGES.needConfirmUninstall);
    const file = markerInstallStatePath();
    await quiet(INSTALL_MESSAGES.uninstallBusy);
    const state = await readState(file);
    if (state.laterVersion !== undefined) throw new UnsupportedVersionError('Marker install state', state.laterVersion);
    const folders = [...new Set([state.installedFolder, state.folder].filter(Boolean))];
    let removed = 0;
    for (const folder of folders) {
      if (await readSentinel(folder, platform)) { await removeCreated(folder); removed += 1; }
    }
    if (!removed) throw new MarkerInstallError('not-ours', INSTALL_MESSAGES.notOurs);
    await writeState(file, { status: 'idle' });
    return { ...(await status()), removed };
  }

  /** Resolves when the run in progress (if any) has ended: for tests and for a caller that must wait. */
  const idle = async () => { await live.get(markerInstallStatePath())?.promise; };
  return { plan, start, status, cancel, uninstall, idle, prepare, claim, release, begin };
}
