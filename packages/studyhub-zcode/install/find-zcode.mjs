/* Find ZCode's command-line entry (<install folder>\resources\glm\zcode.cjs) wherever ZCode is installed, for install.bat.
   The reference installer only looked under %LOCALAPPDATA% and C:'s Program Files; ZCode can live on any drive
   (e.g. E:\Program Files\ZCode). Looked at, in order, and the first folder that has the entry wins:
     1. a folder given on the command line (install.bat "E:\Program Files\ZCode") or in ZCODE_HOME
     2. the running ZCode process (its executable's folder)
     3. the registry: App Paths of ZCode.exe and the uninstall entries whose name contains ZCode (InstallLocation,
        DisplayIcon, UninstallString), for the user and the machine, 64- and 32-bit views
     4. the usual places: %LOCALAPPDATA%\Programs\ZCode, then <drive>:\Program Files\ZCode, <drive>:\Program Files (x86)\ZCode
        and <drive>:\ZCode on every drive that exists
   Prints the entry's full path and exits 0, or prints nothing and exits 1. Reads only; changes nothing. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

// A Windows tool: Windows paths on every platform (the tests run on Linux too).
const { dirname, join } = win32;
import { pathToFileURL } from 'node:url';

export const ENTRY = join('resources', 'glm', 'zcode.cjs');
const UNINSTALL_ROOTS = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'];
const APP_PATHS = ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ZCode.exe', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ZCode.exe'];

/** A registry or command-line value as a folder: quotes, an icon index (",0") and arguments after an .exe are dropped. */
export function folderOf(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  const quoted = text.match(/^"([^"]+)"/);
  if (quoted) text = quoted[1];
  else { const exe = text.match(/^(.+?\.exe)\b/i); if (exe) text = exe[1]; }
  text = text.replace(/,\s*-?\d+$/, '').trim();
  if (!win32.isAbsolute(text)) return null;
  return /\.(exe|ico|cjs)$/i.test(text) ? win32.dirname(text) : text;
}

/** The values of `reg query` output: [{ key, name, value }]. */
export function parseReg(output) {
  const rows = [];
  let key = '';
  for (const line of String(output || '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) { key = line.trim(); continue; }
    const match = line.match(/^\s+(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s{2,}(.*)$/);
    if (match) rows.push({ key, name: match[1].trim(), value: match[2].trim() });
  }
  return rows;
}

/** Folders the registry names for ZCode. `query(args)` runs `reg` (injected in tests). */
export function registryFolders(query) {
  const folders = [];
  for (const key of APP_PATHS) {
    // The default value is ZCode.exe's full path ("(默认)" on a Chinese Windows); Path is its folder.
    for (const row of parseReg(query(['query', key]))) if (['(Default)', '(默认)', 'Path'].includes(row.name)) folders.push(folderOf(row.value));
  }
  for (const root of UNINSTALL_ROOTS) {
    const rows = parseReg(query(['query', root, '/s', '/f', 'ZCode', '/d']));
    const keys = new Set(rows.filter((row) => row.name === 'DisplayName' && /zcode/i.test(row.value)).map((row) => row.key));
    for (const row of rows.filter((item) => keys.has(item.key)))
      if (['InstallLocation', 'DisplayIcon', 'UninstallString'].includes(row.name)) folders.push(folderOf(row.value));
    // The search above only returns matching values; read the matching keys whole for their install location.
    for (const key of keys) for (const row of parseReg(query(['query', key])))
      if (['InstallLocation', 'DisplayIcon', 'UninstallString'].includes(row.name)) folders.push(folderOf(row.value));
  }
  return folders.filter(Boolean);
}

/** The folder of a running ZCode, from PowerShell (null when none runs). */
function processFolder(run) {
  const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1).Path"]);
  return folderOf(String(out || '').trim());
}

/** The usual install folders on every drive that exists. */
export function usualFolders(env = process.env, exists = existsSync) {
  const folders = [];
  if (env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, 'Programs', 'ZCode'));
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (env[name]) folders.push(join(env[name], 'ZCode'));
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    if (!exists(drive)) continue;
    folders.push(win32.join(drive, 'Program Files', 'ZCode'), win32.join(drive, 'Program Files (x86)', 'ZCode'), win32.join(drive, 'ZCode'));
  }
  return folders;
}

/**
 * The full path of zcode.cjs, or null. Every source is injected for tests: `given` (a folder), `env`, `exists(path)`,
 * `run(command, args)` -> stdout ('' on failure).
 */
export function findZcode({ given, env = process.env, exists = existsSync, run = safeRun } = {}) {
  const seen = new Set();
  const sources = [
    () => [folderOf(given), folderOf(env.ZCODE_HOME)],
    () => [processFolder(run)],
    () => registryFolders((args) => run('reg', args)),
    () => usualFolders(env, exists),
  ];
  for (const source of sources) {
    let folders = [];
    try { folders = source(); } catch { folders = []; }
    for (const folder of folders) {
      if (!folder || seen.has(folder.toLowerCase())) continue;
      seen.add(folder.toLowerCase());
      // The folder itself, or a resources\glm folder someone pointed at directly.
      for (const candidate of [join(folder, ENTRY), join(dirname(dirname(folder)), ENTRY)]) if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function safeRun(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = findZcode({ given: process.argv[2] });
  if (found) process.stdout.write(found);
  process.exit(found ? 0 : 1);
}
