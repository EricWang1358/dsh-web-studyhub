#!/usr/bin/env node
/* `prepare`: runs after an install from a git checkout (`pnpm add github:owner/repo`, `npm install github:owner/repo`, the DSH plugin market's one-click
   install) and after a plain `npm install` in a fresh clone.

   The plugin's client bundle (lib/client.js and its chunks) is build output and is not committed, so a package taken straight from GitHub has no UI.
   Build it here, once: when the bundle is already there (a release package, an earlier build) nothing happens. If the build cannot run, say why and
   fail, so the installer reports an error instead of leaving a plugin that loads without its interface. STUDYHUB_SKIP_PREPARE=1 skips it. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const built = () => existsSync(new URL('../lib/client.js', import.meta.url));

if (process.env.STUDYHUB_SKIP_PREPARE === '1' || built()) process.exit(0);

console.log('studyhub: building the client bundle (lib/client.js is build output)…');
const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0 || !built()) {
  console.error('studyhub: the client bundle could not be built. Install the release package instead (see docs/install.md), or run `npm ci && npm run build` in a clone.');
  process.exit(result.status || 1);
}
