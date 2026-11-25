import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const srcDir = path.join(pkgRoot, 'src');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-p2a-layout-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: [
      `export * from './src/components/layout-tokens.ts';`,
      `export * from './src/shell/global-keymap.ts';`,
      `export { resolveShellFooterHints } from './src/components/focus.ts';`,
      `export { globalShortcuts } from './src/shell/HelpOverlay.tsx';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
const Bundle = await import(pathToFileURL(outfile).href);
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

test('P2-a guardrail: layout-tokens.ts centralizes breakpoints, chrome constants, and filter/modal helpers', () => {
  assert.equal(Bundle.LAYOUT_BP.SIDENAV_AUTO_COLLAPSE, 100);
  assert.equal(Bundle.LAYOUT_BP.SPLIT_DEFAULT, 86);
  assert.equal(Bundle.LAYOUT_BP.FILTER_FULL, 66);
  assert.equal(Bundle.LAYOUT_BP.FILTER_SHORT, 46);
  assert.equal(Bundle.LAYOUT_CHROME.SIDENAV_EXPANDED, 24);
  assert.equal(Bundle.LAYOUT_CHROME.SIDENAV_COLLAPSED, 6);
  assert.equal(Bundle.LAYOUT_CHROME.MODAL_CHROME_X, 6);
  assert.equal(Bundle.LAYOUT_CHROME.PROSE_MAX_COLS, 96);

  const wideFilter = Bundle.computeFilterBarLayout(90, '[Filter 3/10] ', 'en', true);
  assert.match(wideFilter.rightHint, /Enter apply/);
  assert.ok(wideFilter.inputWidth >= 8);

  const midFilter = Bundle.computeFilterBarLayout(52, '[Filter 3/10] ', 'en', false);
  assert.equal(midFilter.rightHint, ' Esc');

  const tinyFilter = Bundle.computeFilterBarLayout(40, '[Filter 3/10] ', 'en', false);
  assert.equal(tinyFilter.rightHint, '');

  const modal = Bundle.clampModalFrame(80, 24, { maxWidth: 88, minWidth: 48, maxHeight: 30, minHeight: 15 });
  assert.equal(modal.frameWidth, 76);
  assert.equal(modal.frameHeight, 22);
  assert.equal(modal.innerWidth, 70);
});

test('P2-a guardrail: core layout primitives import layout-tokens.ts and views do not duplicate filter-bar or sidenav math', () => {
  const coreConsumers = [
    'components/Layout.tsx',
    'components/Modal.tsx',
    'components/SplitPane.tsx',
    'shell/SideNav.tsx',
    'shell/AppShell.tsx',
  ];
  for (const rel of coreConsumers) {
    const src = fs.readFileSync(path.join(srcDir, rel), 'utf8');
    assert.match(src, /layout-tokens\.js/, `${rel} must import centralized layout constants from layout-tokens.js`);
  }

  const dupFilterHits = [];
  const dupSideNavHits = [];
  for (const file of walkFiles(path.join(srcDir, 'views'))) {
    const rel = path.relative(srcDir, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');
    if (/width\s*>=\s*66[\s\S]{0,160}width\s*>=\s*46/.test(src)) {
      dupFilterHits.push(rel);
    }
    if (/columns\s*<\s*100\s*\?\s*6\s*:\s*2[24]/.test(src)) {
      dupSideNavHits.push(rel);
    }
  }
  assert.deepEqual(dupFilterHits, [], 'Views must use computeFilterBarLayout() instead of duplicating width >= 66 / >= 46 filter math');
  assert.deepEqual(dupSideNavHits, [], 'Views must use sideNavWidth() / layout-tokens instead of hardcoding sidebar collapse widths');
});

test('P2-a guardrail: footer default hints and HelpOverlay globalShortcuts derive from one global-keymap.ts source', () => {
  assert.ok(Array.isArray(Bundle.GLOBAL_KEYMAP_ENTRIES) && Bundle.GLOBAL_KEYMAP_ENTRIES.length >= 12);

  for (const lang of ['zh', 'en']) {
    const footerDefaults = Bundle.resolveShellFooterHints({
      modalHints: null,
      footerHints: [],
      inputCaptured: false,
      overlayOpen: false,
      compactMode: false,
      practiceReturnLabel: null,
      lang,
    });
    const helpGlobals = Bundle.globalShortcuts(lang, false);
    const helpKeyText = helpGlobals.map((h) => h.key).join(' | ');

    for (const fh of footerDefaults) {
      const token = fh.key.split(/\s+/)[0];
      assert.ok(
        helpKeyText.includes(token),
        `Footer hint "${fh.key}" (${lang}) missing from HelpOverlay globalShortcuts: ${helpKeyText}`,
      );
    }
  }

  const focusSrc = fs.readFileSync(path.join(srcDir, 'components/focus.ts'), 'utf8');
  const helpSrc = fs.readFileSync(path.join(srcDir, 'shell/HelpOverlay.tsx'), 'utf8');
  assert.match(focusSrc, /global-keymap\.js/, 'focus.ts must build footer hints from global-keymap.js');
  assert.match(helpSrc, /global-keymap\.js/, 'HelpOverlay.tsx must build globalShortcuts from global-keymap.js');
});
