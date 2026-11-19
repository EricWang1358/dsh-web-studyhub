// @ts-check

import { SUPPORTED_CLI_PROVIDERS } from './contracts.js';

/* 「在学习库里打开 CLI」: what may be started, where, and the one command line that starts it.
   The page names a CLI and nothing else. The program is the one discovery found ready, the folder is the study library,
   and the only arguments are the script paths an npm shim unwraps to: no caller-supplied path, flag or text reaches the line. */

/** Characters `cmd.exe` may read as syntax even inside quotes (`%VAR%`, a closing quote), plus the ones refused to stay simple. */
const CMD_SYNTAX_RE = /["%^!&|<>]/;
const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/u;
/** A drive-letter path. Network folders are left out: `start /d` cannot make one the current folder. */
const DRIVE_PATH_RE = /^[A-Za-z]:\\/;
const MAX_PATH_LENGTH = 1024;

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isPlainDrivePath(value) {
  return typeof value === 'string'
    && value.length <= MAX_PATH_LENGTH
    && DRIVE_PATH_RE.test(value)
    && !CMD_SYNTAX_RE.test(value)
    && !CONTROL_OR_FORMAT_RE.test(value);
}

/**
 * The ready local CLI the page asked for, and the library folder to open it in.
 * @param {ReadonlyArray<{ id: string, supported?: boolean, status?: string, executablePath?: string | null }>} providers
 * @param {unknown} providerId
 * @param {string} libraryRoot
 * @returns {{ executablePath: string, cwd: string }}
 */
export function cliLaunchRequest(providers, providerId, libraryRoot) {
  const id = SUPPORTED_CLI_PROVIDERS.find((item) => item === providerId);
  if (!id) throw coded('不支持打开这个本机 CLI', 'invalid-cli');
  const ready = (Array.isArray(providers) ? providers : []).find((item) => item.id === id && item.supported && item.status === 'ready');
  if (!ready?.executablePath) throw coded('这个本机 CLI 还没有就绪，先点「重新扫描」', 'cli-not-ready');
  return { executablePath: ready.executablePath, cwd: libraryRoot };
}

/**
 * The verbatim `cmd.exe` argument line that opens a new console window in `cwd` running `command`.
 * Every part is an absolute drive path wrapped in quotes; anything else is refused, never escaped.
 * @param {{ cwd: string, command: string, args?: ReadonlyArray<string> }} parts
 * @returns {string}
 */
export function buildStartCommandLine({ cwd, command, args = [] }) {
  const scripts = Array.isArray(args) ? args : [];
  const plain = [cwd, command, ...scripts].every(isPlainDrivePath) && ![command, ...scripts].some((part) => part.endsWith('\\'));
  if (!plain) {
    throw coded('路径里有特殊字符或不是本机磁盘路径，没法自动打开命令行。请自己打开命令行，进入学习库目录后运行这个 CLI', 'terminal-path-unsafe');
  }
  const program = [command, ...scripts].map((part) => `"${part}"`).join(' ');
  return `/d /s /c "start "" /d "${cwd}" ${program}"`;
}
