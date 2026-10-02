import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';

/* The local `mineru` command line (free, nothing leaves the computer). StudyHub finds it, reads its state with read-only calls,
   and, only when the learner clicks, starts its service or sets it up; a conversion runs it on consecutive page windows
   (`--pages a-b` is native, so no PDF splitting is needed) and reads the Markdown it writes into the same page model the cloud
   route produces (lib/mineru-merge.js). What is known about the CLI (4.0.x) comes from a real install: Markdown output only,
   pages delimited by `<!-- page N of TOTAL -->` (N is the original page number), images only as placeholders, a local service
   that must be running, and a DEFAULT of just the first 10 pages: so every parse here states its pages explicitly. */

export const LOCAL = Object.freeze({
  /** Pages per `mineru parse` call: progress, resume and cancel work in windows of this size. */
  windowPages: 50,
  /** The tiers worth setting up ('flash' is the base package's text-only preview). */
  tiers: Object.freeze(['basic', 'standard', 'advanced']),
  /** The wait StudyHub asks the CLI for, per window: generous but bounded. */
  waitFloorSec: 120, waitPerPageSec: 8, waitCeilSec: 1800,
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
export async function parseWindow({ cli, pdf, tier, startPage, endPage, totalPages, outFile, signal, timeoutMs }) {
  const pages = endPage - startPage + 1;
  const waitSec = Math.min(LOCAL.waitCeilSec, Math.max(LOCAL.waitFloorSec, pages * LOCAL.waitPerPageSec));
  const args = ['parse', pdf, '--tier', tier, '--pages', `${startPage}-${endPage}`, '--wait', String(waitSec), '--json', '-o', outFile, '--force'];
  const result = await runCli(cli, args, { signal, timeoutMs: timeoutMs ?? (waitSec + 60) * 1000 });
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
