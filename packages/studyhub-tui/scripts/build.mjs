import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');

await rm(outdir, { recursive: true, force: true });

const t0 = performance.now();
await build({
  entryPoints: {
    cli: resolve(root, 'src/cli.tsx'),
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
const elapsed = Math.round(performance.now() - t0);
console.log(`Built packages/studyhub-tui/dist/ (code-split) in ${elapsed}ms`);
