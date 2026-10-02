import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath as fsRealpath, rm } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';

/* The local `mineru` command line (free, nothing leaves the computer). StudyHub finds it, reads its state with read-only calls,
   and, only when the learner clicks, starts its service or sets it up; a conversion runs it on consecutive page windows
   (`--pages a-b` is native, so no PDF splitting is needed) and reads the Markdown it writes into the same page model the cloud
   route produces (lib/mineru-merge.js). What is known about the CLI (4.0.x) comes from a real install: Markdown output only,
   pages delimited by `<!-- page N of TOTAL -->` (N is the original page number), images only as placeholders, a local service
   that must be running, and a DEFAULT of just the first 10 pages: so every parse here states its pages explicitly. */

export const LOCAL = Object.freeze({
  /** The most pages one `mineru parse` call may take: the old fixed window, now the ceiling of the adaptive plan (and the size of a "fixed" plan). */
  windowPages: 50,
  /* The adaptive plan (the default), all its numbers in one place. Progress, resume and cancel work in windows of pages. The FIRST window is small, so the
     first progress, the first measured pace and the first estimate come quickly; the next ones ramp up (10, 20, 20); after that each window is sized from the
     measured seconds per page so that it lasts about `targetWindowSeconds`, within [minWindowPages, maxWindowPages]. A slow machine or a scanned book keeps
     small windows (the bar still moves about once a minute), a fast one grows to 50. Every window costs a fixed overhead (starting the command, reading the
     result), which is why a window is never smaller than `minWindowPages`. */
  firstWindowPages: 10, rampPages: Object.freeze([10, 20, 20]), targetWindowSeconds: 75, minWindowPages: 5, maxWindowPages: 50,
  /** The pace is read from the latest windows; a first window more than this many times slower per page than the rest (it also loads the model) is left out. */
  paceWindows: 3, slowFirstFactor: 1.5,
  /** How often a running window asks the service (read-only) whether it is working on it (0 turns the question off), when it asks first, how long a question may take,
   *  and when "no response" may be said: only when the service reports nothing parsing or queued for `idleProbes` answers in a row AND nothing was heard for `silentMs`. */
  livenessMs: 20_000, livenessFirstMs: 5_000, probeTimeoutMs: 10_000, silentMs: 120_000, idleProbes: 3,
  /** The pace is called unstable when the windows it comes from differ more than this factor; one window alone is only a first reading (the model load is in it). */
  unstableFactor: 1.5, etaSingleBand: Object.freeze([0.6, 1.1]),
  /** The tiers worth setting up ('flash' is the base package's text-only preview). */
  tiers: Object.freeze(['basic', 'standard', 'advanced']),
  /** The wait StudyHub asks the CLI for, per window: generous but bounded; the first window of a run also gets the time the model needs to load, and a slow machine
   *  (a measured pace) gets `waitPaceFactor` times its own seconds per page, so a slow scan is never cut off by a wait written for a fast one. */
  waitFloorSec: 120, waitPerPageSec: 8, waitCeilSec: 1800, loadAllowanceSec: 180, waitPaceFactor: 3,
  /** Measured once, on one CPU-only Windows laptop: seconds per page. An estimate for the learner, never a promise. */
  secondsPerPage: Object.freeze({ basic: 1.6, standard: 2.5 }),
  /** Models the learner is asked to confirm before they are downloaded (about, in MB). */
  modelsMb: Object.freeze({ basic: 800, standard: 1200 }),
  commandTimeoutMs: 20_000,
});

export class LocalMineruError extends Error {
  constructor(code, message, { retryable = false } = {}) { super(message); this.name = 'LocalMineruError'; this.code = code; this.retryable = retryable; }
}

export const LOCAL_MESSAGES = Object.freeze({
  notInstalled: '这台电脑上没有找到 mineru。可以改用云端解析，或先安装 mineru。',
  serverStopped: '本地服务没有在运行，或解析到一半停了。请点「重新启动本地服务」后接着做（已完成的段落会保留）。',
  timeout: '这一段本地解析用了太久，已先停下。可以点「接着做」重试这一段。',
  emptyOutput: '本地解析没有写出结果文件，请重试这一段。',
  headerFooter: '本地解析可能把页眉、页脚和页码也留在了正文里；它们没有被删除。',
  setupNeedsModels: '本地解析需要先下载模型并启用。',
  noDownloader: '没有找到模型下载工具（mineru-models-download）。请在终端运行它下载模型，或改用云端解析。',
  setupBusy: '本地设置正在进行，请等它完成。',
  badTier: '本地解析的档位只能是 basic 或 standard。',
  unreadable: '读不出本地 mineru 的设置，没法确认它能不能用。请先点「重新检测」。',
});

const LINE_BREAK = /\r?\n|\r/;
const clip = (value, length = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

/* ---------- finding it ---------- */

/**
 * Where `mineru` is: MINERU_BIN, then PATH, then ~/.local/bin (where `uv tool install` puts it).
 * Resolves { file, prefix: [], env: {} } or null. `exists`, `homedir` and `platform` can be given for tests.
 */
export function locateMineru({ env = process.env, platform = process.platform, homedir = osHomedir(), exists = existsSync } = {}) {
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'mineru.exe' : 'mineru';
  const candidates = [];
  if (env.MINERU_BIN) candidates.push(env.MINERU_BIN);
  for (const folder of String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) candidates.push(flavour.join(folder, name));
  candidates.push(flavour.join(homedir, '.local', 'bin', name));
  const file = candidates.find(candidate => { try { return exists(candidate); } catch { return false; } });
  return file ? { file, prefix: [], env: {} } : null;
}

/* ---------- running it ---------- */

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  } catch { try { child.kill(); } catch { /* already gone */ } }
}

/**
 * Run the command line: no shell, UTF-8 forced, the whole process tree killed on abort or timeout.
 * Resolves { code, stdout, stderr }; rejects with the abort reason, or a LocalMineruError (not-installed, timeout).
 */
export function runCli(cli, args, { signal, timeoutMs = LOCAL.commandTimeoutMs, cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (!cli) return reject(new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled));
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    let child;
    try {
      child = spawn(cli.file, [...(cli.prefix || []), ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        env: { ...process.env, ...(cli.env || {}), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    } catch (error) { return reject(error?.code === 'ENOENT' ? new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled) : error); }
    let stdout = '', stderr = '', settled = false, timer;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); settle(value);
    };
    const onAbort = () => { killTree(child); finish(reject, signal.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => { killTree(child); finish(reject, new LocalMineruError('timeout', LOCAL_MESSAGES.timeout, { retryable: true })); }, timeoutMs);
    const take = (current, part) => (current.length < 1_000_000 ? current + part : current);
    const lines = part => { if (onLine) for (const line of part.split(LINE_BREAK)) if (line.trim()) onLine(line.trim()); };
    child.stdout.on('data', part => { const text = part.toString('utf8'); stdout = take(stdout, text); lines(text); });
    child.stderr.on('data', part => { const text = part.toString('utf8'); stderr = take(stderr, text); lines(text); });
    child.on('error', error => finish(reject, error?.code === 'ENOENT' ? new LocalMineruError('not-installed', LOCAL_MESSAGES.notInstalled) : error));
    child.on('close', code => finish(resolve, { code, stdout, stderr }));
  });
}

/* ---------- one honest state ---------- */

const firstLine = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
const unquote = value => value.replace(/^['"]|['"]$/g, '');
/** The value of a `mineru config get` answer. The CLI prints the whole line, "parse_server.local.mode = managed  [override]"
 *  (the bracket says where the value comes from), not the bare value; a bare value is read too. */
const configValue = text => {
  const line = firstLine(text), match = /=\s*(\S+)/.exec(line);
  return unquote(match ? match[1] : line).toLowerCase();
};

/** The folders the real tool downloads a tier's models into (under <home>/models): basic is MinerU-4_models_onnx (or _torch), standard is
 *  MinerU2.5-Pro-…-GGUF. Neither is named after the tier, so a folder is also accepted when its name contains the tier word. */
const MODEL_FOLDERS = Object.freeze({ basic: /models_(?:onnx|torch)/i, standard: /gguf/i });
async function modelsFolder(home, tier) {
  const dir = path.join(home, 'models');
  try {
    // readdir follows a junction or a symbolic link: models are often moved to another drive.
    const entries = await readdir(dir);
    return { dir, present: entries.length > 0, downloaded: !!tier && entries.some(entry => MODEL_FOLDERS[tier]?.test(entry) || entry.toLowerCase().includes(tier)) };
  } catch { return { dir, present: false, downloaded: false }; }
}

/**
 * The state of the local mineru, from read-only calls only (--version, server status, config get):
 * 'not-installed' | 'server-stopped' | 'needs-models' (running, but not set up for a usable tier) | 'ready' | 'unknown'.
 * Resolves { state, next: null | 'install' | 'start-server' | 'download-models' | 'enable' | 'recheck', version, exe, tier, mode, running,
 * modelsDownloaded, modelsMb }. Never starts, installs or changes anything.
 *
 * The CLI keeps its settings in its own service, so `config get` only works while the service runs (stopped, it exits non-zero
 * with "本地 mineru 服务未运行…"). Hence the service is asked about FIRST: a stopped one is 'server-stopped' whatever was set up
 * before (tier, mode and models are then unknown: null/''), and only once it runs are the settings read. A settings read that
 * fails for any other reason is 'unknown': never taken for "not set up".
 */
export async function detectLocal({ cli, home, env = process.env, signal } = {}) {
  if (!cli) return { state: 'not-installed', next: 'install' };
  const run = args => runCli(cli, args, { signal }).catch(error => { if (error instanceof LocalMineruError && error.code === 'timeout') return { code: 124, stdout: '', stderr: '' }; throw error; });
  const said = result => `${result.stdout}\n${result.stderr}`;
  const version = (/(\d+\.\d+\.\d+(?:[.\w-]*)?)/.exec(firstLine((await run(['--version'])).stdout))?.[1]) ?? '';
  const where = home || env.MINERU_HOME || path.join(osHomedir(), '.mineru');
  const unknown = { version, exe: cli.file, tier: '', mode: '', modelsDownloaded: null, modelsMb: LOCAL.modelsMb.basic };
  const stopped = { ...unknown, state: 'server-stopped', next: 'start-server', running: false };
  const status = await run(['server', 'status']);
  if (status.code === 124) return { ...unknown, state: 'unknown', next: 'recheck', running: false };
  const running = status.code === 0 && /PID\D{0,40}\d{2,}/i.test(status.stdout) && !NOT_RUNNING.test(said(status));
  if (!running) return stopped;
  const mode = await run(['config', 'get', 'parse_server.local.mode']), tier = await run(['config', 'get', 'parse_server.local.managed_tier']);
  if ([mode, tier].some(result => NOT_RUNNING.test(said(result)))) return stopped; // it stopped between the two calls
  if (mode.code !== 0 || tier.code !== 0) return { ...unknown, state: 'unknown', next: 'recheck', running: true };
  const [modeName, tierName] = [configValue(mode.stdout), configValue(tier.stdout)];
  const folder = await modelsFolder(where, tierName);
  const base = { version, exe: cli.file, tier: tierName, mode: modeName, modelsDownloaded: folder.downloaded, modelsMb: LOCAL.modelsMb[LOCAL.tiers.includes(tierName) && LOCAL.modelsMb[tierName] ? tierName : 'basic'] };
  if (modeName !== 'managed' || !LOCAL.tiers.includes(tierName)) return { ...base, state: 'needs-models', next: folder.downloaded && LOCAL.tiers.includes(tierName) ? 'enable' : 'download-models', running: true };
  return { ...base, state: 'ready', next: null, running: true };
}

/* ---------- what is doing the work ---------- */

const DEVICE_LINE = /(?:^|[\s┃│|])(?:device|gpu|accelerator|compute device)\s*(?:[┃│|:=]\s*|\s{2,})([A-Za-z0-9_.+-]{2,30}(?: [A-Za-z0-9_.+-]{1,20})?)/im;
const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/**
 * What would do (or is doing) a local conversion, from read-only reads: the mineru version and tier (`status`, from detectLocal), the model folder of that
 * tier under <home>/models (the real tool names it, e.g. MinerU-4_models_onnx or MinerU2.5-Pro-…-GGUF), where the models are (and where a link points: they
 * are often moved to another drive), and a device ONLY when `server status` or `config show` says one. Never starts or changes anything; whatever cannot be
 * read is left out, not invented. Resolves { kind: 'local', mineruVersion?, tier?, model?, modelsPath?, modelsRealPath?, device? }.
 */
export async function readLocalEnvironment({ cli, home, status = {}, signal, realpath = fsRealpath, env = process.env } = {}) {
  const environment = { kind: 'local' };
  if (status.version) environment.mineruVersion = status.version;
  if (status.tier) environment.tier = status.tier;
  if (!cli || status.state === 'not-installed') return environment;
  const where = home || env.MINERU_HOME || path.join(osHomedir(), '.mineru'), dir = path.join(where, 'models');
  try {
    const entries = await readdir(dir);
    const tier = status.tier, model = tier && (entries.find(entry => MODEL_FOLDERS[tier]?.test(entry)) ?? entries.find(entry => entry.toLowerCase().includes(tier)));
    if (model) environment.model = model;
    if (entries.length) {
      environment.modelsPath = dir;
      const real = await realpath(dir).catch(() => '');
      if (real && !samePath(real, dir)) environment.modelsRealPath = real;
    }
  } catch { /* no models folder yet */ }
  for (const args of [['server', 'status'], ['config', 'show']]) {
    if (environment.device) break;
    const said = await runCli(cli, args, { signal, timeoutMs: 10_000 }).then(result => `${result.stdout}\n${result.stderr}`, () => '');
    const device = DEVICE_LINE.exec(said)?.[1]?.trim();
    if (device) environment.device = device;
  }
  return environment;
}

/** Start (or restart) the local service: an explicit step the learner asked for. Resolves the state read again afterwards. */
export async function startServer({ cli, home, restart = false, signal } = {}) {
  const result = await runCli(cli, ['server', restart ? 'restart' : 'start'], { signal, timeoutMs: 90_000 });
  if (result.code !== 0) throw new LocalMineruError('server-start-failed', `本地服务没能启动：${clip(result.stderr || result.stdout) || '没有返回原因'}`, { retryable: true });
  return detectLocal({ cli, home, signal });
}

/* ---------- windows of pages ---------- */

/** Consecutive windows of at most `size` pages: [{ index, startPage, endPage }] (1-based, inclusive). */
export function windowPlan(totalPages, size = LOCAL.windowPages) {
  const plan = [];
  for (let startPage = 1; startPage <= totalPages; startPage += size) plan.push({ index: plan.length, startPage, endPage: Math.min(totalPages, startPage + size - 1) });
  return plan;
}

/**
 * The pace of this machine from the windows measured so far (`windows`: [{ pages, ms }] in order; one without a measurement says nothing): the seconds
 * per page over the latest LOCAL.paceWindows windows. The first window also loads the model, so when it was much slower per page than the rest it is left
 * out. Resolves { secondsPerPage, windows (how many were measured), basis: 'measured', skippedFirst } or null.
 */
const perPage = list => list.reduce((sum, window) => sum + window.ms, 0) / list.reduce((sum, window) => sum + window.pages, 0) / 1000;
/** The measured windows the pace is read from: the latest few, without a first window that was much slower per page (it also loaded the model). */
function paceBasis(windows, { paceWindows, slowFirstFactor }) {
  const measured = windows.filter(window => window && window.pages > 0 && window.ms > 0);
  let used = measured, skippedFirst = false;
  if (measured.length >= 2) {
    const [first, ...rest] = measured;
    if (first.ms / first.pages / 1000 > slowFirstFactor * perPage(rest)) { used = rest; skippedFirst = true; }
  }
  return { measured, used: used.slice(-paceWindows), skippedFirst };
}
export function localPace(windows = [], { paceWindows = LOCAL.paceWindows, slowFirstFactor = LOCAL.slowFirstFactor } = {}) {
  const { measured, used, skippedFirst } = paceBasis(windows, { paceWindows, slowFirstFactor });
  if (!measured.length) return null;
  return { secondsPerPage: Math.round(perPage(used) * 100) / 100, windows: measured.length, basis: 'measured', skippedFirst };
}

/**
 * The next window of the adaptive plan, decided when the previous one has finished. `total` pages in the PDF, `covered` the [start, end] spans already
 * converted (never planned again), `from` the first page to consider, `windows` the finished windows [{ pages, ms }] (0 ms: restored, not measured),
 * `tier` for the published estimate when nothing was measured, `limits` to override the LOCAL numbers (firstPages, rampPages, targetSeconds, minPages, maxPages).
 * Resolves { startPage, endPage, pages, reason: 'first' | 'ramp' | 'pace' | 'estimate' } or null when every page is covered. A window never runs past the end
 * or into converted pages, and the tail is never fewer than the minimum: the last window takes the remainder.
 */
export function nextWindow({ total, covered = [], from = 1, windows = [], tier, limits = {} } = {}) {
  const first = limits.firstPages ?? LOCAL.firstWindowPages, ramp = limits.rampPages ?? LOCAL.rampPages, target = limits.targetSeconds ?? LOCAL.targetWindowSeconds;
  const min = limits.minPages ?? LOCAL.minWindowPages, max = limits.maxPages ?? LOCAL.maxWindowPages;
  const spans = [...covered].sort((a, b) => a[0] - b[0]);
  let startPage = Math.max(1, from);
  for (const [a, b] of spans) if (a <= startPage && startPage <= b) startPage = b + 1;
  if (startPage > total) return null;
  const room = Math.min(total, (spans.find(([a]) => a > startPage)?.[0] ?? total + 1) - 1) - startPage + 1;
  const done = windows.length, pace = localPace(windows);
  const estimate = LOCAL.secondsPerPage[tier];
  const bySpeed = seconds => Math.min(max, Math.max(min, Math.round(target / seconds)));
  let size, reason;
  if (!done) { size = Math.min(first, max); reason = 'first'; }
  else if (done < ramp.length) { size = pace ? Math.min(ramp[done], bySpeed(pace.secondsPerPage)) : ramp[done]; reason = 'ramp'; }
  else if (pace) { size = bySpeed(pace.secondsPerPage); reason = 'pace'; }
  else if (estimate) { size = bySpeed(estimate); reason = 'estimate'; }
  else { size = Math.min(max, LOCAL.windowPages); reason = 'estimate'; }
  size = Math.max(Math.min(size, max), Math.min(min, room));
  if (size >= room) size = room;
  else if (room - size < min) size = room <= max ? room : room - min;
  return { startPage, endPage: startPage + size - 1, pages: size, reason };
}

/** A window that failed, as two halves that tile it exactly; null for a single page. */
export function halveWindow({ startPage, endPage }) {
  const pages = endPage - startPage + 1;
  if (pages < 2) return null;
  const middle = startPage + Math.floor(pages / 2) - 1;
  return [{ startPage, endPage: middle }, { startPage: middle + 1, endPage }];
}

/**
 * What is left, in seconds: from the measured pace once there is one, from the tier's published figure before ("an estimate, not a promise"), nothing for a
 * tier without one. Resolves { basis: 'measured' | 'estimate' | 'none', secondsPerPage, etaSeconds, windowsMeasured }.
 */
export function localEta({ remainingPages, windows = [], tier } = {}) {
  const pace = localPace(windows);
  if (pace) return { basis: 'measured', secondsPerPage: pace.secondsPerPage, etaSeconds: Math.round(remainingPages * pace.secondsPerPage), windowsMeasured: pace.windows };
  const estimate = LOCAL.secondsPerPage[tier];
  if (estimate) return { basis: 'estimate', secondsPerPage: estimate, etaSeconds: Math.round(remainingPages * estimate), windowsMeasured: 0 };
  return { basis: 'none', secondsPerPage: null, etaSeconds: null, windowsMeasured: 0 };
}

/**
 * What is left as a range, because a pace measured on one window (it also loaded the model) or on windows that differ much is only about right. Resolves
 * { basis, etaSeconds, lowSeconds, highSeconds, stable, windowsMeasured }: `stable` when at least two windows agree within LOCAL.unstableFactor, so low = high;
 * otherwise the range runs from the fastest to the slowest window's pace (one window: LOCAL.etaSingleBand of its pace). An estimate that was never measured is
 * never stable. The card hides all of it until a window has finished.
 */
export function localEtaRange({ remainingPages, windows = [], tier, limits = {} } = {}) {
  const eta = localEta({ remainingPages, windows, tier });
  if (eta.etaSeconds === null) return { ...eta, lowSeconds: null, highSeconds: null, stable: false };
  if (eta.basis !== 'measured') return { ...eta, lowSeconds: eta.etaSeconds, highSeconds: eta.etaSeconds, stable: false };
  const { used } = paceBasis(windows, { paceWindows: limits.paceWindows ?? LOCAL.paceWindows, slowFirstFactor: limits.slowFirstFactor ?? LOCAL.slowFirstFactor });
  const speeds = used.map(window => window.ms / window.pages / 1000);
  const [lowest, highest] = [Math.min(...speeds), Math.max(...speeds)];
  if (used.length >= 2 && highest / lowest <= (limits.unstableFactor ?? LOCAL.unstableFactor)) return { ...eta, lowSeconds: eta.etaSeconds, highSeconds: eta.etaSeconds, stable: true };
  if (used.length < 2) return { ...eta, lowSeconds: Math.round(eta.etaSeconds * LOCAL.etaSingleBand[0]), highSeconds: Math.round(eta.etaSeconds * LOCAL.etaSingleBand[1]), stable: false };
  return { ...eta, lowSeconds: Math.round(remainingPages * lowest), highSeconds: Math.round(remainingPages * highest), stable: false };
}

/**
 * How long StudyHub asks the CLI to wait for one window (`--wait`): the floor, or per page the larger of the fixed figure and `waitPaceFactor` times the measured pace of
 * this machine, plus the time the model needs to load for the first window of a run; never above the ceiling. So a slow scan is not cut off by a wait written for a fast one.
 */
export function waitSeconds({ pages, pace = null, first = false } = {}) {
  const per = Math.max(LOCAL.waitPerPageSec, pace?.secondsPerPage ? pace.secondsPerPage * LOCAL.waitPaceFactor : 0);
  return Math.min(LOCAL.waitCeilSec, Math.max(LOCAL.waitFloorSec, Math.round(pages * per)) + (first ? LOCAL.loadAllowanceSec : 0));
}

/* ---------- is the window alive? (read-only questions to the service) ---------- */

/* `mineru parse --wait` prints nothing until it ends, so while a window runs StudyHub asks the SERVICE, never the process: `server status --json` (the workers and the
   health of the parse server) and `list parses --status pending|parsing --json`, matched to the window by tier and page range. Read-only, one question at a time, at
   LOCAL.livenessMs, only while a window runs; any failure of a question is "unknown", never "stuck". NOT VERIFIED against a real CLI: whether these reads can disturb a
   running parse (they only read) and the exact field names beyond what the first investigation found (workers.parse_running, parse_queue_length,
   parse_server.local.healthy/starting, parses[].tier/page_range/status). `limits.livenessMs: 0` (the seam of a test or a preview) turns all of it off. */

const whole = value => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null);
const flagOf = value => (typeof value === 'boolean' ? value : null);
function jsonOf(text) {
  const raw = String(text ?? '').trim();
  const attempts = [raw];
  const open = raw.search(/[{[]/), close = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (open > 0 && close > open) attempts.push(raw.slice(open, close + 1));
  for (const attempt of attempts) { try { return JSON.parse(attempt); } catch { /* try the next reading */ } }
  return null;
}

/** The workers and the health of the parse server out of `mineru server status --json`: { parseRunning, queued, healthy, starting } (null for what it does not say), or null. */
export function parseServerStatus(text) {
  const data = jsonOf(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const workers = data.workers && typeof data.workers === 'object' ? data.workers : {};
  const local = data.parse_server?.local && typeof data.parse_server.local === 'object' ? data.parse_server.local : {};
  return { parseRunning: whole(workers.parse_running ?? data.parse_running), queued: whole(workers.parse_queue_length ?? data.parse_queue_length), healthy: flagOf(local.healthy), starting: flagOf(local.starting) };
}

const pageSpan = value => {
  if (Array.isArray(value) && value.length === 2 && value.every(item => Number.isInteger(item))) return [value[0], value[1]];
  const match = typeof value === 'string' ? /^\s*(\d+)\s*(?:[-–—:]\s*(\d+))?\s*$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2] ?? match[1])] : [null, null];
};
/** The parses out of `mineru list parses --json`: [{ id, tier, startPage, endPage, status }], or null when it is not that. */
export function parseListedParses(text) {
  const data = jsonOf(text), rows = Array.isArray(data) ? data : data?.parses;
  if (!Array.isArray(rows)) return null;
  return rows.filter(row => row && typeof row === 'object').map(row => {
    const [startPage, endPage] = pageSpan(row.page_range);
    return { id: row.id ?? null, tier: typeof row.tier === 'string' ? row.tier : null, startPage, endPage, status: typeof row.status === 'string' ? row.status : null };
  });
}

/**
 * Ask the service about the window `tier` `startPage`-`endPage` (read-only). Never throws and never starts or changes anything. Resolves
 * { at, server: 'running' | 'stopped' | 'unknown', parseRunning, queued, healthy, starting, mine: 'parsing' | 'pending' | 'none' | 'unknown' }: `mine` is whether the service
 * lists a parse with this tier and page range; 'unknown' when no list could be read.
 */
export async function probeService({ cli, tier, startPage, endPage, signal, timeoutMs = LOCAL.probeTimeoutMs } = {}) {
  const unknown = { at: Date.now(), server: 'unknown', parseRunning: null, queued: null, healthy: null, starting: null, mine: 'unknown' };
  if (!cli || signal?.aborted) return unknown;
  const ask = async args => {
    try { const result = await runCli(cli, args, { signal, timeoutMs }); return { code: result.code, out: result.stdout, said: `${result.stdout}\n${result.stderr}` }; } catch { return null; }
  };
  const status = await ask(['server', 'status', '--json']);
  if (signal?.aborted) return unknown;
  if (status && NOT_RUNNING.test(status.said)) return { ...unknown, server: 'stopped' };
  const info = status?.code === 0 ? parseServerStatus(status.out) : null;
  const rows = [];
  let read = 0, stopped = false;
  // The status already says nothing is parsing or waiting: the lists could only repeat it, and every question costs the CLI's own start-up on a machine that is busy converting.
  if (info && info.parseRunning === 0 && info.queued === 0) return { at: Date.now(), server: 'running', ...info, mine: 'none' };
  for (const wanted of ['pending', 'parsing']) {
    const listed = await ask(['list', 'parses', '--status', wanted, '--json']);
    if (signal?.aborted) return unknown;
    if (listed && NOT_RUNNING.test(listed.said)) { stopped = true; break; }
    const parsed = listed?.code === 0 ? parseListedParses(listed.out) : null;
    if (parsed) { read++; rows.push(...parsed.map(row => ({ ...row, status: row.status === 'pending' || row.status === 'parsing' ? row.status : wanted }))); }
  }
  if (stopped) return { ...unknown, server: 'stopped' };
  if (!info && !read) return unknown;
  const found = rows.filter(row => row.tier === tier && row.startPage === startPage && row.endPage === endPage);
  const mine = found.some(row => row.status === 'parsing') ? 'parsing' : found.length ? 'pending' : read === 2 ? 'none' : 'unknown';
  return { at: Date.now(), server: 'running', parseRunning: info?.parseRunning ?? null, queued: info?.queued ?? null, healthy: info?.healthy ?? null, starting: info?.starting ?? null, mine };
}

/**
 * The honest state of a running window from one answer and what was heard before (`memory`: { lastSignalAt, idleStreak }, ms). Resolves
 * { state, lastSignalAt, idleStreak, silentForMs, at, parseRunning, queued, healthy } where state is
 *   'queued' (the service has the parse waiting), 'parsing' (it is working), 'starting' (the parse server is starting or loading),
 *   'quiet' (it says nothing about this window yet, or is busy with another: not a problem), 'silent' (no response), 'stopped', 'unknown' (could not ask).
 * 'silent' is only said when the service reports nothing parsing or queued in `idleProbes` answers in a row AND nothing was heard for `silentMs`, or when its parse server
 * reports unhealthy: a service that is busy with something else, or a question that failed, is never "no response".
 */
export function livenessFrom(probe, memory = {}, { now = Date.now(), silentMs = LOCAL.silentMs, idleProbes = LOCAL.idleProbes } = {}) {
  const last = memory.lastSignalAt ?? now, streak = memory.idleStreak ?? 0;
  const base = { at: probe.at ?? now, parseRunning: probe.parseRunning ?? null, queued: probe.queued ?? null, healthy: probe.healthy ?? null };
  const heard = state => ({ ...base, state, lastSignalAt: now, idleStreak: 0, silentForMs: 0 });
  const kept = (state, idleStreak = streak) => ({ ...base, state, lastSignalAt: last, idleStreak, silentForMs: Math.max(0, now - last) });
  if (probe.server === 'stopped') return kept('stopped');
  if (probe.server !== 'running') return kept('unknown');
  if (probe.starting) return heard('starting');
  if (probe.healthy === false) return kept('silent');
  if (probe.mine === 'pending') return heard('queued');
  if (probe.mine === 'parsing') return heard('parsing');
  const busy = probe.parseRunning > 0, waiting = probe.queued > 0;
  if (probe.mine === 'unknown' && busy) return heard('parsing');
  if (probe.mine === 'unknown' && waiting) return heard('queued');
  if (busy || waiting) return heard('quiet');
  const idle = streak + 1;
  return kept(idle >= idleProbes && now - last > silentMs ? 'silent' : 'quiet', idle);
}

/**
 * Watch one running window: ask the service about it at `intervalMs` (the first time after `firstMs`), one question at a time (the next is armed only when the answer is in),
 * and call `onState(state)` with { state, at, lastSignalAt, silentForMs, parseRunning, queued, healthy } (times as ISO strings, `at` null before the first answer). `touch()`
 * says the command itself printed something. `stop()` ends it and aborts a question in flight. Disabled (`enabled: false`, nothing asked, nothing reported) without a command
 * line or with an interval of 0. A failing `probe` is 'unknown'.
 */
export function watchWindow({ cli, tier, startPage, endPage, signal, onState, intervalMs = LOCAL.livenessMs, firstMs = LOCAL.livenessFirstMs, silentMs, idleProbes, timeoutMs, probe = probeService, now = Date.now } = {}) {
  if (!cli || !(intervalMs > 0)) return { enabled: false, stop() {}, touch() {} };
  const iso = time => new Date(time).toISOString();
  const controller = new AbortController();
  let memory = { lastSignalAt: now(), idleStreak: 0 }, stopped = false, asking = false, timer;
  const tell = state => { try { onState?.(state); } catch { /* a listener's problem, never the watcher's */ } };
  const arm = ms => { if (!stopped) { timer = setTimeout(ask, ms); timer.unref?.(); } };
  async function ask() {
    if (stopped || asking) return;
    asking = true;
    try {
      const answer = await probe({ cli, tier, startPage, endPage, signal: controller.signal, ...(timeoutMs ? { timeoutMs } : {}) });
      if (stopped) return;
      const next = livenessFrom(answer, memory, { now: now(), ...(silentMs ? { silentMs } : {}), ...(idleProbes ? { idleProbes } : {}) });
      memory = { lastSignalAt: next.lastSignalAt, idleStreak: next.idleStreak };
      tell({ state: next.state, at: iso(next.at), lastSignalAt: iso(next.lastSignalAt), silentForMs: next.silentForMs, parseRunning: next.parseRunning, queued: next.queued, healthy: next.healthy });
    } catch {
      if (!stopped) tell({ state: 'unknown', at: iso(now()), lastSignalAt: iso(memory.lastSignalAt), silentForMs: Math.max(0, now() - memory.lastSignalAt), parseRunning: null, queued: null, healthy: null });
    } finally { asking = false; arm(intervalMs); }
  }
  const watch = {
    enabled: true,
    stop() { if (stopped) return; stopped = true; clearTimeout(timer); controller.abort(new Error('stopped')); },
    touch() { memory = { lastSignalAt: now(), idleStreak: 0 }; },
  };
  signal?.addEventListener('abort', () => watch.stop(), { once: true });
  tell({ state: 'quiet', at: null, lastSignalAt: iso(memory.lastSignalAt), silentForMs: 0, parseRunning: null, queued: null, healthy: null });
  arm(Math.min(firstMs, intervalMs));
  return watch;
}

/* ---------- reading the Markdown ---------- */

const MARKER = /^<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->[ \t]*$/gm;
const IMAGE = /^!\[[^\]]*\]\([^)]*\)$/;
const BULLET = /^\s*(?:[•·▪‣◦]|[-*+])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const range = (a, b) => (a === b ? `${a}` : `${a}–${b}`);

function blocksOf(body, pageIdx) {
  const items = [];
  const lines = body.split('\n');
  let paragraph = [], list = [], table = [];
  const flush = () => {
    if (paragraph.length) items.push({ type: 'text', text: paragraph.join('\n'), page_idx: pageIdx });
    if (list.length) items.push({ type: 'list', list_items: list, page_idx: pageIdx });
    if (table.length) items.push({ type: 'text', text: table.join('\n'), page_idx: pageIdx });
    paragraph = []; list = []; table = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    if (IMAGE.test(line.trim())) { flush(); items.push({ type: 'text', text: '[Figure]', page_idx: pageIdx }); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); items.push({ type: 'text', text: heading[2].trim(), text_level: Math.max(1, heading[1].length - 1), page_idx: pageIdx }); continue; }
    const bullet = BULLET.exec(line);
    if (bullet) { if (paragraph.length || table.length) flush(); list.push(bullet[1].trim()); continue; }
    if (line.trimStart().startsWith('|')) { if (paragraph.length || list.length) flush(); table.push(line); continue; }
    if (list.length || table.length) flush();
    paragraph.push(line);
  }
  flush();
  return items;
}

/**
 * The Markdown of one window as content_list items (v1) whose `page_idx` counts from the window's first page, the same shape
 * a cloud piece has, so lib/mineru-merge.js puts them in the book. Checks what the CLI returned: as many page markers as
 * the window has pages, each inside the window, and the TOTAL in each marker equal to the PDF's page count. Throws
 * LocalMineruError (marker-count, marker-range, total-mismatch). Resolves { content, markers, warnings }.
 */
export function parseLocalMarkdown(markdown, { startPage, endPage, totalPages }) {
  const text = String(markdown ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const found = [...text.matchAll(MARKER)].map(match => ({ page: Number(match[1]), total: Number(match[2]), index: match.index, end: match.index + match[0].length }));
  const expected = endPage - startPage + 1;
  if (found.length !== expected)
    throw new LocalMineruError('marker-count', `本地解析返回了 ${found.length} 页，这一段（第 ${range(startPage, endPage)} 页）应有 ${expected} 页。请重试这一段。`, { retryable: true });
  for (const marker of found)
    if (marker.page < startPage || marker.page > endPage)
      throw new LocalMineruError('marker-range', `本地解析返回的页码（第 ${marker.page} 页）不在这一段（第 ${range(startPage, endPage)} 页）里，没法放到正确的页上。请重试这一段。`, { retryable: true });
  if (new Set(found.map(marker => marker.page)).size !== found.length)
    throw new LocalMineruError('marker-range', `本地解析返回的页码有重复（这一段是第 ${range(startPage, endPage)} 页）。请重试这一段。`, { retryable: true });
  if (Number.isInteger(totalPages) && totalPages > 0) {
    const wrong = found.find(marker => marker.total !== totalPages);
    if (wrong) throw new LocalMineruError('total-mismatch', `本地解析读到的总页数（${wrong.total}）和这个 PDF 的页数（${totalPages}）不一致，没法确认页码对得上。请重试这一段。`, { retryable: true });
  }
  const content = [];
  found.forEach((marker, position) => {
    const body = text.slice(marker.end, found[position + 1]?.index ?? text.length);
    content.push(...blocksOf(body, marker.page - startPage));
  });
  return { content, markers: found.length, warnings: [] };
}

/* ---------- parsing a window ---------- */

const NOT_RUNNING = /服务未在运行|服务未运行|服务没有运行|not running|connection (?:to the local server )?(?:was )?(?:lost|refused|reset)|无法连接|ECONNREFUSED/i;

/**
 * Parse pages startPage..endPage of `pdf` locally and read the result. `--pages` is always given (the CLI's own default is only
 * the first 10 pages). Resolves { content, markers, warnings }; throws LocalMineruError (server-stopped, timeout, failed,
 * empty-output, marker-count, marker-range, total-mismatch) or the abort reason (the process tree is killed first).
 */
export async function parseWindow({ cli, pdf, tier, startPage, endPage, totalPages, outFile, signal, timeoutMs, waitSec: asked, onOutput }) {
  const pages = endPage - startPage + 1;
  const waitSec = asked ?? waitSeconds({ pages });
  const args = ['parse', pdf, '--tier', tier, '--pages', `${startPage}-${endPage}`, '--wait', String(waitSec), '--json', '-o', outFile, '--force'];
  const result = await runCli(cli, args, { signal, timeoutMs: timeoutMs ?? (waitSec + 60) * 1000, ...(onOutput ? { onLine: () => onOutput() } : {}) });
  if (result.code !== 0) {
    const said = clip(`${result.stderr} ${result.stdout}`);
    if (NOT_RUNNING.test(said)) throw new LocalMineruError('server-stopped', LOCAL_MESSAGES.serverStopped, { retryable: true });
    throw new LocalMineruError('failed', `本地解析没有成功：${said || '没有返回原因'}`, { retryable: true });
  }
  let markdown;
  try { markdown = await readFile(outFile, 'utf8'); }
  catch { throw new LocalMineruError('empty-output', LOCAL_MESSAGES.emptyOutput, { retryable: true }); }
  finally { await rm(outFile, { force: true }).catch(() => {}); }
  return parseLocalMarkdown(markdown, { startPage, endPage, totalPages });
}
