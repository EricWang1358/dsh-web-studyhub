import { build } from 'esbuild';
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { englishOnDemand } from '../../../scripts/build.mjs';
import { shimJsxRuntime } from '../../../scripts/host-react.mjs';
import { uiBuildDefine } from '../../../scripts/ui-build-marker.mjs';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = resolve(desktopRoot, '../..');
const INLINE_ICON_DATA_URI =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#211f1b"/><path d="M18 14h28v38H18z" fill="#ede7db"/><path d="M18 14h5v38h-5z" fill="#bd6049"/><path d="M29 26h11M29 34h11M29 42h7" stroke="#211f1b" stroke-width="3"/></svg>'
  );

function buildIndexHtml(cssFiles, hasFaviconIco) {
  const cssLines = cssFiles.map((file) => `  <link rel="stylesheet" href="./${file}">`);
  const iconLine = hasFaviconIco
    ? '  <link rel="icon" href="./favicon.ico">'
    : `  <link rel="icon" type="image/svg+xml" href="${INLINE_ICON_DATA_URI}">`;
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <title>StudyHub</title>',
    iconLine,
    ...cssLines,
    '  <style>',
    '    html, body { margin: 0; padding: 0; height: 100%; }',
    '    body { background: #faf8f5; color: #1f1d1a; }',
    '    @media (prefers-color-scheme: dark) { body { background: #161412; color: #efe9df; } }',
    '    #root { height: 100%; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="root"></div>',
    '  <script type="module" src="./desktop.js"></script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function collectCssLinks(outputPaths, outdir) {
  const relCss = outputPaths
    .map((filePath) => relative(outdir, filePath).split(sep).join('/'))
    .filter((relPath) => relPath.endsWith('.css'));
  const chunkCss = relCss.filter((relPath) => relPath !== 'desktop.css').sort();
  return relCss.includes('desktop.css') ? [...chunkCss, 'desktop.css'] : chunkCss;
}

async function copyFaviconIfPresent(targetDir) {
  const srcIco = join(desktopRoot, 'src-tauri', 'icons', 'icon.ico');
  const exists = await access(srcIco).then(() => true, () => false);
  if (!exists) return null;
  const destIco = join(targetDir, 'favicon.ico');
  await copyFile(srcIco, destIco);
  return destIco;
}

export async function buildDesktopUi({
  outdir = join(desktopRoot, 'dist', 'ui'),
  production = true,
} = {}) {
  const targetDir = resolve(outdir);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  const version = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: { desktop: 'ui/desktop.jsx' },
    outdir: targetDir,
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    minify: production,
    metafile: true,
    nodePaths: [join(desktopRoot, 'node_modules'), join(repoRoot, 'node_modules')],
    plugins: [shimJsxRuntime, englishOnDemand],
    loader: {
      '.css': 'text',
      '.woff': 'file',
      '.woff2': 'file',
      '.ttf': 'file',
    },
    define: { ...uiBuildDefine(version), ...(production ? { 'process.env.NODE_ENV': '"production"' } : {}) },
    logLevel: 'silent',
  });

  const emitted = Object.keys(result.metafile.outputs).map((item) => resolve(repoRoot, item));
  const cssLinks = collectCssLinks(emitted, targetDir);
  const faviconPath = await copyFaviconIfPresent(targetDir);
  const indexPath = join(targetDir, 'index.html');
  await writeFile(indexPath, buildIndexHtml(cssLinks, Boolean(faviconPath)), 'utf8');

  const files = [...emitted, indexPath, ...(faviconPath ? [faviconPath] : [])];
  const summary = await Promise.all(
    files.map(async (filePath) => ({
      name: basename(filePath),
      relPath: relative(targetDir, filePath).split(sep).join('/'),
      bytes: (await stat(filePath)).size,
    }))
  );
  return summary.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outArg = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice(9);
  const production = !process.argv.includes('--dev');
  const files = await buildDesktopUi({
    ...(outArg ? { outdir: resolve(outArg) } : {}),
    production,
  });
  const totalBytes = files.reduce((sum, item) => sum + item.bytes, 0);
  console.log(
    `Built StudyHub Desktop UI: ${files.length} files, ${(totalBytes / 1048576).toFixed(2)} MiB`
  );
}
