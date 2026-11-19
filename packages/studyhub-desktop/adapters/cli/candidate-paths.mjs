import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/* Paths are built for the platform asked about, not the one this code runs on: a Windows candidate keeps its backslashes on any machine. */
const pathFor = (platform) => (platform === 'win32' ? win32 : posix);

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
    return [`${providerId}.exe`, `${providerId}.cmd`, `${providerId}.bat`];
  }
  return [providerId];
}

function explicitHomeCandidates(providerId, home, platform) {
  const { join } = pathFor(platform);
  if (providerId === 'agy') {
    return platform === 'win32'
      ? [join(home, '.gemini', 'bin', 'agy.exe'), join(home, '.gemini', 'antigravity', 'bin', 'agy.exe')]
      : [join(home, '.gemini', 'bin', 'agy'), join(home, '.gemini', 'antigravity', 'bin', 'agy')];
  }
  return [];
}

function npmPrefixDir(env) {
  const raw = env.npm_config_prefix || env.NPM_CONFIG_PREFIX || '';
  return typeof raw === 'string' ? raw.trim() : '';
}

function extraInstallDirs(env, home, platform) {
  const { join } = pathFor(platform);
  const npmPrefix = npmPrefixDir(env);
  if (platform === 'win32') {
    const dirs = [];
    if (npmPrefix) dirs.push(npmPrefix);
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
    dirs.push(join(home, '.local', 'bin'));
    return dirs;
  }
  const dirs = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  if (npmPrefix) dirs.unshift(join(npmPrefix, 'bin'));
  return dirs;
}

function pathEntries(env, platform) {
  const raw = env.PATH || env.Path || '';
  const sep = pathFor(platform).delimiter;
  return raw.split(sep).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function buildRawCandidateList(providerId, { customPath, env, home, platform }) {
  const { join, resolve } = pathFor(platform);
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
