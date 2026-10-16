import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import path from 'node:path';
import { runLocalCommand } from './local-command.js';
import { LOCAL, detectLocal, locateMineru } from './mineru-local.js';
import { InstallError, classifyFailure, createToolInstaller, exists, flavourOf, freeMegabytes, inside, readSentinel, readState, resolveInstallFolder, samePath, writable } from './tool-install.js';
import { defaultDataFolder, driveOfPath, fixedDrives } from './install-drives.js';
import { SOURCES, SOURCE_IDS, resolveSource } from './install-sources.js';
import { downloadResumable, extractUv, findWheel, wheelTagFor } from './uv-bootstrap.js';
import { MINERU_INSTALL_MESSAGES as TEXT, MINERU_STAGE_NAMES } from './mineru-install-text.js';

/* One-click local MinerU: everything in one StudyHub-owned folder (default: the non-system drive with the most free space), nothing installed
   beforehand, no admin rights. Six stages, each skipping work it finds done, so "继续安装", "修复" and a change of tier are the same start again:
     tools    the pinned uv, from the uv wheel on the chosen PyPI index (sha256-checked, resumable; lib/uv-bootstrap.js)
     python   a uv-managed CPython 3.12 in <F>\python and a venv in <F>\venv (or a system Python the learner chose in 更多)
     package  mineru>=4.0,<5 into the venv (the base package: ONNX models and llama.cpp, no torch on Windows)
     models   the tier's models into <F>\home\models (ModelScope for the mainland, Hugging Face overseas)
     enable   the managed local service with that tier
     check    the service reports it can parse with that tier
   Every child process gets its paths from mineruEnv: caches, Python, MINERU_HOME and temp files all stay inside <F>; after the install the
   service runs with MINERU_MODEL_SOURCE=local, so models are only ever downloaded inside the confirmed models stage. The engine
   (lib/tool-install.js) owns the folder, the sentinel, the state file, cancel and uninstall. */

const MB = 1_048_576;

export const MINERU_INSTALL = Object.freeze({
  stages: Object.freeze(['tools', 'python', 'package', 'models', 'enable', 'check']),
  mutatingStages: Object.freeze(['tools', 'python', 'package', 'models', 'enable']),
  uvVersion: '0.13.1',
  python: '3.12',
  pythonRange: Object.freeze([[3, 10], [3, 14]]),
  requirement: 'mineru>=4.0,<5',
  major: 4,
  tiers: Object.freeze(['basic', 'standard']),
  defaultTier: 'basic',
  /** Estimates, to be measured on a real install: what is downloaded, and the free space worth having (package env + models + peak caches). */
  downloadMb: Object.freeze({ basic: 1300, standard: 2500 }),
  neededMb: Object.freeze({ basic: 4000, standard: 6000 }),
  /** What each mutating stage leaves on disk (estimates; the models are LOCAL.modelsMb of the tier), and the room kept free on top. A folder that is
   *  already ours needs only the stages it has not finished, so a repair or a change of tier is not refused on a disk the earlier stages filled. */
  stageMb: Object.freeze({ tools: 50, python: 150, package: 2500 }),
  marginMb: 500,
  minutes: Object.freeze([10, 30]),
  /** standard asks for this much memory; below it the tier is offered with a warning. */
  recommendedRamMb: 16 * 1024,
  /** A longer install path breaks deep site-packages on Windows (MAX_PATH). */
  maxPathLength: 80,
  folderName: 'StudyHub-MinerU',
  sentinel: '.studyhub-mineru.json',
  createdBy: 'studyhub-mineru-installer',
  children: Object.freeze(['tools', 'python', 'venv', 'home', 'cache', 'tmp']),
  timeoutMs: Object.freeze({ tools: 10 * 60_000, python: 20 * 60_000, package: 60 * 60_000, models: 120 * 60_000, start: 330_000, other: 60_000, check: 20_000 }),
  checkTries: 4,
  checkPauseMs: 3000,
  logLines: 200,
  lineLength: 300,
  /** A conversion that finds the service stopped starts it first: MINERU_LOCAL_API_STARTUP_TIMEOUT_SECONDS (default 300) + 30 s. */
  startTimeoutMs: (env = process.env) => ((Number(env.MINERU_LOCAL_API_STARTUP_TIMEOUT_SECONDS) > 0 ? Number(env.MINERU_LOCAL_API_STARTUP_TIMEOUT_SECONDS) : 300) + 30) * 1000,
});
/** Models per tier (MB): the one number lives in lib/mineru-local.js LOCAL.modelsMb. */
export const modelsMbOf = tier => LOCAL.modelsMb[tier] ?? LOCAL.modelsMb.basic;

const dshHome = () => process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh');
export const mineruInstallStatePath = () => path.join(dshHome(), 'study', 'mineru-install.json');
/** Where the install goes when this computer has no drives to choose from (not Windows): the StudyHub data folder. */
export const mineruDataFolder = () => path.join(dshHome(), 'studyhub', 'mineru');

/** The files of an install under its folder. */
export function mineruLayout(folder, platform = process.platform) {
  const f = flavourOf(platform), win = platform === 'win32', exe = name => (win ? `${name}.exe` : name);
  const venv = f.join(folder, 'venv'), bin = f.join(venv, win ? 'Scripts' : 'bin'), home = f.join(folder, 'home'), cache = f.join(folder, 'cache');
  return { folder, sentinel: f.join(folder, MINERU_INSTALL.sentinel), tools: f.join(folder, 'tools'), uv: f.join(folder, 'tools', exe('uv')), uvPart: f.join(folder, 'tools', 'uv.whl.part'),
    python: f.join(folder, 'python'), pythonBin: f.join(folder, 'python', 'bin'), venv, bin, venvPython: f.join(bin, exe('python')), mineru: f.join(bin, exe('mineru')), kit: f.join(bin, exe('mineru-kit')),
    home, models: f.join(home, 'models'), config: f.join(home, 'config.yaml'), cache, cacheUv: f.join(cache, 'uv'), cacheHf: f.join(cache, 'hf'), cacheModelscope: f.join(cache, 'modelscope'),
    tmp: f.join(folder, 'tmp') };
}

const sourceOf = (id, overrides = {}) => ({ ...SOURCES[id] || SOURCES.mainland, ...(overrides[id] || {}) });

/**
 * The environment of every process an install starts, and of every later mineru call: `phase` 'uv' (uv itself), 'models' (the download) or
 * 'run' (the service, a parse, a probe: models only from disk). Every path is inside the install folder.
 */
export function mineruEnv(folder, { source = 'mainland', phase = 'run', pythonOverride = false, platform = process.platform, sources } = {}) {
  const layout = mineruLayout(folder, platform), profile = sourceOf(source, sources);
  const temp = { TEMP: layout.tmp, TMP: layout.tmp, ...(platform === 'win32' ? {} : { TMPDIR: layout.tmp }) };
  if (phase === 'uv') {
    return { UV_CACHE_DIR: layout.cacheUv, UV_PYTHON_INSTALL_DIR: layout.python, UV_PYTHON_BIN_DIR: layout.pythonBin, UV_PYTHON_INSTALL_REGISTRY: '0', UV_NO_CONFIG: '1',
      ...(pythonOverride ? {} : { UV_MANAGED_PYTHON: '1' }), UV_PYTHON_DOWNLOADS: 'automatic', UV_HTTP_TIMEOUT: '120', UV_HTTP_RETRIES: '5', UV_DEFAULT_INDEX: profile.packageIndex,
      ...(profile.pythonMirror ? { UV_PYTHON_INSTALL_MIRROR: profile.pythonMirror } : {}), ...temp };
  }
  return { MINERU_HOME: layout.home, MINERU_MODEL_SOURCE: phase === 'models' ? profile.modelSource : 'local', HF_HUB_DISABLE_XET: '1', HF_HOME: layout.cacheHf,
    MODELSCOPE_CACHE: layout.cacheModelscope, ...temp };
}

/** The config.yaml MinerU reads from $MINERU_HOME: only the models folder, so its own defaults stay for the rest. Written only when absent. */
export async function writeMineruConfig(folder, platform = process.platform) {
  const layout = mineruLayout(folder, platform);
  if (await exists(layout.config)) return false;
  await mkdir(layout.home, { recursive: true });
  await writeFile(layout.config, `model:\n  base_dir: '${layout.models.replace(/\\/g, '/').replace(/'/g, "''")}'\n`, 'utf8');
  return true;
}

/* ---------- the commands ---------- */

const withEnv = (cli, env) => ({ ...cli, prefix: cli.prefix || [], env: { ...(cli.env || {}), ...env } });
const cliOf = (ctx, which, phase) => {
  const { folder, platform, seams, state } = ctx, layout = mineruLayout(folder, platform);
  const env = mineruEnv(folder, { source: state.source?.id, phase, pythonOverride: !!state.python, platform, sources: seams.sources });
  const seam = { uv: seams.uvCli, mineru: seams.mineruCli, kit: seams.kitCli, python: seams.venvPython }[which];
  const file = { uv: layout.uv, mineru: layout.mineru, kit: layout.kit, python: layout.venvPython }[which];
  return withEnv(seam ? seam(folder) : { file, prefix: [], env: {} }, env);
};
const VERSION = /(\d+)\.(\d+)\.(\d+)/;
/** A tqdm-style "NN%|" or a plain "NN%" in a progress line, as 0..1. */
export const percentOf = text => { const all = [...String(text ?? '').matchAll(/(\d{1,3})%\|/g)]; const last = all.at(-1); return last ? Math.min(100, Number(last[1])) / 100 : null; };
const tracking = ctx => text => { const fraction = percentOf(text); if (fraction !== null) ctx.progress(fraction); };
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

/** The commands an install runs, as the learner would read them (「将要运行的命令」). */
export function installCommands({ folder, tier = MINERU_INSTALL.defaultTier, source = 'mainland', python = '', platform = process.platform, arch = process.arch, sources }) {
  const layout = mineruLayout(folder, platform), profile = sourceOf(source, sources);
  return [
    { stage: 'tools', command: `GET ${profile.uvIndex}uv-${MINERU_INSTALL.uvVersion}-py3-none-${wheelTagFor(platform, arch)}.whl  (sha256) -> "${layout.uv}"` },
    { stage: 'python', command: `"${layout.uv}" venv "${layout.venv}" --python ${python ? `"${python}"` : MINERU_INSTALL.python}` },
    { stage: 'package', command: `"${layout.uv}" pip install --python "${layout.venvPython}" "${MINERU_INSTALL.requirement}"` },
    { stage: 'models', command: `"${layout.kit}" models download --tier ${tier} --source ${profile.modelSource}` },
    { stage: 'enable', command: `"${layout.mineru}" server start && "${layout.mineru}" config set parse_server.local.managed_tier ${tier} && "${layout.mineru}" config set parse_server.local.mode managed && "${layout.mineru}" server stop && "${layout.mineru}" server start` },
    { stage: 'check', command: `"${layout.mineru}" server status` },
  ];
}

/* ---------- system Pythons (更多 › Python) ---------- */

const PY_INFO = ['-c', 'import sys,platform;print(platform.python_version());print(sys.executable)'];
const inRange = ([major, minor]) => { const [[lowMajor, lowMinor], [highMajor, highMinor]] = MINERU_INSTALL.pythonRange; return major === lowMajor && minor >= lowMinor && (major < highMajor || minor <= highMinor); };
let pythonCache = null;
/** The Pythons 3.10–3.14 on this computer: [{ version, path }]. `candidates` (a seam) are the commands to ask; remembered for a minute. Never throws. */
export async function systemPythons({ candidates, platform = process.platform } = {}) {
  if (!candidates && pythonCache && Date.now() - pythonCache.at < 60_000) return pythonCache.list;
  const asked = candidates ?? (platform === 'win32' ? [{ file: 'py', prefix: ['-3'] }, { file: 'python' }] : [{ file: 'python3' }, { file: 'python3.12' }, { file: 'python3.11' }, { file: 'python3.10' }]);
  const found = new Map();
  for (const cli of asked) {
    try {
      const result = await runLocalCommand({ prefix: [], env: {}, ...cli }, PY_INFO, { timeoutMs: 8000 });
      const [version, executable] = result.stdout.split(/\r?\n/).map(line => line.trim());
      const match = VERSION.exec(version || '');
      if (result.code === 0 && match && executable && inRange([Number(match[1]), Number(match[2])])) found.set(executable.toLowerCase(), { version, path: executable });
    } catch { /* not there */ }
  }
  const list = [...found.values()];
  if (!candidates) pythonCache = { at: Date.now(), list };
  return list;
}

/* ---------- the plan ---------- */

const problem = (code, message) => ({ code, message });
const sizeText = mb => (mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 1)} GB` : `${Math.max(0, Math.round(mb))} MB`);
const tierView = tier => ({ id: tier, modelsMb: modelsMbOf(tier), secondsPerPage: LOCAL.secondsPerPage[tier] ?? null, neededMb: MINERU_INSTALL.neededMb[tier], downloadMb: MINERU_INSTALL.downloadMb[tier] });

/** Another mineru on this computer (MINERU_BIN, PATH, ~/.local/bin) that is not the one in `folder`: { exe } or null. */
export function externalMineru({ folder, platform = process.platform, env = process.env } = {}) {
  const found = locateMineru({ env, platform });
  if (!found) return null;
  if (folder && inside(found.file, folder, platform)) return null;
  return { exe: found.file, origin: env.MINERU_BIN && found.file === env.MINERU_BIN ? 'env' : 'search' };
}

/**
 * What a one-click install would do here, from read-only checks: the drives and the default folder, free space, the folder rules, the download source,
 * the Pythons, another mineru. Never creates or installs anything. `args`: { location, tier, source, python }.
 */
/**
 * The free space an install into `folder` still needs: the whole install for a new folder; for a folder that is already ours, only what the stages it
 * has not finished leave on disk (a tier's models count as done only for the tier they were downloaded for), plus a margin, never more than a new install.
 */
export function remainingMb({ tier, existing, before, folder, platform }) {
  const full = MINERU_INSTALL.neededMb[tier];
  const same = value => typeof value === 'string' && !!value && samePath(value, folder, platform);
  if (!existing || !(same(before?.folder) || same(before?.installedFolder))) return full;
  const done = new Set(Array.isArray(before.done) ? before.done : []);
  if (before.status === 'complete' && same(before.installedFolder)) MINERU_INSTALL.stages.forEach(id => done.add(id));
  const left = Object.entries(MINERU_INSTALL.stageMb).reduce((sum, [id, mb]) => sum + (done.has(id) ? 0 : mb), 0)
    + (done.has('models') && before.tier === tier ? 0 : modelsMbOf(tier));
  return Math.min(full, left + MINERU_INSTALL.marginMb);
}

export async function planMineruInstall(args = {}, { platform = process.platform, seams = {}, live } = {}) {
  const tier = args.tier ?? MINERU_INSTALL.defaultTier;
  if (!MINERU_INSTALL.tiers.includes(tier)) throw new InstallError('bad-tier', TEXT.badTier);
  if (args.source !== undefined && args.source !== 'auto' && !SOURCE_IDS.includes(args.source)) throw new InstallError('bad-source', TEXT.badSource);
  const problems = [], warnings = [];
  const drives = seams.drives ? await seams.drives() : await fixedDrives({ platform });
  const fallback = defaultDataFolder({ neededMb: MINERU_INSTALL.neededMb[tier], drives, dataFolder: mineruDataFolder() });
  const spec = MINERU_SPEC;
  const where = await resolveInstallFolder(args.location, { spec, platform, defaultFolder: fallback.folder });
  const folder = where.folder || fallback.folder;
  const before = await readState(mineruInstallStatePath(), 'mineruInstall');
  const existing = !where.problem && !!(await readSentinel(folder, spec, platform));
  const neededMb = remainingMb({ tier, existing, before, folder, platform });
  if (where.problem === 'bad-location') problems.push(problem('bad-location', TEXT.badLocation));
  if (where.problem === 'folder-in-use') problems.push(problem('folder-in-use', TEXT.folderInUse));
  if (!where.problem && folder.length > (seams.maxPathLength ?? MINERU_INSTALL.maxPathLength)) problems.push(problem('path-too-long', TEXT.pathTooLong));
  if (!where.problem && /[^\x20-\x7e]/.test(folder)) warnings.push(problem('non-ascii', TEXT.nonAscii));
  const drive = driveOfPath(folder), listed = drives.find(item => item.root.slice(0, 2).toUpperCase() === drive);
  let freeMb = null;
  if (!where.problem) {
    const free = seams.freeMegabytes ? await seams.freeMegabytes(folder) : listed ? listed.freeMb : await freeMegabytes(folder, platform);
    freeMb = typeof free === 'number' ? free : null;
    const access = await writable(folder, platform);
    if (access === 'not-writable') problems.push(problem('not-writable', TEXT.notWritable));
    else if (access === 'bad-location' && !problems.some(item => item.code === 'bad-location')) problems.push(problem('bad-location', TEXT.badLocation));
    if (freeMb !== null && freeMb < neededMb) problems.push(problem('no-space', TEXT.noSpace(drive || flavourOf(platform).parse(folder).root || folder, sizeText(freeMb), sizeText(neededMb))));
  }
  if (live?.()?.state?.status === 'running') problems.push(problem('busy', TEXT.busy));
  // The source: what the learner chose; else what this install used before (a repair or a change of tier reuses it); else the probes.
  const asked = args.source === 'auto' ? 'auto' : args.source ?? (before.source?.id && SOURCE_IDS.includes(before.source.id) ? before.source : undefined);
  const source = typeof asked === 'object' ? { ...asked, hosts: [...SOURCES[asked.id].hosts] }
    : await resolveSource(asked, { ...(seams.probe ? { probe: seams.probe, remember: false } : {}), ...(seams.fetch ? { fetch: seams.fetch } : {}) });
  const pythons = await systemPythons({ candidates: seams.pythons, platform });
  const python = typeof args.python === 'string' && args.python && args.python !== 'bundled' ? args.python : '';
  if (python && !pythons.some(item => item.path.toLowerCase() === python.toLowerCase())) problems.push(problem('bad-python', TEXT.badPython));
  const external = seams.external !== undefined ? seams.external : externalMineru({ folder, platform });
  const ramMb = seams.ramMb ?? Math.round(totalmem() / MB);
  return {
    ok: problems.length === 0, problems, warnings, folder, adjusted: !!where.adjusted, existing,
    defaultFolder: fallback.folder, defaultReason: fallback.reason, platform,
    drives: drives.map(item => ({ ...item, recommended: !!fallback.drive && item.root === fallback.drive.root, folder: flavourOf('win32').join(item.root, 'StudyHub', 'MinerU') })),
    disk: { freeMb, neededMb, drive }, estimate: { downloadMb: MINERU_INSTALL.downloadMb[tier], minutes: [...MINERU_INSTALL.minutes] },
    tier, tiers: MINERU_INSTALL.tiers.map(tierView), ramMb, recommendedRamMb: MINERU_INSTALL.recommendedRamMb,
    source, pythons, python, external: external ? { exe: external.exe, state: 'found' } : null,
    commands: installCommands({ folder, tier, source: source.id, python, platform, arch: seams.arch, sources: seams.sources }),
  };
}

/* ---------- reading why a stage failed ---------- */

const FALLBACK = Object.freeze({ tools: 'tools-failed', python: 'python-failed', package: 'package-failed', models: 'models-failed', enable: 'service-failed', check: 'check-failed' });
export const MINERU_FAILURE_TEXT = Object.freeze({
  network: TEXT.network, checksum: TEXT.checksum, 'no-space': TEXT.noSpaceShort, 'not-writable': TEXT.notWritable, 'path-too-long': TEXT.pathTooLong,
  'vc-runtime': TEXT.vcRuntime, 'port-in-use': TEXT.portInUse, 'tools-failed': '没能准备好安装工具（uv）。', 'python-failed': TEXT.pythonFailed, 'package-failed': TEXT.packageFailed,
  'models-failed': TEXT.modelsFailed, 'service-failed': TEXT.serviceFailed, 'check-failed': TEXT.checkFailed,
});
export function explainMineruFailure(stage, text) {
  let code = classifyFailure(text);
  // A port problem only means something when the service starts; a VC++ problem only when a program loads.
  if (code === 'port-in-use' && stage !== 'enable') code = null;
  const chosen = code || FALLBACK[stage] || 'package-failed';
  return { code: chosen, message: MINERU_FAILURE_TEXT[chosen] };
}

/* ---------- the stages ---------- */

const ALREADY_RUNNING = /already running|已在运行|正在运行/i;

/** The program of an earlier StudyHub install, with that install's own environment (its service is found through its own MINERU_HOME). */
const installedCli = (folder, { platform, seams, source }) => {
  const layout = mineruLayout(folder, platform);
  return withEnv(seams.mineruCli ? seams.mineruCli(folder) : { file: layout.mineru, prefix: [], env: {} }, mineruEnv(folder, { source, platform, sources: seams.sources }));
};

/**
 * Before this install's service starts, whatever would hold its port or its files stops: the service of the folder being moved away from (it runs from
 * files that are removed after the check), and, when the learner pressed 「停止另一份 MinerU 并重试」, the service of another mineru on this computer.
 */
async function stopOthers(ctx) {
  const { prepared, platform, seams, state } = ctx, other = MINERU_INSTALL.timeoutMs.other;
  if (prepared.previous && (seams.mineruCli || await exists(mineruLayout(prepared.previous, platform).mineru))) {
    await ctx.go('enable', installedCli(prepared.previous, { platform, seams, source: state.source?.id }), ['server', 'stop'], { timeoutMs: other, allowFailure: true }).catch(() => {});
  }
  if (prepared.stopExternal) {
    const found = seams.external !== undefined ? seams.external : externalMineru({ folder: ctx.folder, platform });
    if (found?.exe) await ctx.go('enable', seams.externalCli ? seams.externalCli(found) : { file: found.exe, prefix: [], env: {} }, ['server', 'stop'], { timeoutMs: other, allowFailure: true }).catch(() => {});
  }
}

async function detectReady(ctx, tier) {
  const cli = cliOf(ctx, 'mineru', 'run'), layout = mineruLayout(ctx.folder, ctx.platform);
  return ctx.observe('check', runSignal => detectLocal({ cli, home: layout.home, signal: runSignal }), { sideEffect: false });
}

const STAGES = Object.freeze([
  { id: 'tools', mutating: true,
    async isDone(ctx) {
      const layout = mineruLayout(ctx.folder, ctx.platform);
      if (!(await exists(layout.uv))) return false;
      const result = await ctx.go('tools', cliOf(ctx, 'uv', 'uv'), ['--version'], { timeoutMs: MINERU_INSTALL.timeoutMs.other, sideEffect: false, allowFailure: true }).catch(() => null);
      return !!result && result.code === 0 && result.stdout.includes(MINERU_INSTALL.uvVersion);
    },
    async run(ctx) {
      const layout = mineruLayout(ctx.folder, ctx.platform), profile = sourceOf(ctx.state.source?.id, ctx.seams.sources);
      const fetch = ctx.seams.fetch || globalThis.fetch;
      const wheel = await ctx.observe('tools', signal => findWheel(profile.uvIndex, MINERU_INSTALL.uvVersion, wheelTagFor(ctx.platform, ctx.seams.arch), { fetch, signal }),
        { sideEffect: false, boundary: 'external-request' });
      ctx.push(`GET ${wheel.url}`);
      const got = await ctx.observe('tools', signal => downloadResumable(wheel.url, layout.uvPart, { sha256: wheel.sha256, signal, fetch,
        onProgress: ({ done, total }) => { if (total > 0) ctx.progress(done / total); } }), { sideEffect: true, boundary: 'external-request' });
      ctx.push(`${wheel.filename}: ${got.bytes} bytes${got.resumedFrom ? ` (continued from ${got.resumedFrom})` : ''}, sha256 ok`);
      await extractUv(layout.uvPart, layout.tools, ctx.platform);
      await rm(layout.uvPart, { force: true });
      const result = await ctx.go('tools', cliOf(ctx, 'uv', 'uv'), ['--version'], { timeoutMs: MINERU_INSTALL.timeoutMs.other, sideEffect: false });
      if (!result.stdout.includes(MINERU_INSTALL.uvVersion)) throw new InstallError('tools-failed', MINERU_FAILURE_TEXT['tools-failed']);
    } },
  { id: 'python', mutating: true,
    async isDone(ctx) {
      const layout = mineruLayout(ctx.folder, ctx.platform);
      if (!(await exists(layout.venvPython))) return false;
      const result = await ctx.go('python', cliOf(ctx, 'python', 'run'), ['--version'], { timeoutMs: MINERU_INSTALL.timeoutMs.other, sideEffect: false, allowFailure: true }).catch(() => null);
      const match = result?.code === 0 ? VERSION.exec(`${result.stdout}${result.stderr}`) : null;
      if (!match) return false;
      if (!ctx.state.python) return `${match[1]}.${match[2]}` === MINERU_INSTALL.python;
      const wanted = (ctx.prepared.pythonVersion || '').split('.').slice(0, 2).join('.');
      return !wanted || `${match[1]}.${match[2]}` === wanted;
    },
    async run(ctx) {
      const layout = mineruLayout(ctx.folder, ctx.platform);
      const clear = (await exists(layout.venv)) ? ['--clear'] : [];
      await ctx.go('python', cliOf(ctx, 'uv', 'uv'), ['venv', layout.venv, '--python', ctx.state.python || MINERU_INSTALL.python, ...clear], { timeoutMs: MINERU_INSTALL.timeoutMs.python, onText: tracking(ctx) });
    } },
  { id: 'package', mutating: true,
    async run(ctx) {
      const layout = mineruLayout(ctx.folder, ctx.platform);
      await ctx.go('package', cliOf(ctx, 'uv', 'uv'), ['pip', 'install', '--python', layout.venvPython, MINERU_INSTALL.requirement], { timeoutMs: MINERU_INSTALL.timeoutMs.package, onText: tracking(ctx) });
      // Before the first mineru call: the models folder inside the install, so nothing lands in ~/.mineru.
      if (await writeMineruConfig(ctx.folder, ctx.platform)) ctx.push(`wrote ${layout.config}`);
      const said = await ctx.go('package', cliOf(ctx, 'mineru', 'run'), ['--version'], { timeoutMs: MINERU_INSTALL.timeoutMs.other, sideEffect: false });
      const match = VERSION.exec(`${said.stdout}${said.stderr}`);
      if (!match || Number(match[1]) !== MINERU_INSTALL.major) throw new InstallError('package-failed', TEXT.wrongVersion(match?.[0]));
      ctx.state.mineruVersion = match[0];
    } },
  { id: 'models', mutating: true,
    async isDone(ctx) {
      if (!(await exists(mineruLayout(ctx.folder, ctx.platform).kit))) return false;
      await writeMineruConfig(ctx.folder, ctx.platform);
      const result = await ctx.go('models', cliOf(ctx, 'kit', 'run'), ['models', 'verify', '--tier', ctx.state.tier], { timeoutMs: MINERU_INSTALL.timeoutMs.other, sideEffect: false, allowFailure: true }).catch(() => null);
      return result?.code === 0;
    },
    async run(ctx) {
      const layout = mineruLayout(ctx.folder, ctx.platform), tier = ctx.state.tier, profile = sourceOf(ctx.state.source?.id, ctx.seams.sources);
      // Moving the install: the models of the previous folder are copied when they verify there, not downloaded again.
      const previous = ctx.prepared.previous ? mineruLayout(ctx.prepared.previous, ctx.platform) : null;
      if (previous && await exists(previous.models)) {
        const kit = withEnv(ctx.seams.kitCli ? ctx.seams.kitCli(ctx.prepared.previous) : { file: previous.kit, prefix: [], env: {} },
          mineruEnv(ctx.prepared.previous, { source: profile.id, phase: 'run', platform: ctx.platform, sources: ctx.seams.sources }));
        const verified = await ctx.go('models', kit, ['models', 'verify', '--tier', tier], { timeoutMs: MINERU_INSTALL.timeoutMs.other, sideEffect: false, allowFailure: true }).catch(() => null);
        if (verified?.code === 0) {
          ctx.push(`copying the models of ${ctx.prepared.previous}`);
          await cp(previous.models, layout.models, { recursive: true, force: false, errorOnExist: false });
        }
      }
      const verify = () => ctx.go('models', cliOf(ctx, 'kit', 'run'), ['models', 'verify', '--tier', tier], { timeoutMs: MINERU_INSTALL.timeoutMs.other, sideEffect: false, allowFailure: true });
      if ((await verify()).code === 0) return;
      await ctx.go('models', cliOf(ctx, 'kit', 'models'), ['models', 'download', '--tier', tier, '--source', profile.modelSource], { timeoutMs: MINERU_INSTALL.timeoutMs.models, onText: tracking(ctx) });
      if ((await verify()).code !== 0) throw new InstallError('models-failed', MINERU_FAILURE_TEXT['models-failed']);
    } },
  { id: 'enable', mutating: true,
    async run(ctx) {
      const cli = cliOf(ctx, 'mineru', 'run'), start = MINERU_INSTALL.timeoutMs.start, other = MINERU_INSTALL.timeoutMs.other;
      await stopOthers(ctx);
      const first = await ctx.go('enable', cli, ['server', 'start'], { timeoutMs: start, allowFailure: true });
      if (first.code !== 0 && !ALREADY_RUNNING.test(`${first.stdout}\n${first.stderr}`)) {
        const failure = explainMineruFailure('enable', `${first.stderr}\n${first.stdout}`);
        throw new InstallError(failure.code, failure.message);
      }
      await ctx.go('enable', cli, ['config', 'set', 'parse_server.local.managed_tier', ctx.state.tier], { timeoutMs: other });
      await ctx.go('enable', cli, ['config', 'set', 'parse_server.local.mode', 'managed'], { timeoutMs: other });
      // stop + start, not the undocumented `server restart`.
      await ctx.go('enable', cli, ['server', 'stop'], { timeoutMs: other, allowFailure: true });
      await ctx.go('enable', cli, ['server', 'start'], { timeoutMs: start });
    } },
  { id: 'check', mutating: false,
    async run(ctx) {
      let found = null;
      for (let attempt = 0; attempt < MINERU_INSTALL.checkTries; attempt++) {
        found = await detectReady(ctx, ctx.state.tier).catch(error => { if (ctx.signal.aborted) throw error; return null; });
        ctx.push(`mineru server status: ${found?.state || 'unknown'}${found?.tier ? ` (${found.tier})` : ''}`);
        if (found?.state === 'ready' && found.tier === ctx.state.tier) break;
        found = null;
        if (attempt < MINERU_INSTALL.checkTries - 1) await pause(ctx.seams.checkPauseMs ?? MINERU_INSTALL.checkPauseMs, ctx.signal);
      }
      if (!found) throw new InstallError('check-failed', MINERU_FAILURE_TEXT['check-failed']);
      if (found.version) ctx.state.mineruVersion = found.version;
      // Best effort: the uv cache and the temp files are not needed any more (the models' caches stay: they are the downloaded models).
      const layout = mineruLayout(ctx.folder, ctx.platform);
      await rm(layout.cacheUv, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      await rm(layout.tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      await mkdir(layout.tmp, { recursive: true }).catch(() => {});
    } },
]);

const stageIndex = id => MINERU_INSTALL.stages.indexOf(id);

/** The install as the engine runs it. `seams` (tests, previews): platform, arch, fetch, sources, probe, drives(), freeMegabytes(folder), ramMb, pythons, external,
 *  uvCli(folder), venvPython(folder), mineruCli(folder), kitCli(folder), checkPauseMs, conversionRunning(), row(run). */
export const MINERU_SPEC = Object.freeze({
  id: 'mineru', versionKey: 'mineruInstall', label: 'MinerU install state', stateFile: mineruInstallStatePath,
  sentinel: MINERU_INSTALL.sentinel, createdBy: MINERU_INSTALL.createdBy, folderName: MINERU_INSTALL.folderName, children: MINERU_INSTALL.children, trackParents: true,
  logLines: MINERU_INSTALL.logLines, lineLength: MINERU_INSTALL.lineLength, reportRemoved: true,
  /** A first install that stopped and is started again somewhere else (换位置) leaves its partial folder behind: it is removed once the new one passes. */
  cleanAbandoned: true,
  messages: TEXT,
  explain: explainMineruFailure,
  unknownFailure: stage => { const code = FALLBACK[stage] || 'package-failed'; return { code, message: MINERU_FAILURE_TEXT[code] }; },
  plan: (args, { platform, seams, live }) => planMineruInstall(args, { platform, seams, live }),
  prepare: (checked, args, before) => {
    const again = ['network', 'checksum'].includes(before.error?.code) && before.source?.id === checked.source.id && before.status === 'failed';
    const chosen = checked.python ? checked.pythons.find(item => item.path.toLowerCase() === checked.python.toLowerCase()) : null;
    return { tier: checked.tier, source: { id: checked.source.id, chosenBy: checked.source.chosenBy, reason: checked.source.reason }, python: checked.python || '',
      ...(chosen ? { pythonVersion: chosen.version } : {}), streak: again ? (before.streak || 0) + 1 : 0, ...(args.stopExternal === true ? { stopExternal: true } : {}),
      // The tier that works now is kept apart from the one this run asks for: a change of tier that fails leaves the old one installed (and running).
      installedTier: before.installedTier || (before.status === 'complete' && before.installedFolder ? before.tier || '' : '') };
  },
  stateOf: prepared => ({ tier: prepared.tier, installedTier: prepared.installedTier || '', source: prepared.source, python: prepared.python || '', streak: prepared.streak || 0, done: [] }),
  /** Every step passed: the tier this run installed is the one that works now. */
  after(ctx) { ctx.state.installedTier = ctx.state.tier; },
  installedProgram: (folder, { platform }) => exists(mineruLayout(folder, platform).mineru),
  view: (state, { status, error, installed }) => {
    const done = Array.isArray(state.done) ? state.done.filter(id => MINERU_INSTALL.stages.includes(id)) : [];
    const at = stageIndex(state.stage);
    return { status, stage: state.stage || '', stageName: MINERU_STAGE_NAMES[state.stage] || '', stages: [...MINERU_INSTALL.stages], done,
      step: status === 'complete' ? MINERU_INSTALL.stages.length : at >= 0 ? at + 1 : 0, of: MINERU_INSTALL.stages.length,
      folder: state.folder || '', installedFolder: installed ? state.installedFolder : '', installed, tier: state.tier || '',
      installedTier: installed ? state.installedTier || (status === 'complete' ? state.tier || '' : '') : '', source: state.source || null, python: state.python || '',
      mineruVersion: state.mineruVersion || '', startedAt: state.startedAt || '', finishedAt: state.finishedAt || '', lastLine: state.lastLine || '',
      log: Array.isArray(state.log) ? state.log : [], error, ...(status === 'failed' && ['network', 'checksum'].includes(error?.code) ? { attempts: (state.streak || 0) + 1 } : {}),
      ...(Number.isFinite(state.stageFraction) && status === 'running' ? { stageFraction: state.stageFraction } : {}) };
  },
  /** Right after the sentinel: every stage's processes write their temp files inside the install. */
  async ready(ctx) { await mkdir(mineruLayout(ctx.folder, ctx.platform).tmp, { recursive: true }).catch(() => {}); },
  stages: STAGES,
  /** Uninstall: never while a conversion uses the service; the service of this install is stopped first, with its own environment. */
  async beforeUninstall({ state, platform, seams }) {
    if (seams.conversionRunning?.()) throw new InstallError('conversion-running', TEXT.conversionRunning);
    const folder = state.installedFolder || state.folder;
    if (!folder) return;
    if (!(await exists(mineruLayout(folder, platform).mineru))) return;
    await runLocalCommand(installedCli(folder, { platform, seams, source: state.source?.id }), ['server', 'stop'], { timeoutMs: MINERU_INSTALL.timeoutMs.other }).catch(() => {});
  },
  error: (code, message, options) => new InstallError(code, message, options),
});

/** The installer for this DSH home. */
export const createMineruInstaller = (seams = {}) => createToolInstaller(MINERU_SPEC, seams);

/**
 * The mineru StudyHub runs, in this order: StudyHub's own install (its sentinel and its program are there) with the install's environment; MINERU_BIN;
 * PATH and ~/.local/bin. Resolves { cli, origin: 'installed' | 'env' | 'search', folder?, home?, tier?, install? } or { cli: null, origin: null }.
 * `seams.mineruCli(folder)` stands in for the installed program (tests, previews).
 */
export async function effectiveMineru({ seams = {}, platform = process.platform, env = process.env } = {}) {
  const state = await readState(mineruInstallStatePath(), 'mineruInstall');
  const folder = typeof state?.installedFolder === 'string' ? state.installedFolder : '';
  if (folder && await readSentinel(folder, MINERU_SPEC, platform)) {
    const layout = mineruLayout(folder, platform);
    if (await exists(layout.mineru)) {
      const cli = withEnv(seams.mineruCli ? seams.mineruCli(folder) : { file: layout.mineru, prefix: [], env: {} },
        mineruEnv(folder, { source: state.source?.id, phase: 'run', platform, sources: seams.sources }));
      return { cli, origin: 'installed', folder, home: layout.home, tier: state.installedTier || state.tier || '' };
    }
  }
  const found = locateMineru({ env, platform });
  if (!found) return { cli: null, origin: null };
  return { cli: found, origin: env.MINERU_BIN && found.file === env.MINERU_BIN ? 'env' : 'search' };
}
