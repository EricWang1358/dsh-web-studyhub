import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  assertUiBuildMarker,
  extractUiBuildMarkers,
  uiBuildDefine,
  uiBuildMarker,
  verifyPackedWorkbenchBundle,
} from '../scripts/ui-build-marker.mjs';
import { buildHostClient, buildPreview } from '../scripts/build.mjs';
import { buildDesktopUi } from '../packages/studyhub-desktop/scripts/build-ui.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkgVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const require = createRequire(import.meta.url);

function previousVersionOf(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return '0.0.0-old';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  return '0.0.0-old';
}

async function collectJsFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const full = join(entry.parentPath, entry.name);
    files.push({
      name: relative(dir, full).split(sep).join('/'),
      text: await readFile(full, 'utf8'),
    });
  }
  return files;
}

test('ts-fsrs false-positive regression (#1781): bare version literals without studyhub-ui@ marker fail', () => {
  const bundles = [
    { name: 'package/lib/client.js', text: 'window.__ModuleLoader__.load({factory:function(){}});' },
    { name: 'package/lib/client.fsrs-AAA.js', text: 'const version="5.4.2";const prefix="studyhub-ui@";' },
  ];
  assert.throws(
    () => assertUiBuildMarker(bundles, '5.4.2'),
    error => {
      assert.match(error.message, /studyhub-ui@5\.4\.2/);
      assert.match(error.message, /npm run build/);
      return true;
    },
  );
});

test('stale UI build marker fails reverse check against newer expected version (#1782)', () => {
  const bundles = [
    { name: 'package/lib/client.js', text: 'window.__ModuleLoader__.load({factory:function(){}});' },
    { name: 'package/lib/client.UpdateCenter-OLD.js', text: 'const m="studyhub-ui@5.4.1";' },
  ];
  assert.throws(
    () => assertUiBuildMarker(bundles, '5.4.2'),
    error => {
      assert.match(error.message, /studyhub-ui@5\.4\.2/);
      assert.match(error.message, /studyhub-ui@5\.4\.1/);
      assert.match(error.message, /client\.UpdateCenter-OLD\.js/);
      assert.match(error.message, /npm run build/);
      return true;
    },
  );
});

test('mixed fresh and stale leftover client chunks fail the marker check', () => {
  const bundles = [
    { name: 'package/lib/client.js', text: 'window.__ModuleLoader__.load({factory:function(){}});' },
    { name: 'package/lib/client.UpdateCenter-NEW.js', text: 'const m="studyhub-ui@5.4.2";' },
    { name: 'package/lib/client.UpdateCenter-OLD.js', text: 'const m="studyhub-ui@5.4.1";' },
  ];
  assert.throws(
    () => assertUiBuildMarker(bundles, '5.4.2'),
    error => {
      assert.match(error.message, /studyhub-ui@5\.4\.2/);
      assert.match(error.message, /studyhub-ui@5\.4\.1/);
      assert.match(error.message, /client\.UpdateCenter-OLD\.js/);
      return true;
    },
  );
});

test('marker matching enforces exact version boundaries and rejects prefix or prerelease look-alikes', () => {
  for (const lookalike of ['"studyhub-ui@5.4.20"', '"studyhub-ui@5.4.2-rc.1"', '"other-studyhub-ui@5.4.2"']) {
    assert.throws(
      () => assertUiBuildMarker([{ name: 'package/lib/client.chunk-1.js', text: `const m=${lookalike};` }], '5.4.2'),
      /studyhub-ui@5\.4\.2/,
      `${lookalike} must not satisfy 5.4.2`,
    );
  }
  const ok = assertUiBuildMarker([
    { name: 'package/lib/client.js', text: 'const version="5.4.2";' },
    { name: 'package/lib/client.UpdateCenter-1.js', text: 'const p="studyhub-ui@",m="studyhub-ui@5.4.2";' },
  ], '5.4.2');
  assert.equal(ok.expected, 'studyhub-ui@5.4.2');
  assert.deepEqual(ok.matchedFiles, ['package/lib/client.UpdateCenter-1.js']);
  assert.equal(ok.checkedFiles, 2);
});

test('verifyPackedWorkbenchBundle checks unpacked package/lib/client*.js files and rejects missing or stale chunks', async t => {
  const unpacked = await mkdtemp(join(tmpdir(), 'studyhub-release-check-'));
  t.after(() => rm(unpacked, { recursive: true, force: true }));
  const pkgRoot = join(unpacked, 'package');
  await mkdir(join(pkgRoot, 'lib'), { recursive: true });
  await writeFile(join(pkgRoot, 'lib', 'index.js'), 'export const version = "5.4.2";\n');
  await writeFile(join(pkgRoot, 'lib', 'client.js'), 'window.__ModuleLoader__.load({});\n');
  await writeFile(join(pkgRoot, 'lib', 'client.UpdateCenter-NEW.js'), 'const m="studyhub-ui@5.4.2";\n');

  const files = ['package/package.json', 'package/lib/index.js', 'package/lib/client.js', 'package/lib/client.UpdateCenter-NEW.js'];
  const passed = await verifyPackedWorkbenchBundle(pkgRoot, files, '5.4.2');
  assert.equal(passed.expected, 'studyhub-ui@5.4.2');
  assert.deepEqual(passed.matchedFiles, ['package/lib/client.UpdateCenter-NEW.js']);

  // Missing client.js fails
  await assert.rejects(
    () => verifyPackedWorkbenchBundle(pkgRoot, ['package/package.json', 'package/lib/client.UpdateCenter-NEW.js'], '5.4.2'),
    /client\.js/,
  );

  // Reverse check against stale version fails
  await assert.rejects(
    () => verifyPackedWorkbenchBundle(pkgRoot, files, '5.4.1'),
    /studyhub-ui@5\.4\.1[\s\S]*studyhub-ui@5\.4\.2/,
  );

  // Adding a leftover stale chunk fails even when the fresh chunk is present
  await writeFile(join(pkgRoot, 'lib', 'client.UpdateCenter-OLD.js'), 'const m="studyhub-ui@5.4.1";\n');
  await assert.rejects(
    () => verifyPackedWorkbenchBundle(pkgRoot, [...files, 'package/lib/client.UpdateCenter-OLD.js'], '5.4.2'),
    /studyhub-ui@5\.4\.1/,
  );
});

test('real host client build embeds dedicated UI marker and fails reverse check against stale versions', async () => {
  const result = await buildHostClient({ write: false });
  const bundles = result.outputFiles.map(file => ({ name: basename(file.path), text: file.text }));

  const verified = assertUiBuildMarker(bundles, pkgVersion);
  assert.equal(verified.expected, uiBuildMarker(pkgVersion));
  assert.ok(verified.matchedFiles.length >= 1, 'at least one emitted client chunk carries the dedicated UI marker');

  const foundMarkers = new Set(bundles.flatMap(bundle => extractUiBuildMarkers(bundle.text)));
  assert.deepEqual([...foundMarkers], [uiBuildMarker(pkgVersion)]);

  for (const staleVersion of ['0.0.0-old', previousVersionOf(pkgVersion)]) {
    assert.throws(
      () => assertUiBuildMarker(bundles, staleVersion),
      error => {
        assert.match(error.message, new RegExp(uiBuildMarker(staleVersion).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, new RegExp(uiBuildMarker(pkgVersion).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
      `real host client build must fail reverse check for stale version ${staleVersion}`,
    );
  }
});

test('standalone preview and desktop UI builds embed the same dedicated UI build marker', async t => {
  const preview = await buildPreview({ write: false });
  const previewJs = preview.outputFiles
    .filter(file => basename(file.path).endsWith('.js'))
    .map(file => ({ name: basename(file.path), text: file.text }));
  assert.equal(assertUiBuildMarker(previewJs, pkgVersion).expected, uiBuildMarker(pkgVersion));
  assert.throws(() => assertUiBuildMarker(previewJs, '0.0.0-old'), /studyhub-ui@0\.0\.0-old/);

  const desktopOut = await mkdtemp(join(tmpdir(), 'studyhub-desktop-ui-marker-'));
  t.after(() => rm(desktopOut, { recursive: true, force: true }));
  await buildDesktopUi({ outdir: desktopOut, production: true });
  const desktopJs = await collectJsFiles(desktopOut);
  assert.equal(assertUiBuildMarker(desktopJs, pkgVersion).expected, uiBuildMarker(pkgVersion));
  assert.throws(() => assertUiBuildMarker(desktopJs, '0.0.0-old'), /studyhub-ui@0\.0\.0-old/);
});

test('ui/UpdateCenter.jsx derives UI_BUILD_MARKER and UI_BUILD_VERSION in both fallback imports and esbuild define builds', async () => {
  // 1) Raw loadUi import without __STUDYHUB_UI_BUILD__ defined falls back cleanly to package.json version.
  const fallbackUi = await loadUi("export { UI_BUILD_MARKER, UI_BUILD_VERSION, announceUpgrade } from './ui/UpdateCenter.jsx';");
  assert.equal(fallbackUi.UI_BUILD_MARKER, uiBuildMarker(pkgVersion));
  assert.equal(fallbackUi.UI_BUILD_VERSION, pkgVersion);

  // 2) Built with esbuild define injecting __STUDYHUB_UI_BUILD__ uses the injected marker as the source of UI_BUILD_VERSION.
  const injectedVersion = '9.8.7';
  const compiled = await build({
    stdin: {
      contents: "export { UI_BUILD_MARKER, UI_BUILD_VERSION, announceUpgrade } from './ui/UpdateCenter.jsx';",
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom', 'react/*', 'react-dom/*', '@base-ui/*', '@codemirror/*', '@lezer/*', 'markdown-it', 'markdown-it-texmath', 'dompurify', 'katex', 'katex/*'],
    plugins: [nativeSelects],
    loader: { '.css': 'text' },
    define: uiBuildDefine(injectedVersion),
    logLevel: 'silent',
  });
  const code = compiled.outputFiles[0].text;
  assert.equal(assertUiBuildMarker([{ name: 'UpdateCenter.cjs', text: code }], injectedVersion).expected, `studyhub-ui@${injectedVersion}`);
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
  assert.equal(mod.exports.UI_BUILD_MARKER, `studyhub-ui@${injectedVersion}`);
  assert.equal(mod.exports.UI_BUILD_VERSION, injectedVersion);

  const shown = [];
  const toast = { success: message => shown.push(message) };
  const call = async () => ({});
  await mod.exports.announceUpgrade({ upgraded: pkgVersion }, { call, toast, said: new Set() });
  assert.deepEqual(shown, [], 'injected build does not announce a different version');
  await mod.exports.announceUpgrade({ upgraded: injectedVersion }, { call, toast, said: new Set() });
  assert.deepEqual(shown, [`已升级到 ${injectedVersion}`]);
});
