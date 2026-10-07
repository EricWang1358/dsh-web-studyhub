import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* The fixed older release (a git tag) as a tree of files, for the rollback drills: the same on every platform, with nothing but git. `git archive | tar` does not work on a Windows machine whose
   `tar` is the system one (it cannot read the archive from a pipe the way GNU tar does), so the tree is made by git itself: the tag is read into a THROWAWAY index file and its files are written out
   with `checkout-index --prefix`. The repository's own index and working tree are never touched (no checkout, no worktree to remove afterwards). Returns the commit the tag names. */
export async function extractRelease(repo, tag, destination) {
  const git = (args, env = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }).trim();
  const sha = git(['rev-parse', `${tag}^{commit}`]);
  if (existsSync(join(destination, 'lib', 'service.js'))) return sha;
  await mkdir(destination, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'release-index-')), index = join(scratch, 'index');
  try {
    git(['read-tree', sha], { GIT_INDEX_FILE: index });
    git(['checkout-index', '--all', '--force', `--prefix=${destination.replaceAll('\\', '/').replace(/\/?$/, '/')}`], { GIT_INDEX_FILE: index });
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  if (!existsSync(join(destination, 'lib', 'service.js'))) throw new Error(`could not extract ${tag}`);
  return sha;
}
