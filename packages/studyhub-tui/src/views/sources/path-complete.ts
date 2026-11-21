import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

export interface PathCompletionResult {
  completed: string;
  matches: string[];
  directory: string;
  basePrefix: string;
  isExactFile: boolean;
}

export interface PathCompleteOptions {
  cwd?: string;
  home?: string;
  extensions?: readonly string[];
  maxMatches?: number;
  platform?: NodeJS.Platform;
}

const WIN_DRIVE_RE = /^[a-zA-Z]:(?:[\\/]|$)/;
const WIN_DRIVE_ONLY_RE = /^[a-zA-Z]:$/;

/** Expand leading `~` or `~/...` or `~\...` to the user's home directory. */
export function expandHomePath(
  rawPath: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = String(rawPath ?? '').trim();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    const rest = trimmed.slice(2);
    const trailing = trimmed.endsWith('/') || trimmed.endsWith('\\');
    const segments = rest.split(/[\\/]+/).filter(Boolean);
    const useWin = WIN_DRIVE_RE.test(home) || (!home.startsWith('/') && (platform === 'win32' || home.includes('\\')));
    const pathImpl = useWin ? path.win32 : path.posix;
    const joined = segments.length > 0 ? pathImpl.join(home, ...segments) : home;
    if (trailing && !joined.endsWith('/') && !joined.endsWith('\\')) {
      return `${joined}${useWin ? '\\' : '/'}`;
    }
    return joined;
  }
  return trimmed;
}

function preferredSeparator(raw: string, platform: NodeJS.Platform): string {
  if (raw.includes('\\') && !raw.includes('/')) return '\\';
  if (raw.includes('/') && !raw.includes('\\')) return '/';
  if (WIN_DRIVE_RE.test(raw)) return raw.includes('/') ? '/' : '\\';
  return platform === 'win32' ? '\\' : '/';
}

function splitDirAndPrefix(
  expanded: string,
  cwd: string,
  platform: NodeJS.Platform,
): { fsDir: string; prefix: string; displayDir: string; trailingSep: string } {
  const sep = preferredSeparator(expanded, platform);
  const useWin = WIN_DRIVE_RE.test(expanded) || (!expanded.startsWith('/') && (platform === 'win32' || expanded.includes('\\')));
  const pathImpl = useWin ? path.win32 : path.posix;

  if (!expanded) {
    return { fsDir: cwd, prefix: '', displayDir: '', trailingSep: sep };
  }

  // Bare Windows drive like `C:` -> treat as `C:\`
  if (WIN_DRIVE_ONLY_RE.test(expanded)) {
    const driveRoot = `${expanded}${sep}`;
    return { fsDir: driveRoot, prefix: '', displayDir: driveRoot, trailingSep: sep };
  }

  const endsWithSep = expanded.endsWith('/') || expanded.endsWith('\\');
  if (endsWithSep) {
    const resolved = pathImpl.isAbsolute(expanded) ? expanded : pathImpl.resolve(cwd, expanded);
    return { fsDir: resolved, prefix: '', displayDir: expanded, trailingSep: expanded.slice(-1) };
  }

  const lastFwd = expanded.lastIndexOf('/');
  const lastBack = expanded.lastIndexOf('\\');
  const lastSepIdx = Math.max(lastFwd, lastBack);
  if (lastSepIdx < 0) {
    return { fsDir: cwd, prefix: expanded, displayDir: '', trailingSep: sep };
  }

  const rawDir = expanded.slice(0, lastSepIdx + 1);
  const prefix = expanded.slice(lastSepIdx + 1);
  const resolved = pathImpl.isAbsolute(rawDir) ? rawDir : pathImpl.resolve(cwd, rawDir);
  return { fsDir: resolved, prefix, displayDir: rawDir, trailingSep: rawDir.slice(-1) || sep };
}

function longestCommonPrefix(values: readonly string[], caseInsensitive: boolean): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const item = values[i];
    let j = 0;
    const max = Math.min(prefix.length, item.length);
    while (j < max) {
      const a = caseInsensitive ? prefix[j].toLowerCase() : prefix[j];
      const b = caseInsensitive ? item[j].toLowerCase() : item[j];
      if (a !== b) break;
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * Cross-platform filesystem path completion (Linux bash + Windows PowerShell).
 * - Expands `~`, supports `/` and `\`, supports Windows drive letters `C:\...`.
 * - Never throws on missing or unreadable directories.
 */
export async function completeFsPath(
  partial: string,
  opts: PathCompleteOptions = {},
): Promise<PathCompletionResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const maxMatches = opts.maxMatches ?? 50;
  const raw = String(partial ?? '');
  const trimmed = raw.trimStart();
  const hadTilde = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\');
  const tildeSep = trimmed.startsWith('~\\') ? '\\' : '/';
  const expanded = expandHomePath(trimmed, home, platform);
  const sep = preferredSeparator(trimmed || cwd, platform);
  const caseInsensitive = platform === 'win32' || WIN_DRIVE_RE.test(expanded);
  const extFilter = opts.extensions?.length
    ? new Set(opts.extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)))
    : null;

  const emptyResult: PathCompletionResult = {
    completed: raw,
    matches: [],
    directory: cwd,
    basePrefix: '',
    isExactFile: false,
  };

  if (trimmed === '~') {
    const next = `~${sep}`;
    return { completed: next, matches: [next], directory: home, basePrefix: '', isExactFile: false };
  }

  const { fsDir, prefix, displayDir, trailingSep } = splitDirAndPrefix(expanded, cwd, platform);

  let entries;
  try {
    entries = await readdir(fsDir, { withFileTypes: true });
  } catch {
    return { ...emptyResult, directory: fsDir, basePrefix: prefix };
  }

  const showHidden = prefix.startsWith('.');
  const needle = caseInsensitive ? prefix.toLowerCase() : prefix;
  const candidates: Array<{ name: string; isDir: boolean }> = [];

  for (const entry of entries) {
    const name = entry.name;
    if (!showHidden && name.startsWith('.')) continue;
    const cmpName = caseInsensitive ? name.toLowerCase() : name;
    if (!cmpName.startsWith(needle)) continue;

    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        const st = await stat(path.join(fsDir, name));
        isDir = st.isDirectory();
      } catch {
        isDir = false;
      }
    }

    if (!isDir && extFilter) {
      const ext = path.extname(name).toLowerCase();
      if (!extFilter.has(ext)) continue;
    }

    candidates.push({ name, isDir });
  }

  candidates.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (candidates.length === 0) {
    return { completed: raw, matches: [], directory: fsDir, basePrefix: prefix, isExactFile: false };
  }

  // Reconstruct display prefix preserving `~/` if the user typed `~`.
  let shownBase = displayDir;
  if (hadTilde) {
    const relFromHome = path.relative(home, fsDir);
    if (!relFromHome || relFromHome === '.') {
      shownBase = `~${tildeSep}`;
    } else if (!relFromHome.startsWith('..')) {
      const normalizedRel = relFromHome.split(/[\\/]+/).join(tildeSep);
      shownBase = `~${tildeSep}${normalizedRel}${tildeSep}`;
    }
  }

  const limited = candidates.slice(0, maxMatches);
  const matches = limited.map((c) => `${shownBase}${c.name}${c.isDir ? trailingSep : ''}`);

  if (candidates.length === 1) {
    const only = candidates[0];
    const completed = `${shownBase}${only.name}${only.isDir ? trailingSep : ''}`;
    return {
      completed,
      matches,
      directory: fsDir,
      basePrefix: prefix,
      isExactFile: !only.isDir,
    };
  }

  const lcp = longestCommonPrefix(
    candidates.map((c) => c.name),
    caseInsensitive,
  );
  const completed = lcp.length >= prefix.length ? `${shownBase}${lcp}` : raw;

  return {
    completed,
    matches,
    directory: fsDir,
    basePrefix: prefix,
    isExactFile: false,
  };
}
