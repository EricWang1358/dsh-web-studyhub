/* Find ZCode's command-line entry (<install folder>\resources\glm\zcode.cjs) wherever ZCode is installed, for install.mjs.
   The reference installer only looked under %LOCALAPPDATA% and C:'s Program Files; ZCode can live on any drive
   (e.g. E:\Program Files\ZCode) and in a folder with any characters. Looked at, in order; the first folder that has the
   entry wins:
     1. a folder given on the command line (install.bat "E:\Program Files\ZCode") or in ZCODE_HOME
     2. the running ZCode process (its executable's folder)
     3. the registry: App Paths of ZCode.exe (its default value and Path) and the uninstall entries whose name contains
        ZCode (InstallLocation, DisplayIcon, UninstallString), for the user and the machine, 64- and 32-bit views
     4. the usual places: %LOCALAPPDATA%\Programs\ZCode, then <drive>:\Program Files\ZCode, <drive>:\Program Files (x86)\ZCode
        and <drive>:\ZCode on every drive that exists
   2 and 3 are one PowerShell call (by its full path) whose answer is base64 of UTF-8 JSON, so a Chinese folder name
   arrives intact whatever the console code page is. Prints the entry's full path and exits 0, or exits 1. Reads only. */
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { powershellText } from '../host/workspace.mjs';

// A Windows tool: Windows paths on every platform (the tests run on Linux too).
const { dirname, join } = win32;

export const ENTRY = join('resources', 'glm', 'zcode.cjs');

/** The PowerShell script: { process: [paths], registry: [values] } as JSON. GetValue('') is the default value in any language. */
export const DISCOVERY_SCRIPT = [
  "$found = [ordered]@{ process = @(); registry = @() }",
  "$p = Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1",
  "if ($p) { $found.process += [string]$p.Path }",
  "foreach ($k in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ZCode.exe', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ZCode.exe')) {",
  "  $i = Get-Item -LiteralPath $k -ErrorAction SilentlyContinue",
  "  if ($i) { foreach ($n in @('', 'Path')) { $v = $i.GetValue($n); if ($v) { $found.registry += [string]$v } } } }",
  "foreach ($r in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) {",
  "  Get-ItemProperty -Path $r -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*ZCode*' } | ForEach-Object {",
  "    foreach ($n in @('InstallLocation', 'DisplayIcon', 'UninstallString')) { if ($_.$n) { $found.registry += [string]$_.$n } } } }",
  "$found | ConvertTo-Json -Compress",
].join('\n');

/** A registry or command-line value as a folder: quotes, an icon index (",0") and arguments after an .exe are dropped. */
export function folderOf(value) {
  let text = String(value || '').trim();
  if (!text || text.includes('\uFFFD')) return null;
  const quoted = text.match(/^"([^"]+)"/);
  if (quoted) text = quoted[1];
  else { const exe = text.match(/^(.+?\.exe)\b/i); if (exe) text = exe[1]; }
  text = text.replace(/,\s*-?\d+$/, '').trim();
  if (!win32.isAbsolute(text)) return null;
  return /\.(exe|ico|cjs)$/i.test(text) ? win32.dirname(text) : text;
}

/** The folders the discovery JSON names: the running process first, then the registry. */
export function discoveredFolders(json) {
  let found;
  try { found = JSON.parse(json || '{}'); } catch { return []; }
  const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  return [...list(found?.process), ...list(found?.registry)].map(folderOf).filter(Boolean);
}

/** The usual install folders on every drive that exists. */
export function usualFolders(env = process.env, exists = existsSync) {
  const folders = [];
  if (env.LOCALAPPDATA) folders.push(join(env.LOCALAPPDATA, 'Programs', 'ZCode'));
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) if (env[name]) folders.push(join(env[name], 'ZCode'));
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    if (!exists(drive)) continue;
    folders.push(join(drive, 'Program Files', 'ZCode'), join(drive, 'Program Files (x86)', 'ZCode'), join(drive, 'ZCode'));
  }
  return folders;
}

/**
 * The full path of zcode.cjs, or null. Injected in tests: `given` (a folder), `env`, `exists(path)`, `discover()` -> the
 * discovery JSON text (default: the PowerShell call, `run` passed on to powershellText).
 */
export function findZcode({ given, env = process.env, exists = existsSync, run, discover } = {}) {
  const seen = new Set();
  const sources = [
    () => [folderOf(given), folderOf(env.ZCODE_HOME)],
    () => discoveredFolders(discover ? discover() : powershellText(DISCOVERY_SCRIPT, { ...(run ? { run } : {}) })),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = findZcode({ given: process.argv[2] });
  if (found) process.stdout.write(found);
  process.exit(found ? 0 : 1);
}
