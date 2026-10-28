/* Build the StudyHub panel for ZCode (npm run build:zcode). Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   ZCode caps one MCP resource read at 8 MiB, so the app (ui/zcode.jsx) is an ESM bundle with code splitting, served one
   chunk per ui:// resource by packages/studyhub-zcode/host/entry.mjs:
     app.js           the entry chunk
     chunk-*.js       the lazy views and shared code
     app.css (+ chunk css)
     manifest.json    { entry, css[], chunks[] } for the shell loader
     panel.html       a small shell with the ext-apps loader inlined (packages/studyhub-zcode/ui-port/shell-loader.js) and
                      the panel nonce's placeholder, which the server replaces with its own nonce when it serves the page
   esbuild names sibling chunks with relative specifiers ('./chunk-X.js'), which cannot resolve from blob: URLs; they are
   rewritten to bare names, which the loader's import map maps to blob URLs.

   --test also writes panel.test.html, whose loader talks plain HTTP (ui-port/test-app-stub.mjs) to
   packages/studyhub-zcode/scripts/test-panel-server.mjs, so a real browser can run this production bundle.
   --outdir=<dir> writes elsewhere (default packages/studyhub-zcode/dist/ui, git-ignored). */
import { build } from 'esbuild';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shimJsxRuntime } from './host-react.mjs';
import { NONCE_META, NONCE_PLACEHOLDER } from '../packages/studyhub-zcode/host/panel-nonce.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = join(root, 'packages', 'studyhub-zcode');
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const CHUNK = /^(chunk-[A-Za-z0-9_-]+\.js)$/;

const panelHtml = (loader) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StudyHub</title>
<meta name="${NONCE_META}" content="${NONCE_PLACEHOLDER}">
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { background: #161412; }
  #root { height: 100%; }
  #studyhub-boot { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center;
    color: #efe9df; font: 14px/1.6 system-ui, sans-serif; opacity: .85; }
</style>
<script>${loader.replaceAll('</script', '<\\/script')}</script>
</head>
<body>
<div id="studyhub-boot">正在打开学习工作区… / Opening StudyHub…</div>
<div id="root"></div>
</body>
</html>
`;

async function shellLoader({ test, version }) {
  const here = join(pluginRoot, 'ui-port');
  const result = await build({
    absWorkingDir: root, entryPoints: [join(here, 'shell-loader.js')], bundle: true, write: false, platform: 'browser',
    format: 'iife', minify: true, logLevel: 'silent', define: { STUDYHUB_VERSION: JSON.stringify(version) },
    ...(test ? { alias: { '@modelcontextprotocol/ext-apps/app-with-deps': join(here, 'test-app-stub.mjs') } } : {}),
  });
  return result.outputFiles[0].text;
}

/** Build into `outdir`; answers [{ name, bytes }]. Throws when any resource would be over ZCode's 8 MiB. */
export async function buildZcodePanel({ outdir = join(pluginRoot, 'dist', 'ui'), test = false } = {}) {
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  // A clean folder every build: chunk hashes change, and stale chunks would still be served as resources.
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const app = await build({
    absWorkingDir: root, entryPoints: [join(root, 'ui', 'zcode.jsx')], plugins: [shimJsxRuntime], bundle: true, write: false,
    outdir, entryNames: 'app', chunkNames: 'chunk-[hash]', platform: 'browser', format: 'esm', splitting: true,
    loader: { '.css': 'css' }, minify: true, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const written = [];
  for (const file of app.outputFiles) {
    const name = basename(file.path);
    const text = name.endsWith('.js')
      ? file.text.replace(/(["'])\.\/(chunk-[A-Za-z0-9_-]+\.js)\1/g, (_match, quote, chunk) => `${quote}${chunk}${quote}`) : file.text;
    await writeFile(join(outdir, name), text, 'utf8');
    written.push(name);
  }
  // Chunk CSS first, so the entry sheet (the cascade order ui/dev.jsx relies on) wins ties.
  const css = [...written.filter((name) => name.endsWith('.css') && name !== 'app.css'), ...(written.includes('app.css') ? ['app.css'] : [])];
  const manifest = { entry: 'app.js', css, chunks: written.filter((name) => CHUNK.test(name)).sort() };
  await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`, 'utf8');
  await writeFile(join(outdir, 'panel.html'), panelHtml(await shellLoader({ test: false, version })), 'utf8');
  written.push('manifest.json', 'panel.html');
  if (test) {
    await writeFile(join(outdir, 'panel.test.html'), panelHtml(await shellLoader({ test: true, version })), 'utf8');
    written.push('panel.test.html');
  }
  const sizes = [];
  for (const name of written.sort()) sizes.push({ name, bytes: (await stat(join(outdir, name))).size });
  const over = sizes.filter((item) => item.bytes > MAX_RESOURCE_BYTES);
  if (over.length) throw new Error(`ZCode reads at most 8 MiB per resource: ${over.map((item) => `${item.name} ${item.bytes}`).join(', ')}`);
  return sizes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outdir = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice(9);
  const sizes = await buildZcodePanel({ ...(outdir ? { outdir: resolve(outdir) } : {}), test: process.argv.includes('--test') });
  const total = sizes.reduce((sum, item) => sum + item.bytes, 0), largest = sizes.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  console.log(`Built the ZCode panel: ${sizes.length} files, ${(total / 1048576).toFixed(2)} MiB, largest ${largest.name} ${(largest.bytes / 1048576).toFixed(2)} MiB`);
}
