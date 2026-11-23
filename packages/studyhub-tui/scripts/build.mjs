import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');
const hashFile = resolve(outdir, '.build-hash');

const REQUIRED_OUTPUTS = ['cli.mjs', 'boot-frame.mjs', 'App.mjs', 'host.mjs'];

async function collectFiles(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export async function computeSourceHash() {
  const hash = createHash('sha256');
  const srcFiles = await collectFiles(resolve(root, 'src'));
  const extras = [resolve(root, 'package.json'), resolve(root, 'scripts/build.mjs')];
  const all = [...srcFiles, ...extras];
  for (const file of all) {
    hash.update(relative(root, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function ensureBuilt({ force = false, silent = false } = {}) {
  const t0 = performance.now();
  const digest = await computeSourceHash();

  if (
    !force &&
    existsSync(hashFile) &&
    REQUIRED_OUTPUTS.every((name) => existsSync(resolve(outdir, name)))
  ) {
    const prev = (await readFile(hashFile, 'utf8').catch(() => '')).trim();
    if (prev === digest) {
      const elapsed = Math.round(performance.now() - t0);
      if (!silent) {
        console.log(`Cached packages/studyhub-tui/dist/ is up to date (${elapsed}ms)`);
      }
      return { cached: true, elapsedMs: elapsed, digest };
    }
  }

  await rm(outdir, { recursive: true, force: true });

  await build({
    entryPoints: {
      cli: resolve(root, 'src/cli.tsx'),
      'boot-frame': resolve(root, 'src/shell/ShellBootFrame.tsx'),
      App: resolve(root, 'src/App.tsx'),
      host: resolve(root, 'src/host/index.ts'),
    },
    outdir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    jsx: 'automatic',
    sourcemap: false,
    minify: false,
    packages: 'external',
    external: [
      '../lib/*',
      '../../lib/*',
      '../../../lib/*',
      '../../../../lib/*',
      '../studyhub-desktop/*',
      '../../studyhub-desktop/*',
      '../../../studyhub-desktop/*',
    ],
    banner: {
      js: '// StudyHub TUI — bundled with esbuild (code-split for fast cold start & lean RSS)',
    },
  });

  await writeFile(hashFile, `${digest}\n`, 'utf8');
  const elapsed = Math.round(performance.now() - t0);
  if (!silent) {
    console.log(`Built packages/studyhub-tui/dist/ (code-split) in ${elapsed}ms`);
  }
  return { cached: false, elapsedMs: elapsed, digest };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const force = process.argv.includes('--force') || process.env.STUDYHUB_FORCE_BUILD === '1';
  await ensureBuilt({ force });
}
