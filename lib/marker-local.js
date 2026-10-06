import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';
import { runLocalCommand } from './local-command.js';
import { plainReason } from './mineru-history.js';
import { maxBytesFor } from './office/limits.js';

export class MarkerError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message); this.name = 'MarkerError'; this.code = code; this.retryable = retryable;
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

/** `marker_single --help` imports the whole model stack before it prints anything: about 16 s on a warm machine, far longer on a cold start, a busy disk or while an antivirus scans the libraries.
   Detection only asks whether the command works, so it waits for that instead of calling a slow start "not ready". */
export const MARKER_DETECT_TIMEOUT_MS = 2 * 60_000;
const REQUIRED_FLAGS = ['--output_dir', '--page_range', '--paginate_output', '--output_format', '--disable_image_extraction'];
/** Ready describes command compatibility; model/backend availability is established by an actual conversion. */
export async function detectMarker({ cli, signal, timeoutMs = MARKER_DETECT_TIMEOUT_MS } = {}) {
  if (!cli) return { state: 'not-installed', next: 'install' };
  try {
    const result = await runLocalCommand(cli, ['--help'], { signal, timeoutMs });
    const help = `${result.stdout}\n${result.stderr}`;
    const missing = REQUIRED_FLAGS.filter(flag => !help.includes(flag));
    return result.code === 0 && !missing.length
      ? { state: 'ready', next: null, command: cli.file }
      : { state: 'unavailable', next: 'recheck', command: cli.file, message: 'Marker 程序暂时无法使用，请检查安装和版本。' };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.code === 'timeout') return { state: 'unavailable', next: 'recheck', reason: 'timeout', command: cli.file, message: 'Marker 启动很慢，检测在时限内没有等到响应。第一次启动要加载大量库，再点一次「保存并检测」通常就能通过。' };
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

/** Each attempt uses its own directory and reads only the documented <stem>/<stem>.md output. */
export async function parseMarkerWindow({ cli, pdf, startPage, endPage, totalPages, outFile, signal, timeoutMs = 120 * 60_000, onOutput } = {}) {
  if (!cli) throw new MarkerError('not-installed', '没有找到 Marker，请先在设置中配置程序路径。');
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage || endPage > totalPages) {
    throw new MarkerError('invalid-pages', 'Marker 解析页码范围无效。');
  }
  const parent = path.dirname(outFile);
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(path.join(parent, 'marker-output-'));
  try {
    let result;
    try {
      result = await runLocalCommand(cli, [pdf, '--output_dir', output, '--page_range', `${startPage - 1}-${endPage - 1}`,
        '--paginate_output', '--output_format', 'markdown', '--disable_image_extraction'], { signal, timeoutMs, onLine: onOutput });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new MarkerError(error.code || 'marker-failed', error.code === 'timeout'
        ? '这一段 Marker 解析用时过长，可以接着做重试。' : 'Marker 程序未能运行，请检查设置中的程序路径。', { retryable: true });
    }
    if (result.code !== 0) {
      const diagnostic = plainReason(String(result.stderr || result.stdout).slice(-2000), { secrets: [pdf, cli.file, output, outFile] });
      throw new MarkerError('marker-failed', `Marker 解析失败，请检查安装、模型和运行环境后重试。${diagnostic ? ` ${diagnostic}` : ''}`, { retryable: true });
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
