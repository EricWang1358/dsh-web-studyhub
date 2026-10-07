/* The rollback drills get the fixed older release as a tree of files from git alone (tests/fixtures/extract-release.mjs), the same on every platform, with no system `tar`. A throwaway repository
   with a tag stands in for v2.7.1: nested folders, a file with CRLF line ends and a binary one come out byte for byte, the repository's own index and working tree are untouched, and a second call
   finds the tree there and does nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractRelease } from './fixtures/extract-release.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();

test('the tag is written out byte for byte, without touching the repository and without a system tar', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'extract-repo-')), out = join(await mkdtemp(join(tmpdir(), 'extract-out-')), 'old');
  t.after(async () => { await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); await rm(join(out, '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  git(repo, 'init', '-q');
  await mkdir(join(repo, 'lib', 'deep'), { recursive: true });
  const bytes = Buffer.from([0, 255, 10, 13, 10, 1, 2, 3]);
  await writeFile(join(repo, 'lib', 'service.js'), 'export const v = 1;\r\nexport const w = 2;\r\n');
  await writeFile(join(repo, 'lib', 'deep', 'name with space.bin'), bytes);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'release'); git(repo, 'tag', 'v0.0.1');
  await writeFile(join(repo, 'lib', 'service.js'), 'export const v = 2;\n'); // the working tree has moved on after the tag
  const statusBefore = git(repo, 'status', '--porcelain');
  const sha = await extractRelease(repo, 'v0.0.1', out);
  assert.equal(sha, git(repo, 'rev-parse', 'v0.0.1^{commit}'));
  assert.equal(await readFile(join(out, 'lib', 'service.js'), 'utf8'), 'export const v = 1;\r\nexport const w = 2;\r\n', 'the file of the tag, CRLF kept');
  assert.deepEqual(await readFile(join(out, 'lib', 'deep', 'name with space.bin')), bytes);
  assert.equal(git(repo, 'status', '--porcelain'), statusBefore, 'the repository is exactly as it was');
  await writeFile(join(out, 'lib', 'service.js'), 'kept');
  assert.equal(await extractRelease(repo, 'v0.0.1', out), sha);
  assert.equal(await readFile(join(out, 'lib', 'service.js'), 'utf8'), 'kept', 'a tree that is already there is left alone');
  await assert.rejects(extractRelease(repo, 'v9.9.9', join(out, '..', 'other')));
});
