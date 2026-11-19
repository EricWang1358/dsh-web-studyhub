// @ts-check

export const MAX_EXTERNAL_URL_LENGTH = 2000;
const SAFE_EXTERNAL_URL_RE = /^https?:\/\/[^\s"'`<>\\^|\x00-\x1f\x7f]+$/i;
const BIDI_OR_FORMAT_RE = /\p{Cf}/u;

/**
 * @param {URL} parsed
 * @returns {boolean}
 */
function isSafeParsedUrl(parsed) {
  const allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  return allowed && !parsed.username && !parsed.password && Boolean(parsed.hostname);
}

/**
 * Validate an external URL for OS browser opening (`http:` / `https:` only).
 * Returns canonical `URL.href` or `null` when refused.
 * @param {unknown} value
 * @returns {string | null}
 */
export function openableExternalUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > MAX_EXTERNAL_URL_LENGTH) return null;
  if (!SAFE_EXTERNAL_URL_RE.test(url) || BIDI_OR_FORMAT_RE.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!isSafeParsedUrl(parsed)) return null;
    return parsed.href.length <= MAX_EXTERNAL_URL_LENGTH ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a `%dp0%` or `%~dp0` relative segment inside a Windows `.cmd` shim against `shimDir`.
 * Pure path joining without `node:path`.
 * @param {string} shimDir
 * @param {string} rawRelative
 * @returns {string}
 */
function joinWinPath(shimDir, rawRelative) {
  const base = shimDir.replace(/[\\/]+$/, '');
  const rel = rawRelative.replace(/^[\\/]+/, '').replaceAll('/', '\\');
  return `${base}\\${rel}`;
}

const NODE_EXE_RE = /(?:^|[\\/])node\.exe$/i;

/**
 * Find the first quoted `.exe` path matching `pattern` that is not `node.exe`.
 * Prevents npm `.cmd` shims (`IF EXIST "%dp0%\node.exe"`) from resolving to `node.exe`.
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {string | null}
 */
function findNonNodeExe(text, pattern) {
  for (const match of text.matchAll(pattern)) {
    const candidate = match[1] || '';
    if (candidate && !NODE_EXE_RE.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Extract native `.exe` or Node `.js`/`.mjs`/`.cjs` target from a Windows npm `.cmd` shim.
 * Eliminates the need for `shell: true` (CVE-2024-27980 `EINVAL` on Node 22).
 * @param {string} content
 * @param {string} shimDir
 * @returns {{ kind: 'exe' | 'node-script', targetPath: string } | null}
 */
export function parseCmdShimTarget(content, shimDir) {
  const text = String(content ?? '');
  const scriptMatch = text.match(/"%(?:dp0%|~dp0)[\\/]*([^"]+\.(?:c|m)?js)"/i);
  if (scriptMatch?.[1]) {
    return { kind: 'node-script', targetPath: joinWinPath(shimDir, scriptMatch[1]) };
  }
  const relExe = findNonNodeExe(text, /"%(?:dp0%|~dp0)[\\/]*([^"]+\.exe)"/gi);
  if (relExe) {
    return { kind: 'exe', targetPath: joinWinPath(shimDir, relExe) };
  }
  const absScriptMatch = text.match(/"([A-Za-z]:\\[^"]+\.(?:c|m)?js)"/i);
  if (absScriptMatch?.[1]) {
    return { kind: 'node-script', targetPath: absScriptMatch[1] };
  }
  const absExe = findNonNodeExe(text, /"([A-Za-z]:\\[^"]+\.exe)"/gi);
  if (absExe) {
    return { kind: 'exe', targetPath: absExe };
  }
  return null;
}

/**
 * Parse a semantic/CLI version string from `--version` stdout.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseCliVersion(stdout) {
  const firstLine = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  if (!firstLine) return null;
  const match = firstLine.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/);
  return match ? match[0] : null;
}
