import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

async function isRegularFile(targetPath) {
  try {
    const info = await stat(targetPath);
    return info.isFile();
  } catch {
    return false;
  }
}

function namesForProvider(providerId, platform) {
  if (platform === 'win32') {
    return [`${providerId}.exe`, `${providerId}.cmd`, `${providerId}.bat`, providerId];
  }
  return [providerId];
}

function explicitHomeCandidates(providerId, home, platform) {
  if (providerId === 'agy') {
    return platform === 'win32'
      ? [join(home, '.gemini', 'bin', 'agy.exe'), join(home, '.gemini', 'antigravity', 'bin', 'agy.exe')]
      : [join(home, '.gemini', 'bin', 'agy'), join(home, '.gemini', 'antigravity', 'bin', 'agy')];
  }
  return [];
}

function extraInstallDirs(env, home, platform) {
  if (platform === 'win32') {
    const dirs = [];
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
    dirs.push(join(home, '.local', 'bin'));
    return dirs;
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

function pathEntries(env, platform) {
  const raw = env.PATH || env.Path || '';
  const sep = platform === 'win32' ? ';' : delimiter;
  return raw.split(sep).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function buildRawCandidateList(providerId, { customPath, env, home, platform }) {
  const list = [];
  if (typeof customPath === 'string' && customPath.trim()) {
    list.push(resolve(customPath.trim()));
  }
  list.push(...explicitHomeCandidates(providerId, home, platform));
  const names = namesForProvider(providerId, platform);
  const dirs = [...pathEntries(env, platform), ...extraInstallDirs(env, home, platform)];
  for (const dir of dirs) {
    for (const name of names) list.push(join(dir, name));
  }
  return list;
}

/**
 * Enumerate existing candidate executable paths for a CLI provider in strict priority order:
 * 1. User custom override path
 * 2. Provider-specific home path (`%USERPROFILE%\.gemini\bin\agy.exe` BEFORE `PATH`)
 * 3. Every `PATH` entry
 * 4. Common user/npm install directories
 */
export async function listCandidatePaths(providerId, {
  customPath = '',
  env = process.env,
  platform = process.platform,
  home = homedir(),
  checkFile = isRegularFile,
} = {}) {
  const rawCandidates = buildRawCandidateList(providerId, { customPath, env, home, platform });
  const seen = new Set();
  const existing = [];
  for (const candidate of rawCandidates) {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await checkFile(candidate)) existing.push(candidate);
  }
  return existing;
}
