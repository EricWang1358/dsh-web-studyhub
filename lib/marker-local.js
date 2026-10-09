import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import { runLocalCommand } from './local-command.js';
import { failureOf } from './marker-output.js';
import { maxBytesFor } from './office/limits.js';

export class MarkerError extends Error {
  /** `detail`: { exitCode, lines } (the last lines Marker printed, plain); `fix`: 'settings' when only a change of the installation can help (the job then leads there). */
  constructor(code, message, { retryable = false, detail, fix } = {}) {
    super(message); this.name = 'MarkerError'; this.code = code; this.retryable = retryable;
    if (detail) this.detail = detail;
    if (fix) this.fix = fix;
  }
}

export function locateMarker({ command = '', env = process.env, platform = process.platform, homedir = osHomedir(), exists = existsSync } = {}) {
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'marker_single.exe' : 'marker_single';
  // An explicit path must not silently fall back to a different installation.
  const explicit = command || env.MARKER_BIN;
  const candidates = explicit ? [explicit] : [
    ...String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(folder => flavour.join(folder, name)),
    flavour.join(homedir, '.local', 'bin', name),
  ];
  const file = candidates.find(candidate => { try { return exists(candidate); } catch { return false; } });
  return file ? { file, prefix: [], env: {} } : null;
}

/** The newest major version of marker-pdf that runs its OCR models inside its own process. marker-pdf 2.x runs them through an inference server it starts in Docker
 *  by default: that is a legitimate way to run it, but on a computer where Docker is missing or not running every conversion that needs OCR fails, and `--help` cannot
 *  tell. So a 2.x is checked for Docker, and the learner is offered both ways: start Docker, or 修复安装 (the one-click install asks pip for 1.x: lib/marker-install.js). */
export const MARKER_IN_PROCESS_MAJOR = 1;
/** Docker as a 2.x needs it: 'running' (no warning), 'stopped' (installed, the daemon does not answer), 'missing' (no docker program), 'unknown' (no answer in time). */
export const DOCKER_STATES = Object.freeze(['running', 'stopped', 'missing', 'unknown']);
export const MARKER_TEXT = Object.freeze({
  needsDocker: (major, docker = 'unknown') => (docker === 'missing'
    ? `已安装的 Marker 是 ${major}.x，它要用 Docker 跑推理服务，但这台电脑上没有找到 Docker。可以安装并启动 Docker Desktop；不想用 Docker 的话，点「修复安装（改装 1.x）」。`
    : docker === 'stopped'
      ? `已安装的 Marker 是 ${major}.x，它要用 Docker 跑推理服务，但 Docker 没有运行。请启动 Docker Desktop，等它显示正在运行后点「重新检测」；不想用 Docker 的话，点「修复安装（改装 1.x）」。`
      : `已安装的 Marker 是 ${major}.x，它要用 Docker 跑推理服务。请启动 Docker Desktop；不想用 Docker 的话，点「修复安装（改装 1.x）」。`),
  exited: (code, cause) => (cause ? `Marker 退出码 ${code}：${cause}` : `Marker 退出码 ${code}，没有输出原因。`),
});

/** The marker-pdf version of the Python environment a `marker_single` belongs to, read from its dist-info folder (no process is started): "1.10.2", or "" when it
 *  cannot be told (a program outside a virtual environment, a stand-in). <env>/Scripts|bin/marker_single → <env>/Lib/site-packages or <env>/lib/python3.x/site-packages. */
export async function markerVersion(file) {
  if (typeof file !== 'string' || !file) return '';
  const env = path.dirname(path.dirname(file)), sites = [path.join(env, 'Lib', 'site-packages')];
  try { for (const name of await readdir(path.join(env, 'lib'))) if (/^python\d/i.test(name)) sites.push(path.join(env, 'lib', name, 'site-packages')); } catch { /* not a POSIX venv */ }
  for (const site of sites) {
    try {
      const found = (await readdir(site)).map(name => /^marker_pdf-(\d+(?:\.\d+)*[\w.+-]*?)\.dist-info$/i.exec(name)).find(Boolean);
      if (found) return found[1];
    } catch { /* no such folder */ }
  }
  return '';
}
const majorOf = version => Number.parseInt(String(version).split('.')[0], 10);

export const DOCKER_CLI = Object.freeze({ file: 'docker', prefix: [], env: {} });
export const DOCKER_TIMEOUT_MS = 8_000;
/** Whether Docker answers, for a Marker 2.x: `docker version --format {{.Server.Version}}` with a short limit; never throws. `docker` is the program (a seam of a test). */
export async function dockerState({ docker = DOCKER_CLI, signal, timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  try {
    const result = await runLocalCommand(docker, ['version', '--format', '{{.Server.Version}}'], { signal, timeoutMs });
    return result.code === 0 && result.stdout.trim() ? 'running' : 'stopped';
  } catch (error) {
    if (signal?.aborted) throw error;
    return error?.code === 'not-installed' ? 'missing' : 'unknown';
  }
}
/** Whether a status of detectMarker lets a conversion start: ready, or a 2.x whose Docker could not be asked in time (the conversion itself will say). */
export const markerUsable = status => status?.state === 'ready' || (status?.state === 'needs-docker' && status.docker === 'unknown');

/** `marker_single --help` imports the whole model stack before it prints anything: about 16 s on a warm machine, far longer on a cold start, a busy disk or while an antivirus scans the libraries.
   Detection only asks whether the command works, so it waits for that instead of calling a slow start "not ready". */
export const MARKER_DETECT_TIMEOUT_MS = 2 * 60_000;
const REQUIRED_FLAGS = ['--output_dir', '--page_range', '--paginate_output', '--output_format', '--disable_image_extraction'];
/** Ready describes command compatibility; model/backend availability is established by an actual conversion. A marker-pdf 2.x (its version read from the environment
 *  without starting anything, `readVersion` a seam of a test) is ready only while Docker answers, else 'needs-docker' with the two ways out in `message`. */
export async function detectMarker({ cli, signal, timeoutMs = MARKER_DETECT_TIMEOUT_MS, docker, readVersion = markerVersion } = {}) {
  if (!cli) return { state: 'not-installed', next: 'install' };
  try {
    const result = await runLocalCommand(cli, ['--help'], { signal, timeoutMs });
    const help = `${result.stdout}\n${result.stderr}`;
    const missing = REQUIRED_FLAGS.filter(flag => !help.includes(flag));
    if (result.code !== 0 || missing.length) return { state: 'unavailable', next: 'recheck', command: cli.file, message: 'Marker 程序暂时无法使用，请检查安装和版本。' };
    const version = await readVersion(cli.file), major = majorOf(version);
    if (major > MARKER_IN_PROCESS_MAJOR) {
      const state = await dockerState({ docker, signal });
      if (state !== 'running') return { state: 'needs-docker', next: 'docker-or-repair', command: cli.file, version, docker: state, message: MARKER_TEXT.needsDocker(major, state) };
      return { state: 'ready', next: null, command: cli.file, version, docker: state };
    }
    return { state: 'ready', next: null, command: cli.file, ...(version ? { version } : {}) };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.code === 'timeout') return { state: 'unavailable', next: 'recheck', reason: 'timeout', command: cli.file, message: 'Marker 启动很慢，检测在时限内没有等到响应。第一次启动要加载大量库，再点一次「检测并保存」通常就能通过。' };
    return { state: error.code === 'not-installed' ? 'not-installed' : 'unavailable', next: 'recheck', command: cli.file,
      message: 'Marker 检测未完成，请检查程序路径后重新检测。' };
  }
}

/** Marker labels contain original, zero-based PDF page numbers, including blank pages. */
export function parseMarkerMarkdown(markdown, startPage, endPage) {
  const text = String(markdown).replace(/\r\n?/g, '\n');
  const markers = [...text.matchAll(/^\{(\d+)\}-{48}[ \t]*$/gm)];
  const expected = endPage - startPage + 1;
  if (markers.length !== expected || text.slice(0, markers[0]?.index ?? text.length).trim()
    || markers.some((marker, index) => Number(marker[1]) !== startPage - 1 + index)) {
    throw new MarkerError('invalid-output', 'Marker 结果缺少完整页码，请检查版本后重试这一段。', { retryable: true });
  }
  return markers.map((marker, index) => ({ type: 'text', page_idx: index,
    text: text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length).trim() }));
}

/** A Marker that ends with one of these needs its installation changed, not another try. */
const NEEDS_DOCKER = /SpawnError|docker run failed|dockerDesktopLinuxEngine|docker API|Cannot connect to the Docker daemon/i;
const BROKEN_INSTALL = /ModuleNotFoundError|No module named|ImportError|DLL load failed|cannot import name/i;
const TAIL = 16_000;

/** Why a run that exited non-zero failed, as a MarkerError: the cause first (the exception of the traceback, or the plain reason a known one means), the last lines in `detail`. */
export function markerExitError({ code, text, secrets = [] }) {
  const { summary, lines } = failureOf(text, { secrets }), detail = { exitCode: code, lines };
  if (NEEDS_DOCKER.test(text)) return new MarkerError('marker-needs-docker', MARKER_TEXT.needsDocker(2), { retryable: true, detail, fix: 'settings' });
  return new MarkerError('marker-failed', MARKER_TEXT.exited(code, summary), { retryable: true, detail, ...(BROKEN_INSTALL.test(summary) ? { fix: 'settings' } : {}) });
}

/** Each attempt uses its own directory and reads only the documented <stem>/<stem>.md output. `onOutput(line)`: each line printed; `onText(text, stream)`: the raw pieces (lib/marker-output.js). */
export async function parseMarkerWindow({ cli, pdf, startPage, endPage, totalPages, outFile, signal, timeoutMs = 120 * 60_000, onOutput, onText } = {}) {
  if (!cli) throw new MarkerError('not-installed', '没有找到 Marker，请先在设置中配置程序路径。', { fix: 'settings' });
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage || endPage > totalPages) {
    throw new MarkerError('invalid-pages', 'Marker 解析页码范围无效。');
  }
  const parent = path.dirname(outFile);
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(path.join(parent, 'marker-output-'));
  // The END of what Marker printed is kept here (the captured output keeps only its first megabyte, and a long run of progress bars can fill that): a traceback's cause is its last line.
  const tails = { stdout: '', stderr: '' };
  try {
    let result;
    try {
      result = await runLocalCommand(cli, [pdf, '--output_dir', output, '--page_range', `${startPage - 1}-${endPage - 1}`,
        '--paginate_output', '--output_format', 'markdown', '--disable_image_extraction'], { signal, timeoutMs, onLine: onOutput,
        onText: (text, stream) => { tails[stream] = (tails[stream] + text).slice(-TAIL); onText?.(text, stream); } });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new MarkerError(error.code || 'marker-failed', error.code === 'timeout'
        ? '这一段 Marker 解析用时过长，可以接着做重试。' : 'Marker 程序未能运行，请检查设置中的程序路径。', { retryable: true, ...(error.code === 'timeout' ? {} : { fix: 'settings' }) });
    }
    if (result.code !== 0) {
      const said = tails.stderr.trim() ? tails.stderr : tails.stdout.trim() ? tails.stdout : String(result.stderr || result.stdout).slice(-TAIL);
      throw markerExitError({ code: result.code, text: said, secrets: [pdf, cli.file, output, outFile] });
    }
    const stem = path.basename(pdf, path.extname(pdf));
    let markdown;
    try {
      const resultFile = path.join(output, stem, `${stem}.md`);
      const metadata = await stat(resultFile);
      if (!metadata.isFile()) throw new Error('not a file');
      if (metadata.size > maxBytesFor('markdown')) throw new MarkerError('too-big', 'Marker 这一段的结果超过导入大小限制，请把 PDF 分成较小文件后重新导入。');
      markdown = await readFile(resultFile, 'utf8');
    } catch (error) {
      if (error instanceof MarkerError) throw error;
      throw new MarkerError('empty-output', 'Marker 没有写出结果，请检查安装后重试这一段。', { retryable: true });
    }
    const content = parseMarkerMarkdown(markdown, startPage, endPage);
    await writeFile(outFile, markdown, 'utf8');
    return { content };
  } finally { await rm(output, { recursive: true, force: true, maxRetries: 5 }); }
}
