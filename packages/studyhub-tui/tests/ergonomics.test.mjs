// Keyboard ergonomics & help parity unit tests: `node --test tests/ergonomics.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-ergonomics-'));
const outfile = path.join(outDir, 'bundle.mjs');

await build({
  stdin: {
    contents: [
      `export { pageStep, nextScrollOffset, scrollbarThumb } from './src/components/VirtualList.tsx';`,
      `export { pageStep as scrollViewPageStep } from './src/components/ScrollView.tsx';`,
      `export { globalShortcuts, featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
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
const M = await import(pathToFileURL(outfile).href);
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

test('pageStep computes exact half and full page steps with minimum 1', () => {
  assert.equal(M.pageStep(0, 'half'), 1);
  assert.equal(M.pageStep(1, 'half'), 1);
  assert.equal(M.pageStep(2, 'half'), 1);
  assert.equal(M.pageStep(10, 'half'), 5);
  assert.equal(M.pageStep(11, 'half'), 5);
  assert.equal(M.pageStep(25, 'half'), 12);

  assert.equal(M.pageStep(0, 'full'), 1);
  assert.equal(M.pageStep(1, 'full'), 1);
  assert.equal(M.pageStep(2, 'full'), 1);
  assert.equal(M.pageStep(10, 'full'), 9);
  assert.equal(M.pageStep(24, 'full'), 23);

  assert.equal(M.pageStep(Number.NaN, 'half'), 1);
  assert.equal(M.scrollViewPageStep(16, 'half'), 8);
  assert.equal(M.scrollViewPageStep(16, 'full'), 15);
});

test('nextScrollOffset keeps cursor visible with padding and clamps to bounds', () => {
  assert.equal(M.nextScrollOffset(0, 0, 10, 5), 0);
  assert.equal(M.nextScrollOffset(4, 0, 10, 5), 0);

  assert.equal(M.nextScrollOffset(0, 0, 10, 30), 0);
  assert.equal(M.nextScrollOffset(8, 0, 10, 30), 0);
  assert.equal(M.nextScrollOffset(9, 0, 10, 30), 1);
  assert.equal(M.nextScrollOffset(29, 10, 10, 30), 20);
  assert.equal(M.nextScrollOffset(0, 20, 10, 30), 0);

  // Half-page jump down from cursor 0 in a 10-row viewport of 30 items
  const halfDown = 0 + M.pageStep(10, 'half');
  assert.equal(halfDown, 5);
  assert.equal(M.nextScrollOffset(halfDown, 0, 10, 30), 0);

  // Full-page jump down to cursor 9 pushes viewport down by 1
  const fullDown = 0 + M.pageStep(10, 'full');
  assert.equal(fullDown, 9);
  assert.equal(M.nextScrollOffset(fullDown, 0, 10, 30), 1);
});

test('scrollbarThumb computes accurate thumb segments and empty track when unscrollable', () => {
  assert.deepEqual(M.scrollbarThumb(5, 10, 0), new Array(10).fill(false));
  assert.deepEqual(M.scrollbarThumb(10, 10, 0), new Array(10).fill(false));
  assert.deepEqual(M.scrollbarThumb(10, 0, 0), []);

  const topThumb = M.scrollbarThumb(40, 10, 0);
  assert.equal(topThumb.length, 10);
  assert.equal(topThumb[0], true);
  assert.equal(topThumb[9], false);
  assert.ok(topThumb.filter(Boolean).length >= 1);

  const botThumb = M.scrollbarThumb(40, 10, 30);
  assert.equal(botThumb.length, 10);
  assert.equal(botThumb[0], false);
  assert.equal(botThumb[9], true);
});

test('globalShortcuts documents required keys cleanly in zh and en without duplicates', () => {
  for (const lang of ['zh', 'en']) {
    for (const ascii of [false, true]) {
      const list = M.globalShortcuts(lang, ascii);
      assert.ok(Array.isArray(list) && list.length >= 12);
      const keys = list.map((h) => h.key);
      assert.equal(new Set(keys).size, keys.length, `duplicate key in globalShortcuts (${lang}, ascii=${ascii})`);
      const keysJoined = keys.join('\n');
      for (const expected of ['I', 'Ctrl+K', '?', 'c', '[', '\\', 'Ctrl+R', 'Ctrl+D/U', 'g/G']) {
        assert.ok(keysJoined.includes(expected), `missing ${expected} in ${lang} (ascii=${ascii})`);
      }
      for (const item of list) {
        assert.ok(item.key.trim().length > 0);
        assert.ok(item.label.trim().length > 0);
        if (ascii) {
          assert.match(item.key, /^[\x20-\x7e]+$/, `non-ASCII key in asciiMode: ${item.key}`);
        }
      }
    }
  }
});

test('featureShortcuts documents Rounds 5-9 shortcuts cleanly in zh and en without duplicates', () => {
  for (const lang of ['zh', 'en']) {
    const sections = M.featureShortcuts(lang);
    assert.equal(sections.length, 5);
    const titles = sections.map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length, `duplicate section title in ${lang}`);
    for (const sec of sections) {
      assert.ok(sec.title.trim().length > 0, `empty section title in ${lang}`);
      assert.ok(sec.items.length > 0, `empty section items for ${sec.title} in ${lang}`);
      const secKeys = sec.items.map((i) => i.key);
      const secLabels = sec.items.map((i) => i.label);
      assert.equal(new Set(secKeys).size, secKeys.length, `duplicate shortcut key in ${sec.title} (${lang})`);
      assert.equal(new Set(secLabels).size, secLabels.length, `duplicate shortcut label in ${sec.title} (${lang})`);
      for (const item of sec.items) {
        assert.ok(item.key.trim().length > 0, `empty key in ${sec.title} (${lang})`);
        assert.ok(item.label.trim().length > 0, `empty label in ${sec.title} (${lang})`);
      }
    }

    const titlesJoined = titles.join('\n');
    assert.ok(titlesJoined.includes('Board'), `missing Board section in ${lang}`);
    assert.ok(titlesJoined.includes('Settings'), `missing Settings section in ${lang}`);
    if (lang === 'zh') {
      assert.ok(titlesJoined.includes('待办看板'), 'missing 待办看板 section in zh');
      assert.ok(titlesJoined.includes('设置'), 'missing 设置 section in zh');
    }

    const allKeys = sections.flatMap((s) => s.items.map((i) => i.key));
    for (const k of ['p', 'C', 'o', 'T', 'S', 'D', 'F', 'G', 'm', 'O', 'B', 'P / Space', 'M', '+/-', 'R', 'x']) {
      assert.ok(allKeys.includes(k), `missing feature shortcut ${k} in ${lang}`);
    }
    const keysJoined = allKeys.join('\n');
    for (const token of ['o', 'F', 'G', 'P', 'x']) {
      assert.ok(keysJoined.includes(token), `missing token ${token} in ${lang}`);
    }
  }
});
