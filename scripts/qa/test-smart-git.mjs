/* Git diff scope discovery for `scripts/qa/run-tests.mjs --smart` / `--changed`.
   Kept separate from `test-smart.mjs` so fast unit tests can test the pure dependency selector without importing `node:child_process`. */
import { execFileSync } from 'node:child_process';
import { repoRoot } from './test-schedule.mjs';

function runGit(args, cwd = repoRoot) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/**
 * Resolve changed repository-relative file paths for `--smart` / `--changed`:
 * 1. If `since` is explicitly supplied (`--since=v4.9.2` or `--since=HEAD~3`), diffs `since...HEAD` + working-tree changes.
 * 2. Otherwise:
 *    - Always includes uncommitted staged, unstaged, and untracked files (`git status --porcelain`).
 *    - If working tree is clean (or has commits ahead of base), compares against `origin/main` when ahead,
 *      else against the previous `v*` release tag (`HEAD^` when `HEAD` itself carries a `v*` tag, else `HEAD`).
 */
export function detectChangedPaths({ root = repoRoot, since = '' } = {}) {
  const paths = new Set();

  // Working-tree modified / staged / untracked files
  const statusOut = execFileSyncFallback(['status', '--porcelain=v1', '-uall'], root);
  for (const rawLine of statusOut.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const body = rawLine.slice(3).trim();
    const arrow = body.indexOf(' -> ');
    const target = (arrow >= 0 ? body.slice(arrow + 4) : body).replace(/^"(.*)"$/, '$1');
    if (target) paths.add(target.replaceAll('\\', '/'));
  }

  let baseRef = since.trim();
  if (!baseRef) {
    // If working tree already has uncommitted edits, also union commits ahead of origin/main if on a feature branch
    const aheadOrigin = runGit(['rev-list', '--count', 'origin/main..HEAD'], root);
    if (Number(aheadOrigin) > 0) {
      baseRef = 'origin/main';
    } else if (paths.size === 0) {
      // Clean working tree on main: diff against the preceding release tag (so running right before or right after tagging tests that release's changes)
      const headTags = splitLines(runGit(['tag', '--points-at', 'HEAD', 'v*'], root));
      const searchFrom = headTags.length > 0 ? 'HEAD^' : 'HEAD';
      baseRef = runGit(['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', searchFrom], root) || 'HEAD~1';
    }
  }

  if (baseRef) {
    for (const file of splitLines(runGit(['diff', '--name-only', `${baseRef}...HEAD`], root))) {
      paths.add(file.replaceAll('\\', '/'));
    }
    for (const file of splitLines(runGit(['diff', '--name-only', baseRef], root))) {
      paths.add(file.replaceAll('\\', '/'));
    }
  }

  return { baseRef: baseRef || 'working-tree', changedPaths: [...paths].sort() };
}

function execFileSyncFallback(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}
