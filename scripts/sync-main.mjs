#!/usr/bin/env node
/* Bring a checkout up to the newest `main` and build it: the "experience channel" of StudyHub.

   The web DSH profile links to a checkout of this repository (see docs/release-policy.md). Keep that checkout on its own worktree that only follows `main`:
       git worktree add --detach <dir> origin/main        (once)
       node scripts/sync-main.mjs                         (whenever main moved; run inside <dir>)
   then reload the plugin (or restart DSH web). The desktop app keeps the released version.

   What it does: fetch origin, refuse to touch a checkout with uncommitted work (unless --force), detach at origin/main, reinstall dependencies only when
   package.json / package-lock.json changed (or node_modules is missing), build, and say which version and commit is now there.
   Flags: --ref=<ref> follow another ref (default origin/main), --force ignore uncommitted changes (they stay; only the checkout moves when git allows it),
   --no-build stop after the checkout. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const flags = new Map(process.argv.slice(2).map((arg) => { const [key, value = 'true'] = arg.replace(/^--/, '').split('='); return [key, value]; }));
const ref = flags.get('ref') || 'origin/main';
const windows = process.platform === 'win32';

function run(command, args, { quiet = false, allowFail = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: windows && command === 'npm', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0 && !allowFail) {
    console.error(`sync-main: \`${command} ${args.join(' ')}\` failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    process.exit(result.status || 1);
  }
  return quiet ? (result.stdout || '').trim() : '';
}
const git = (...args) => run('git', args, { quiet: true });

const inside = run('git', ['rev-parse', '--is-inside-work-tree'], { quiet: true, allowFail: true });
if (inside !== 'true') { console.error(`sync-main: ${root} is not a git checkout.`); process.exit(1); }

if (git('status', '--porcelain') && !flags.has('force')) {
  console.error('sync-main: this checkout has uncommitted changes, so it is not a clean "follow main" checkout. Use a dedicated worktree:\n'
    + '  git worktree add --detach <dir> origin/main\nor pass --force to move anyway.');
  process.exit(2);
}

const before = git('rev-parse', 'HEAD');
console.log(`sync-main: fetching origin…`);
run('git', ['fetch', '--quiet', 'origin']);
run('git', ['checkout', '--quiet', '--detach', ref]);
const after = git('rev-parse', 'HEAD');

const changed = before !== after ? git('diff', '--name-only', before, after).split('\n') : [];
const needInstall = !existsSync(join(root, 'node_modules')) || changed.some((file) => file === 'package.json' || file === 'package-lock.json');
if (needInstall) { console.log('sync-main: dependencies changed, installing…'); run('npm', ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund']); }
if (!flags.has('no-build')) { console.log('sync-main: building…'); run('node', ['scripts/build.mjs']); }

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const subject = git('log', '-1', '--format=%s');
const count = before !== after ? git('rev-list', '--count', `${before}..${after}`) : '0';
console.log(`\nsync-main: StudyHub ${version} @ ${after.slice(0, 7)} (${ref}) — ${subject}`);
console.log(count === '0' ? 'sync-main: already up to date.' : `sync-main: ${count} new commit${count === '1' ? '' : 's'} since ${before.slice(0, 7)}.`);
console.log('Reload the plugin in DSH (or restart DSH web) to pick it up.');
